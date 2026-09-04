/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `status.mjs` 的纯逻辑 + `logical.mjs` 的三态推荐 + `web/` 的渲染约定（源码断言）
 * [OUTPUT]: docs/094 §3、§4、§8–§11、§15、§16 的契约回归
 * [POS]: ⭐ **这一轮修的是「状态错了」，不是「样子丑」**——所以状态规则必须能被机械证伪。
 *        真机上那五个模型的形状被逐个钉在这里：改了规则而没改这些断言，就是改坏了。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userStatus, useBlockedReason, modelSummary, missingParts,
  NOT_DOWNLOADED, DOWNLOADED, PARTIAL, PREPARING, ENABLED, FAILED } from '../service/status.mjs';
import { downloadChoices } from '../service/logical.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const appJs = read('web/app.js');
const indexHtml = read('web/index.html');
const mainMjs = read('service/main.mjs');

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const art = (id, installed, extra = {}) => ({ asset_id: id, installed, ...extra });

// ── §3/§4 状态由**两类事实**合成 ─────────────────────────────────────

test('S1 预制在盘上、Manager state 从没记过 → 已下载（⛔ 不是未下载）',
  userStatus({ state: NOT_DOWNLOADED, prebuilt: [art('a.ctx', true)], companions: [] })
    .status === DOWNLOADED);

test('S2 源在盘上、Manager state 从没记过 → 已下载',
  userStatus({ state: NOT_DOWNLOADED, source: art('a.graph', true), prebuilt: [], companions: [] })
    .status === DOWNLOADED);

test('S3 state=enabled 且有可执行体路径 → 已启用',
  userStatus({ state: ENABLED, executable: { path: '/x' }, prebuilt: [art('a.ctx', true)] })
    .status === ENABLED);

/** ⚠ 只有 state 说 enabled 而路径是空的，那是一条**陈旧记录**，⛔ 不是「能用」。 */
test('S4 state=enabled 但可执行体路径为空 → 退回盘上的事实',
  userStatus({ state: ENABLED, executable: null, prebuilt: [art('a.ctx', true)] })
    .status === DOWNLOADED);

test('S5 失败但文件还在 → 启用失败（可以重试）',
  userStatus({ state: FAILED, prebuilt: [art('a.ctx', true)] }).status === FAILED);

/** ⚠ 文件已经没了就不该说「失败」——那个词暗示着「点一下就能重试」。 */
test('S6 失败且文件没了 → 未下载',
  userStatus({ state: FAILED, prebuilt: [art('a.ctx', false)], companions: [] })
    .status === NOT_DOWNLOADED);

test('S7 preparing 压过一切静态事实',
  userStatus({ state: PREPARING, prebuilt: [art('a.ctx', true)] }).status === PREPARING);

test('S8 一个产物都没有 → 未下载',
  userStatus({ state: NOT_DOWNLOADED, prebuilt: [art('a.ctx', false)], companions: [] })
    .status === NOT_DOWNLOADED);

/**
 * ⭐ `partial` 的判据（§4）：**装了一部分，而缺的那些不是「另一条可执行体候选」**。
 * ⚠ 少一条通往同一个可执行体的路 ⇒ 什么都不缺；少一个**伴随** ⇒ 那条路走到一半会断。
 */
test('S9 可执行体在、必需伴随缺 → 部分下载',
  userStatus({ state: NOT_DOWNLOADED, source: art('a.enc', true),
    prebuilt: [], companions: [art('a.dec', false, { optional: false })] }).status === PARTIAL);

test('S10 可执行体在、可选伴随缺 → 仍是部分下载（真机 Qwen3-ASR 就是这个形状）',
  userStatus({ state: NOT_DOWNLOADED, source: art('a.enc', true),
    prebuilt: [], companions: [art('a.dec.q4', false, { optional: true })] }).status === PARTIAL);

test('S11 ⭐ 少的是「另一条可执行体候选」时不算部分下载',
  userStatus({ state: NOT_DOWNLOADED, source: art('a.graph', false),
    prebuilt: [art('a.ctx', true)], companions: [] }).status === DOWNLOADED);

/** ⚠ legacy 预制只为兼容旧安装而留（CAM++ 的 v73 ctx），⛔ 不影响模型状态（§17）。 */
test('S12 legacy 预制既不算可执行体候选、也不算缺件',
  userStatus({ state: NOT_DOWNLOADED, source: art('a.graph', true),
    prebuilt: [art('a.ctx', false, { legacy: true })], companions: [] }).status === DOWNLOADED
  && missingParts({ companions: [art('a.ctx', false, { legacy: true })] }).length === 0);

// ── 真机上那五个模型的形状（改规则必须一起改这里）────────────────────

