/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `logical.mjs` / `modelstate.mjs` / `merge.mjs` 的纯逻辑（真的跑，⛔ 不是读源码）
 * [OUTPUT]: docs/092 §2–§8、§19、§26 的契约回归
 * [POS]: ⭐ 这一层的每条规则都是**派生规则**——它没有一张表可以对照，
 *        所以只有测试能把它从「一堆猜测」变成「写下来的约定」。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logicalIdOf, roleOf, recommendPrebuilt, logicalModels, currentLogicalModels,
  isRetiredLogicalModel, downloadChoices,
  runtimeCompanionRoles, ROLE_SOURCE, ROLE_PREBUILT, ROLE_COMPANION } from '../service/logical.mjs';
import { ModelStateStore, NOT_DOWNLOADED, DOWNLOADED, PREPARING, ENABLED, FAILED,
  KIND_PREBUILT, KIND_LOCAL, preparedBundleComplete } from '../service/modelstate.mjs';
import { updateState, UP_TO_DATE, APPROVED_UPDATE, UPSTREAM_UNAPPROVED,
  NOT_INSTALLED, UNKNOWN } from '../service/merge.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

// ── logical id 派生 ────────────────────────────────────────────────────

test('L1 去掉角色后缀得到 logical id',
  logicalIdOf('model.sensevoice.ctx') === 'model.sensevoice'
  && logicalIdOf('model.sensevoice.graph') === 'model.sensevoice'
  && logicalIdOf('model.sensevoice.frontend') === 'model.sensevoice');

/** ⚠ `model.fireredvad` 只有两段，而它是一个完整的 logical model。 */
test('L2 没有角色后缀的 id 本身就是 logical id',
  logicalIdOf('model.fireredvad') === 'model.fireredvad');

test('L3 audio8 的两个角色归到同一个 model',
  logicalIdOf('model.audio8.decoder') === 'model.audio8'
  && logicalIdOf('model.audio8.encoder_ctx') === 'model.audio8');

test('L4 两级角色后缀一起去掉',
  logicalIdOf('model.qwen3asr.decoder.q4') === 'model.qwen3asr');

test('L5 ⛔ 不认识的后缀不许被当成角色切掉',
  logicalIdOf('model.some.weirdname') === 'model.some.weirdname');

// ── 角色判定 ──────────────────────────────────────────────────────────

/** ⭐ 判据是 **target 有没有绑硬件**，⛔ 不是名字里有没有 `ctx`。 */
test('L6 绑了 htp 的产物就是 prebuilt',
  roleOf({ id: 'model.x.anything', target: { htp: 'v73' } }) === ROLE_PREBUILT);
test('L7 没绑 target 的图是 source',
  roleOf({ id: 'model.sensevoice.graph' }) === ROLE_SOURCE);
test('L8 frontend / decoder 是 companion（必需，但不是那个可执行体）',
  roleOf({ id: 'model.sensevoice.frontend' }) === ROLE_COMPANION
  && roleOf({ id: 'model.audio8.decoder' }) === ROLE_COMPANION);
test('L9 manifest 显式声明赢过派生',
  roleOf({ id: 'model.x.graph', logical: { role: ROLE_PREBUILT } }) === ROLE_PREBUILT);

// ── 推荐（§5–§6）────────────────────────────────────────────────────

const dev = { htp: 'v73', qnn: '2.47' };
test('R1 htp+qnn 都一致 ⇒ 推荐',
  recommendPrebuilt({ htp: 'v73', qnn: '2.47' }, dev).recommended === true);
test('R2 htp 不一致 ⇒ 不推荐',
  recommendPrebuilt({ htp: 'v79', qnn: '2.47' }, dev).recommended === false);
test('R3 qnn 不一致 ⇒ 不推荐',
  recommendPrebuilt({ htp: 'v73', qnn: '2.45' }, dev).recommended === false);
test('R4 本机报不出来 ⇒ 不推荐（⛔ 不是「推荐」也⛔ 不是崩溃）',
  recommendPrebuilt({ htp: 'v73', qnn: '2.47' }, { htp: 'unknown', qnn: null }).recommended === false);
test('R5 target 不声明某一维 = 那一维不要求',
  recommendPrebuilt({ htp: 'v73' }, { htp: 'v73', qnn: null }).recommended === true);
test('R6 不推荐的理由说得出来',
  recommendPrebuilt({ htp: 'v79' }, dev).reasons.join(' ').includes('v79'));