const DEVICE = {
  Audio8: { state: NOT_DOWNLOADED, prebuilt: [art('model.audio8.encoder_ctx', true)],
    source: art('model.audio8.encoder', false),
    companions: [art('model.audio8.decoder', true, { optional: false })] },
  'CAM++': { state: NOT_DOWNLOADED, source: art('model.campplus.graph', true),
    prebuilt: [art('model.campplus.ctx', true, { legacy: true })], companions: [] },
  FireRedVAD: { state: NOT_DOWNLOADED, source: art('model.fireredvad', true),
    prebuilt: [], companions: [] },
  'Qwen3-ASR': { state: NOT_DOWNLOADED, source: art('model.qwen3asr.encoder', true),
    prebuilt: [], companions: [art('model.qwen3asr.decoder.q4', false,
      { optional: false, declared_optional: true })] },
  SenseVoice: { state: ENABLED, executable: { path: '/x', kind: 'prebuilt' },
    prebuilt: [art('model.sensevoice.ctx', true), art('model.sensevoice.ctx', false)],
    source: art('model.sensevoice.graph', false),
    companions: [art('model.sensevoice.frontend', true, { optional: false })] },
};
const want = { Audio8: DOWNLOADED, 'CAM++': DOWNLOADED, FireRedVAD: DOWNLOADED,
  'Qwen3-ASR': PARTIAL, SenseVoice: ENABLED };
for (const [name, m] of Object.entries(DEVICE)) {
  test(`D-${name} 真机形状 → ${want[name]}`, userStatus(m).status === want[name]);
}

// ── §9 推荐三态 ────────────────────────────────────────────────────────

const label = (verdict) => downloadChoices({
  prebuilt: [{ asset_id: 'a', verdict, recommended: verdict === 'match', legacy: false }],
})[0].label;

test('R1 明确匹配 → 推荐', label('match') === '预编译（推荐）');
test('R2 明确不匹配 → 不推荐', label('mismatch') === '预编译（不推荐）');
/**
 * ⭐ **「不推荐」与「兼容性未知」不能混**（§9）：
 * 读不到本机画像时说「不推荐」，是一个我们并没有依据做出的**否定断言**。
 */
test('R3 读不到本机画像 → 兼容性未知', label('unknown') === '预编译（兼容性未知）');
test('R4 三种都进选项，⛔ 一个都不禁用',
  ['match', 'mismatch', 'unknown'].every((v) => downloadChoices({
    prebuilt: [{ asset_id: 'a', verdict: v, recommended: false, legacy: false }],
  }).length === 1));

test('R5 legacy 预制⛔ 不进下载选项（§17）',
  downloadChoices({ prebuilt: [{ asset_id: 'a', verdict: 'match', legacy: true }],
    source: { asset_id: 's' } }).every((c) => c.choice !== 'prebuilt'));

// ── §10 按钮 ──────────────────────────────────────────────────────────

test('B1 未下载 / 部分下载的主动作是「下载」',
  /st === 'not_downloaded' \|\| st === 'partial'/.test(appJs)
  && appJs.includes("data-go=\"${one ? 'download' : 'choices'}\""));
test('B2 准备中禁用，⛔ 不许重复点',
  appJs.includes("if (st === 'preparing') out.push('<button disabled>准备中…</button>')"));