// ── logical model 组装 ────────────────────────────────────────────────

const sensevoiceManifest = {
  id: 'github.termux-os.asset.sensevoice',
  version: '3.1.0',
  assets: {
    provides: [
      { id: 'model.sensevoice.frontend', kind: 'model',
        source: { files: [{ path: 'am.mvn' }, { path: 'tokens.json' }] } },
      { id: 'model.sensevoice.ctx', kind: 'model', optional: true,
        target: { id: 'android-arm64-v73-qnn247', os: 'android', arch: 'arm64', htp: 'v73', qnn: '2.47' },
        source: { files: [{ path: 'model.onnx' }, { path: 'model.bin' }] } },
      { id: 'model.sensevoice.ctx', kind: 'model', optional: true,
        target: { id: 'android-arm64-v79-qnn247', os: 'android', arch: 'arm64', htp: 'v79', qnn: '2.47' },
        source: { files: [{ path: 'model.onnx' }, { path: 'model.bin' }] } },
      { id: 'model.sensevoice.graph', kind: 'model', optional: true,
        source: { files: [{ path: 'model.onnx' }] } },
    ],
  },
};
const vadManifest = {
  id: 'github.termux-os.asset.fireredvad', version: '1.1.0',
  assets: { provides: [{ id: 'model.fireredvad', kind: 'model',
    files: { model: 'model.onnx', cmvn: 'cmvn.bin' },
    source: { files: [{ path: 'model.onnx' }, { path: 'cmvn.bin' }] } }] },
};

const models = logicalModels(
  [{ id: sensevoiceManifest.id, manifest: sensevoiceManifest },
    { id: vadManifest.id, manifest: vadManifest }], dev);
const sv = models.find((m) => m.model_id === 'model.sensevoice');
const vad = models.find((m) => m.model_id === 'model.fireredvad');

test('M1 SenseVoice 的四条声明归成一个 logical model', Boolean(sv) && models.length === 2);
test('M2 一个 source', sv.source?.asset_id === 'model.sensevoice.graph');
test('M3 ⭐ 两个 prebuilt 变体共用同一个 asset id', sv.prebuilt.length === 2
  && new Set(sv.prebuilt.map((p) => p.asset_id)).size === 1);
test('M4 frontend 是 companion，⛔ 不会被当成可执行体',
  sv.companions.length === 1 && sv.companions[0].asset_id === 'model.sensevoice.frontend');
test('M5 版本来自提供包', sv.version === '3.1.0');
test('M6 本机 V73 ⇒ v73 那份推荐、v79 那份不推荐',
  sv.prebuilt.find((p) => p.target.htp === 'v73').recommended === true
  && sv.prebuilt.find((p) => p.target.htp === 'v79').recommended === false);
test('M7 小模型只有 source，⛔ 没有 prebuilt',
  vad.source?.asset_id === 'model.fireredvad' && vad.prebuilt.length === 0);
test('M8 FireRedVAD 的现有 files.cmvn 被视为 runtime companion role',
  vad.source?.runtime_companions?.cmvn === 'cmvn.bin'
    && runtimeCompanionRoles(vadManifest.assets.provides[0]).cmvn === 'cmvn.bin');

const qwenManifest = {
  id: 'github.termux-os.asset.qwen3asr', version: '1.2.0',
  assets: { provides: [
    { id: 'model.qwen3asr.encoder', kind: 'model', source: { files: [{ path: 'enc.onnx' }] } },
    { id: 'model.qwen3asr.decoder.q4', kind: 'model', optional: true,
      source: { files: [{ path: 'q4.gguf' }] } },
  ] },
};
test('M9 退役 Qwen 仍可从历史 manifest 派生，但明确带 retired 标记', (() => {
  const [historical] = logicalModels([{ id: qwenManifest.id, manifest: qwenManifest }], dev);
  return historical?.model_id === 'model.qwen3asr'
    && historical.retired === true
    && isRetiredLogicalModel(historical);
})());
test('M10 current logical model discovery 不再返回退役 Qwen',
  currentLogicalModels([{ id: qwenManifest.id, manifest: qwenManifest }], dev).length === 0);

// ── 下载选项（§9）─────────────────────────────────────────────────────

const svChoices = downloadChoices(sv);
test('C1 有预制时先列预制，再列本地编译',
  svChoices[0].choice === 'prebuilt' && svChoices.at(-1).choice === 'source');
test('C2 ⭐ 不推荐 != 禁用：两个预制变体都列出来',
  svChoices.filter((c) => c.choice === 'prebuilt').length === 2
  && svChoices.some((c) => c.label === '预编译（不推荐）'));
test('C3 推荐那条被标出来',
  svChoices.find((c) => c.recommended)?.label === '预编译（推荐）');
test('C4 小模型只有一条，且它就是推荐的那条',
  downloadChoices(vad).length === 1 && downloadChoices(vad)[0].recommended === true);
test('C5 ⛔ 没有 source 时不许出现「本地编译」这个必然失败的选择',
  downloadChoices({ prebuilt: sv.prebuilt, source: null }).every((c) => c.choice !== 'source'));

// ── 本地状态（§7–§8）────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-state-'));
{
  const st = new ModelStateStore({ dir: tmp });
  test('S1 没记录过 = 未下载', st.read('model.sensevoice').state === NOT_DOWNLOADED);

  st.noteDownloaded('model.sensevoice', { modelVersion: '3.1.0', kind: KIND_PREBUILT,
    assetId: 'model.sensevoice.ctx', path: '/store/ctx' });
  test('S2 下载后 = 已下载，且记下用的哪条 artifact',
    st.read('model.sensevoice').state === DOWNLOADED
    && st.read('model.sensevoice').download.asset_id === 'model.sensevoice.ctx');

  st.notePreparing('model.sensevoice');
  test('S3 准备中', st.read('model.sensevoice').state === PREPARING);

  st.noteEnabled('model.sensevoice', { modelVersion: '3.1.0', kind: KIND_PREBUILT,
    artifactPath: '/store/ctx/model.onnx', derivedFrom: 'model.sensevoice.ctx',
    target: { htp: 'v73', qnn: '2.47' } });
  const en = st.read('model.sensevoice');
  test('S4 已启用，且记下可执行体与它的来源',
    en.state === ENABLED && en.executable.kind === KIND_PREBUILT
    && en.executable.derived_from === 'model.sensevoice.ctx'
    && en.diagnostics.target_htp === 'v73');

  test('S5 ⭐ 重新打开仍然是已启用（跨重启）',
    new ModelStateStore({ dir: tmp }).read('model.sensevoice').state === ENABLED);

  st.noteFailed('model.other', { stage: 'compile', error: '内存不够' });
  const f = st.read('model.other');
  test('S6 失败记下阶段与原因',
    f.state === FAILED && f.diagnostics.last_failure_stage === 'compile');

  test('S7 list 只认自己的 schema', st.list().length === 2);
}
{
  /**
   * ⭐ **被打断的「准备中」必须变成可重试**（§8）。
   * ⚠ 永久卡在准备中是一个使用者点不动、也看不懂的死状态。
   */
  const st = new ModelStateStore({ dir: tmp });
  st.notePreparing('model.sensevoice');
  const again = new ModelStateStore({ dir: tmp });
  const r = again.reconcile({ activeModelIds: [] });
  test('S8 重启后没有作业在跑 ⇒ 恢复成 failed',
    r.recovered.includes('model.sensevoice')
    && again.read('model.sensevoice').state === FAILED
    && again.read('model.sensevoice').diagnostics.last_failure_stage === 'interrupted');

  st.notePreparing('model.sensevoice');
  const r2 = new ModelStateStore({ dir: tmp }).reconcile({ activeModelIds: ['model.sensevoice'] });
  test('S9 ⛔ 作业还在跑时不许把它改掉', r2.recovered.length === 0);
}
{
  /** ⭐ source 删掉之后，logical model 仍然是 enabled（§17）。 */
  const st = new ModelStateStore({ dir: tmp });
  st.noteEnabled('model.local', { modelVersion: '3.1.0', kind: KIND_LOCAL,
    artifactPath: '/caches/sensevoice-3.1.0.ctx.onnx', derivedFrom: 'model.sensevoice.graph' });
  st.noteDownloaded('model.local', { modelVersion: '3.1.0', kind: 'source',
    assetId: 'model.sensevoice.graph', path: '/store/graph' });
  st.noteEnabled('model.local', { modelVersion: '3.1.0', kind: KIND_LOCAL,
    artifactPath: '/caches/sensevoice-3.1.0.ctx.onnx', derivedFrom: 'model.sensevoice.graph' });
  st.noteSourceRemoved('model.local');
  const s = st.read('model.local');
test('S10 ⭐ source 已删，而 logical model 仍然可用',
    s.state === ENABLED && s.executable.kind === KIND_LOCAL
    && typeof s.download.removed_at === 'string');

  const bundle = new ModelStateStore({ dir: tmp });
  bundle.noteEnabled('model.fireredvad', {
    modelVersion: '1.1.0', kind: KIND_LOCAL,
    artifactPath: '/sdcard/termux-os/caches/fireredvad.ctx.onnx',
    derivedFrom: 'model.fireredvad',
    companions: {
      cmvn: { path: '/sdcard/termux-os/models/fireredvad/cmvn.bin', asset_id: 'model.fireredvad',
        ownership: 'shared', shared: true },
    },
  });
  const prepared = bundle.read('model.fireredvad');
  test('S11 prepared state atomically contains executable + cmvn role',
    preparedBundleComplete(prepared, {
      modelVersion: '1.1.0',
      executablePath: '/sdcard/termux-os/caches/fireredvad.ctx.onnx',
      requiredRoles: ['cmvn'],
    })
      && prepared.prepared.companions.cmvn.path.endsWith('/cmvn.bin')
      && prepared.executable.path === prepared.prepared.executable.path
      && !fs.existsSync(path.join(tmp, 'model.fireredvad.json.tmp')));
  test('S12 executable-only prepared state is not complete when cmvn is required',
    !preparedBundleComplete({ ...prepared, prepared: { ...prepared.prepared, companions: {} } }, {
      modelVersion: '1.1.0', requiredRoles: ['cmvn'],
    }));
  test('S13 prepared version mismatch cannot be reused',
    !preparedBundleComplete(prepared, { modelVersion: '2.0.0', requiredRoles: ['cmvn'] }));
}
fs.rmSync(tmp, { recursive: true, force: true });