test('B3 已启用⛔ 不显示普通的「使用」',
  /else if \(st === 'enabled'\) \{ \/\* ⛔ 已启用不给「使用」/.test(appJs));
test('B4 失败时是「重试使用」',
  appJs.includes("${st === 'failed' ? '重试使用' : '使用'}"));
/** ⚠ 一个只会失败的按钮会让人去找 force 开关。 */
test('B5 本机验不了这个模型时，「使用」禁用并说出一句人话',
  appJs.includes('else if (m.use_blocked_reason)')
  && useBlockedReason({ model_id: 'model.audio8' },
    { verifiable: ['sensevoice', 'fireredvad'] }) !== null
  && useBlockedReason({ model_id: 'model.sensevoice' },
    { verifiable: ['sensevoice', 'fireredvad'] }) === null);

// ── §8 下载与下载方式分离 ─────────────────────────────────────────────

test('C1 多个方式时「下载」只展开选择，⛔ 不直接开始',
  appJs.includes("if (go === 'choices')") && appJs.includes('box.hidden = !box.hidden'));
test('C2 只有一个方式时不问，直接下', appJs.includes('const one = (m.choices ?? []).length === 1;'));
test('C3 选择块默认是收起的', appJs.includes('class="choices" id="ch-${esc(m.model_id)}" hidden'));

// ── §16 本地编译提示只说一次、且只在要发生时 ──────────────────────────

test('H1 提示文案只有一处定义', (appJs.match(/期间部分 NPU 功能会暂时不可用/g) ?? []).length === 1);
test('H2 只在「选了本地编译」或「正在准备」时出现，⛔ 不复制到每张卡',
  appJs.includes("${willCompile ? `<p class=\"note tiny compile-hint\" hidden>${COMPILE_HINT}</p>` : ''}")
  && appJs.includes('data-choice-kind')
  && appJs.includes("input.dataset.choiceKind !== 'source'")
  && appJs.includes("st === 'preparing'"));

// ── §5–§7 主卡与首屏 ──────────────────────────────────────────────────

/**
 * ⚠ 断言必须**剥掉注释**再做：这一页的注释里正大光明地写着
 *   「⛔ CTX / QNN / v73 不出现在主卡上」——一条只是在**描述**规则的注释，
 *   会让检查这条规则的断言自己红掉。⭐ 规则的载体是代码，不是说明。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const appCode = stripComments(appJs);
/**
 * 「主卡」= `actions()` 的按钮 + `renderModels` 里那段 `el.innerHTML` 模板。
 * ⛔ 刻意不含 `#device`（它写的是**高级区**里的那一行）、也不含 `detailsBlock`
 *   的「高级信息」——那两处本来就允许出现内部术语。
 * ⚠ 断言必须**剥掉注释**再做：这一页的注释里正大光明地写着
 *   「⛔ CTX / QNN / v73 不出现在主卡上」——一条只是在**描述**规则的注释，
 *   会让检查这条规则的断言自己红掉。⭐ 规则的载体是代码，不是说明。
 */
const between = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const cardBlock = between(appCode, 'const actions = (m)', 'function renderModels')
  + between(appCode, 'el.innerHTML = `\n      <div class="row between">\n        <strong>', 'return el;');

for (const banned of ['sha256', 'QNN', 'v73', 'EPContext', 'ep.context']) {
  test(`P-${banned} ⛔ 不出现在主卡上`, !cardBlock.includes(banned));
}
test('P1 主卡⛔ 不显示绝对路径（路径只在「高级信息」里）',
  !cardBlock.includes('executable?.path'));
test('P2 首屏统计数的是**模型**，⛔ 不是 asset 计数',
  appJs.includes('modelSummaryText(data?.model_summary)')
  && !appJs.includes("$('summary').textContent =\n      `${data.counts.installed}"));
test('P3 asset 计数被降级到高级区', appJs.includes("$('assets-sum').textContent ="));
test('P4 summary 由 logical model 实时算出',
  modelSummary([{ user_status: ENABLED }, { user_status: DOWNLOADED },
    { user_status: PARTIAL }]).enabled === 1);
/** ⚠ 画像读不到只影响推荐判断，⛔ 不该在页顶制造红色异常（§7）。 */
test('P5 本机画像只在高级区，且失败时说明它只影响推荐',
  indexHtml.indexOf('id="device"') > indexHtml.indexOf('id="advanced"')
  && appJs.includes('预编译（兼容性未知）'));

// ── §13/§14/§15 默认收起与按需显示 ────────────────────────────────────

test('A1 高级区（含资产详情、历史目录）默认收起，⛔ 没有 open',
  !/<details[^>]*\sopen/.test(indexHtml));
test('A2 资产详情与历史目录都在「高级」之内',
  indexHtml.indexOf('id="assets"') > indexHtml.indexOf('id="advanced"')
  && indexHtml.indexOf('id="unmanaged"') > indexHtml.indexOf('id="advanced"'));
test('A3 没有操作时整块隐藏，⛔ 不留一张「没有正在进行的操作」的空卡',
  indexHtml.includes('id="ops-card" hidden')
  && appJs.includes('card.hidden = true')
  && !appCode.includes('没有正在进行的操作'));

// ── §11 删除按 logical model 解释 ─────────────────────────────────────

test('X1 确认文案⛔ 不出现内部 asset id',
  appJs.includes('删除 ${m} 后，对应功能会暂时不可用')
  && appJs.includes('重新下载并启用后即可恢复'));
test('X2 删除走 logical 端点', appJs.includes("api(`/model${q}`, { method: 'DELETE' })"));
const logicalDelete = mainMjs.slice(mainMjs.indexOf('const modelDrop'));
test('X3 服务端：先停用并确认 inactive → 再删文件 → 最后归零 state',
  logicalDelete.includes('app.deactivate(')
  && logicalDelete.includes('if (activeAfter)')
  && logicalDelete.indexOf('local.dropLogicalPayload(assetId, id)') < logicalDelete.indexOf('modelState.forget(id)'));
test('X4 package 声明引用只是 warning，⛔ 不再把 logical model 永久硬锁',
  logicalDelete.includes('referencesWarning')
  && !logicalDelete.includes("error: 'model_in_use'")
  && !logicalDelete.includes('if (blocked.length)'));
test('X5 被引用时把「谁在用」说成人话',
  appJs.includes('运行中的功能还没有释放')
  && appJs.includes('删除未完成'));

// ── §11 下载 = 下载「模型」，包含它的伴随 ─────────────────────────────

test('W1 下载顺带补齐缺的伴随（⭐ 使用者下载的是模型，不是一个文件）',
  mainMjs.includes('const plan = downloadPlanFor(model, picked)')
  && mainMjs.includes('for (const asset of plan)')
  && mainMjs.includes('fetchOrRestoreAsset(asset')
  && mainMjs.includes('companion_failures'));

console.log(`\n${count - failures}/${count} user-status assertions passed`);
process.exit(failures ? 1 : 0);