// ── §26：版本比较修复 ────────────────────────────────────────────────

test('U1 两边 semver：更高的已批准版本 ⇒ 可更新',
  updateState({ localVersion: '3.0.0', registryLatest: '3.1.0' }) === APPROVED_UPDATE);
test('U2 两边 semver 且相同 ⇒ 已是最新',
  updateState({ localVersion: '3.1.0', registryLatest: '3.1.0' }) === UP_TO_DATE);
test('U3 未安装', updateState({ localVersion: null, registryLatest: '3.1.0' }) === NOT_INSTALLED);
/**
 * ⭐ **本轮修的那个 bug**：HF asset 的 registry 版本是 commit SHA，
 * 而本机装的是包版本 —— 两个命名空间，⛔ 无从比较。
 * ⚠ 旧代码把它们送进 `compareSemver`，后者静默落到 `localeCompare`。
 */
test('U4 ⭐ 一边 semver 一边 commit SHA ⇒ unknown（⛔ 不是 up_to_date、⛔ 不是可更新）',
  updateState({ localVersion: '3.1.0',
    registryLatest: '65affbbf41e81e0d5558ea3347469704eb866143' }) === UNKNOWN);
test('U5 两边都是同一个 revision ⇒ 已是最新',
  updateState({ localVersion: 'cc17625bf593618aef353b66d7e09443b9f2de61',
    registryLatest: 'cc17625bf593618aef353b66d7e09443b9f2de61' }) === UP_TO_DATE);
test('U6 两边都是 revision 但不同 ⇒ 目录里批准的是另一份字节',
  updateState({ localVersion: 'aaaaaaaa', registryLatest: 'bbbbbbbb' }) === APPROVED_UPDATE);
test('U7 上游动了但目录没批准 ⇒ 提示而不是动作',
  updateState({ localVersion: '3.1.0', registryLatest: '3.1.0',
    registryRevision: 'abc', upstreamCommit: 'def' }) === UPSTREAM_UNAPPROVED);
test('U8 拿不到目录 ⇒ unknown（⛔ 不许断言「已是最新」）',
  updateState({ localVersion: '3.1.0', registryLatest: null }) === UNKNOWN);

// ── docs/093：显式 logical metadata / legacy / role 映射 ──────────────

/** ⭐ 显式声明**赢过**派生 —— 尤其是 qwen3asr 这种按名字会被猜错的。 */
{
  const qwen = {
    id: 'github.termux-os.asset.qwen3asr', version: '1.2.0',
    assets: { provides: [
      { id: 'model.qwen3asr.encoder', files: { mel: 'qwen3asr_mel.onnx', encoder: 'enc.onnx' },
        logical: { model_id: 'model.qwen3asr', display_name: 'Qwen3-ASR', role: 'source' } },
      { id: 'model.qwen3asr.decoder.q4', optional: true, files: { decoder: 'q4.gguf' },
        logical: { model_id: 'model.qwen3asr', display_name: 'Qwen3-ASR', role: 'companion' } },
    ] },
  };
  const [m] = logicalModels([{ id: qwen.id, manifest: qwen }], dev);
  test('E1 ⭐ GGUF 解码器 ⛔ 不被拆成独立 logical model',
    m.model_id === 'model.qwen3asr' && m.companions.length === 1);
  test('E2 显式 display_name 生效', m.display_name === 'Qwen3-ASR');
  test('E3 ⭐ GGUF ⛔ 不被误判成 prebuilt', m.prebuilt.length === 0);
  test('E3b ⭐ q4 decoder 虽旧 manifest 标 optional，完整 Qwen3-ASR 仍视为必需',
    m.companions[0]?.optional === false
    && m.companions[0]?.required === true
    && m.companions[0]?.declared_optional === true);
  test('E4 role → 文件名映射带出去（消费方读 role，⛔ 不拼文件名）',
    m.source.roles?.encoder === 'enc.onnx' && m.source.roles?.mel === 'qwen3asr_mel.onnx');
  test('E5 ⛔ q8 不从 q4 或 logical id 推导成当前候选',
    !m.companions.some((c) => c.asset_id === 'model.qwen3asr.decoder.q8')
    && !downloadChoices(m).some((c) => c.asset_id === 'model.qwen3asr.decoder.q8'));
}

/** ⭐ legacy 预制不进下载选项，⛔ 但声明仍在（旧安装继续有效）。 */
{
  const cam = {
    id: 'github.termux-os.asset.campplus', version: '1.0.0',
    assets: { provides: [
      { id: 'model.campplus.graph', files: { model: 'campplus.onnx' },
        logical: { model_id: 'model.campplus', display_name: 'CAM++', role: 'source' } },
      { id: 'model.campplus.ctx', optional: true,
        target: { id: 'android-arm64-v73-qnn247', htp: 'v73', qnn: '2.47' },
        files: { graph: 'model_ir11.onnx', context: 'model.bin' },
        logical: { model_id: 'model.campplus', display_name: 'CAM++', role: 'prebuilt', legacy: true } },
    ] },
  };
  const [m] = logicalModels([{ id: cam.id, manifest: cam }], dev);
  test('F1 legacy 预制仍然被列出（声明不删）', m.prebuilt.length === 1 && m.prebuilt[0].legacy === true);
  const ch = downloadChoices(m);
  test('F2 ⭐ 但它 ⛔ 不进下载选项：小模型只走本地编译',
    ch.length === 1 && ch[0].choice === 'source' && ch[0].recommended === true);
}

/** Audio8：补了 encoder source 之后，「预制失败 → 本地编」这条路才走得通。 */
{
  const a8 = {
    id: 'huggingface.termux-os.asset.audio8', version: '1.0.0',
    assets: { provides: [
      { id: 'model.audio8.decoder', files: { metadata: 'metadata.json' },
        logical: { model_id: 'model.audio8', display_name: 'Audio8', role: 'companion' } },
      { id: 'model.audio8.encoder_ctx', optional: true,
        target: { id: 'android-arm64-v73-qnn247', htp: 'v73', qnn: '2.47' },
        files: { graph: 'model_ir11.onnx', context: 'model.bin' },
        logical: { model_id: 'model.audio8', display_name: 'Audio8', role: 'prebuilt' } },
      { id: 'model.audio8.encoder', optional: true, files: { model: 'audio8_enc_w800mask_tanh.onnx' },
        logical: { model_id: 'model.audio8', display_name: 'Audio8', role: 'source' } },
    ] },
  };
  const [m] = logicalModels([{ id: a8.id, manifest: a8 }], dev);
  test('G1 ⭐ Audio8 现在有 source（上一轮的缺口已补）', m.source?.asset_id === 'model.audio8.encoder');
  test('G2 encoder CTX 是 prebuilt、decoder 是 companion',
    m.prebuilt[0]?.asset_id === 'model.audio8.encoder_ctx' && m.companions.length === 1);
  test('G3 两条路都在选项里', downloadChoices(m).map((c) => c.choice).join() === 'prebuilt,source');
}

console.log(`\n${count - failures}/${count} logical-model assertions passed`);
process.exit(failures ? 1 : 0);
