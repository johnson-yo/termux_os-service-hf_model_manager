/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: events / hotstate 两个纯模块 + manifest 与 package.mjs 的源码契约
 * [OUTPUT]: feed、热状态解耦、stale 语义、作业历史上限、source 不靠前缀猜 —— 的回归
 * [POS]: ⭐ 这一轮要冻结的是**契约**，而契约只有被钉住才叫冻结。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLog, EVENT_TYPES } from '../service/events.mjs';
import { Layer, Refresher } from '../service/hotstate.mjs';
import { Operations } from '../service/operations.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};
const tick = () => new Promise((r) => { setTimeout(r, 0); });
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'termux-os.package.json'), 'utf8'));
const pkgSource = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');

// ── 1. capability 注册

test('K1 action capability 在 manifest 里声明',
  manifest.capabilities.provides.some((c) => c.id === 'termux-os.assets.manager' && c.kind === 'action'));
test('K2 ⭐ feed capability 在 manifest 里声明',
  manifest.capabilities.provides.some((c) => c.id === 'termux-os.assets.inventory' && c.kind === 'feed'));
test('K3 ⭐ 两个 capability 都真的被 package.mjs `provide` 了（manifest 声明不等于注册）',
  /capabilities\.provide\(\{[\s\S]{0,200}'termux-os\.assets\.manager'/.test(pkgSource)
    && /capabilities\.provide\(\{[\s\S]{0,200}'termux-os\.assets\.inventory'/.test(pkgSource));
test('K4 feed 用官方游标格式，⛔ 不发明第二套订阅协议',
  pkgSource.includes("format: 'jsonl-cursor'"));
test('K5 ⭐ feed endpoint 用 context.packageId 拼，⛔ 不写死包名（dev 实例会带后缀）',
  /endpoint: `\/api\/packages\/\$\{context\.packageId\}\/events`/.test(pkgSource));
test('K6 feed 的端点在 package.mjs 里注册过（否则 Framework 回 unknown_package_route）',
  /'\/events'/.test(pkgSource));
test('K7 版本已 bump（本轮有功能修正）', manifest.version === '0.2.0');

// ── 2. feed 事件

{
  const log = new EventLog({ keep: 5 });
  log.emit('inventory_changed', { reason: 'test' });
  const a = log.since(0);
  test('E1 事件带单调 seq 与游标', a.events.length === 1 && a.cursor === 1 && a.latest_seq === 1);
  for (let i = 0; i < 10; i += 1) log.emit('operation_stage', { n: i });
  test('E2 ⭐ 有界（常驻服务里只增不减的数组就是慢性泄漏）', log.events.length === 5);
  const old = log.since(1);
  test('E3 ⭐ 裁掉的那一段要**说出来**，⛔ 不让断线太久的消费方以为历史是完整的',
    old.truncated === true && old.oldest_seq > 1);
  const fresh = log.since(log.latest_seq ?? log.seq);
  test('E4 追上之后没有新事件', fresh.events.length === 0);
  let threw = null;
  try { log.emit('not_a_real_type', {}); } catch (e) { threw = e; }
  test('E5 ⛔ 未知事件类型被拒（拼错的类型不该悄悄进流里）', threw !== null);
}

// ── 3. 热状态与远端解耦

{
  let calls = 0;
  let now = 1_000_000;
  const layer = new Layer('x', async () => { calls += 1; return { n: calls }; },
    { ttlMs: 1000, staleAfterMs: 3000, now: () => now });
  test('L1 还没读过时 known=false，⛔ 不是「空数据」', layer.known === false && layer.stale === true);
  await layer.update();
  test('L2 第一次刷新之后可读', layer.known === true && layer.value.n === 1 && layer.stale === false);
  await layer.update();
  test('L3 ⭐ TTL 内不重复打远端', calls === 1);
  now += 1500;
  await layer.update();
  test('L4 到期后刷新', calls === 2);
  now += 5000;
  test('L5 ⭐ 太久没更新 ⇒ stale（旧到什么程度必须说出来）', layer.stale === true);
  test('L6 stale 不等于 unknown：值还在', layer.known === true);

  const failing = new Layer('y', async () => { throw new Error('offline'); }, { ttlMs: 10 });
  await failing.update();
  test('L7 第一次就失败 ⇒ known=false 且记下错误',
    failing.known === false && failing.lastError.includes('offline'));
  const flaky = new Layer('z', async () => ({ v: 1 }), { ttlMs: 0 });
  await flaky.update();
  flaky.refresh = async () => { throw new Error('blip'); };
  await flaky.update({ force: true });
  test('L8 ⭐ 刷新失败不清空旧值（一次网络抖动不该让整页变空）',
    flaky.value.v === 1 && flaky.lastError.includes('blip'));

  let inflight = 0;
  let peak = 0;
  const slow = new Layer('s', async () => {
    inflight += 1; peak = Math.max(peak, inflight);
    await new Promise((r) => { setTimeout(r, 5); });
    inflight -= 1; return {};
  }, { ttlMs: 0 });
  await Promise.all([slow.update({ force: true }), slow.update({ force: true }), slow.update({ force: true })]);
  test('L9 ⭐ 同一层同时只有一次刷新在飞', peak === 1);
}

// ── 4. /live 不做远端扇出

test('H1 ⭐ /live 的处理里没有任何 await 远端调用（快照式读取）', (() => {
  const i = mainSource.indexOf("route === '/live'");
  const block = mainSource.slice(i, i + 2200);
  return !/await\s+(local|registry|upstream)\./.test(block)
    && !/await\s+\w+Layer\.update/.test(block);
})());
test('H2 /live 明确交出每一层的新鲜度', mainSource.includes('sources: freshness()'));
test('H3 /live 交出 feed 游标，消费方不必轮询整个列表',
  mainSource.includes('event_cursor: events.seq'));
test('H4 ⭐ 列表不打外网取上游（一个本地问题不该变成网络问题）',
  /upstream: null,\s*\/\/ ⛔ 列表不打外网/.test(mainSource));
test('H5 有显式强制刷新的入口', mainSource.includes("route === '/refresh'"));

// ── 5. 作业历史与精度

{
  const ops = new Operations({ keep: 3 });
  for (let i = 0; i < 6; i += 1) ops.start('verify', `a${i}`, async () => ({}));
  await tick(); await tick();
  test('O9 ⭐ 作业历史有界（常驻服务不许无限增长）', ops.list.length === 3);
  const { operation } = ops.start('verify', 'b', async () => ({}));
  test('O10 ⭐ 显式声明进度精度，consumer 不得把 stage 画成百分比',
    operation.progress_precision === 'stage' && operation.bytes_done === null);
  test('O11 阶段集合是契约的一部分', Array.isArray(operation.stages) && operation.stages.includes('downloading'));
}

// ── 6. source 不靠 package id 前缀

test('S6 ⭐ 全服务没有任何一处按 id 前缀推断 source',
  !/startsWith\(['"]github\./.test(mainSource)
    && !/split\(['"]\.['"]\)\[0\]/.test(mainSource));
test('S7 source 只从 registry 项目取', /source: project\?\.source \?\? null/.test(
  fs.readFileSync(path.join(root, 'service/merge.mjs'), 'utf8')));

// ── 7. remove fail-closed

test('G1 ⭐ 列不出消费方时拒绝删除（「问不到」不等于「没人用」）',
  mainSource.includes("error: 'references_unknown'")
    && /if \(!decl\.available\)[\s\S]{0,260}references_unknown/.test(mainSource));


// ── 8. 消费方夹具：只靠 capability discovery ────────────────────────────────

{
  const fx = fs.readFileSync(path.join(root, 'test/consumer-fixture.mjs'), 'utf8');
  const body = fx.replace(/\/\*\*[\s\S]*?\*\//g, '');   // 去掉注释再查，⛔ 别把说明文字当代码
  test('C1 ⭐ 夹具里没有本包的 package id（写死了就证明不了可发现）',
    !body.includes('hf-model-manager') && !body.includes('github.termux-os.service'));
  test('C2 ⭐ 夹具里没有服务端口，也没有 /api/packages/ 字面量',
    !/127\.0\.0\.1:\d{4,5}\/(?!$)/.test(body.replace('http://127.0.0.1:8980', ''))
      && !body.includes('/api/packages/'));
  test('C3 夹具的 feed 端点来自 describe，不是自己拼的',
    /endpoint\s*=\s*feedInfo\.endpoint/.test(body) && /\$\{endpoint\}\?after=/.test(body));
  test('C4 ⚠ 管理器不在时干净降级，⛔ 不抛异常',
    /degraded: true/.test(body) && /ok: true, degraded: true/.test(body));
  test('C5 夹具验的是游标真的前进（否则「订阅成功」可以是重复吐同一批）',
    body.includes('no duplicate replay'));
}

// ── 9. manifest 与注册层不许各说各话 ────────────────────────────────────────

test('K8 ⭐ manifest 声明的 feed 端点与 package.mjs 注册的路由一致', (() => {
  const declared = manifest.capabilities.provides.find((c) => c.kind === 'feed')?.endpoint ?? '';
  return declared.endsWith('/events') && pkgSource.includes("'/events'");
})());
test('K9 manifest 的 feed 也写明 format（消费方可能只读 manifest）',
  manifest.capabilities.provides.find((c) => c.kind === 'feed')?.format === 'jsonl-cursor');
test('K10 action 的缺省输入有意义（空输入 ⇒ summary，不是 unknown_op）',
  /case 'summary'/.test(pkgSource) && /command\.op \?\? 'summary'/.test(pkgSource));
test('K11 未知 op 的错误里带着可用集合，调用方不必回来读源码',
  /unknown_op/.test(pkgSource) && /supported: \['summary'/.test(pkgSource));

// ── 10. 消费契约文档存在且与代码同步 ────────────────────────────────────────

{
  const doc = fs.readFileSync(path.join(root, 'docs/CONSUMER_API.md'), 'utf8');
  test('D1 契约文档存在并锁定 schema 名',
    doc.includes('termux-os.assets-live.v1') && doc.includes('termux-os.assets-events.v1'));
  test('D2 ⭐ 文档写明的版本 = manifest 的版本（文档漂了就等于没有文档）',
    doc.includes(`Version: **${manifest.version}**`));
  test('D3 ⭐ 已知限制被写出来而不是藏起来（删除旁路）',
    /DELETE \/api\/assets\/<id>\/payload/.test(doc) && doc.includes('已知限制'));
  test('D4 文档列出的每一个事件类型都真的存在于 EVENT_TYPES',
    EVENT_TYPES.every((t) => doc.includes(t)));
  test('D5 ⛔ 文档不许提到 progress 百分比是可用的',
    doc.includes("progress_precision") && doc.includes('画 50% 是错的'));
}


// ── 11. 变化探针：只在事实变了的时候才打远端 ────────────────────────────────

{
  let now = 5_000_000;
  let key = 'a';
  let calls = 0;
  const layer = new Layer('probed', async () => { calls += 1; return { n: calls }; },
    { ttlMs: 30_000, probe: () => key, minIntervalMs: 1000, backstopMs: 300_000, now: () => now });

  await layer.update();
  test('P1 第一次总要取一次', calls === 1);
  now += 60_000;
  await layer.update();
  test('P2 ⭐ 指纹没变 ⇒ 一次远端都不打（哪怕早就超过 TTL）', calls === 1);
  key = 'b';
  await layer.update();
  test('P3 ⭐ 指纹变了 ⇒ 立刻刷，⛔ 不等定时器（比 30 秒轮询更及时）', calls === 2);
  now += 500;
  key = 'c';
  await layer.update();
  test('P4 防抖：最小间隔内不连打', calls === 2);
  now += 2000;
  await layer.update();
  test('P5 过了最小间隔再补上', calls === 3);
  now += 400_000;
  await layer.update();
  test('P6 ⚠ 兜底：指纹之外的变化（有人手工删了文件）靠 backstop 发现', calls === 4);
  test('P7 快照说清楚自己被什么驱动', layer.snapshot().driven_by === 'change-probe');

  const plain = new Layer('plain', async () => ({}), { ttlMs: 1000 });
  test('P8 没给 probe 的层行为不变（仍按 TTL）', plain.snapshot().driven_by === 'ttl');

  /**
   * ⭐ 竞态：取的过程中账本又变了。指纹必须记**取之前**那一个，
   * 否则这次刷新会把「取的过程中发生的那次变化」一起吞掉，而它并没有被读到。
   */
  let slowKey = 'x';
  let ran = 0;
  const racy = new Layer('racy', async () => {
    ran += 1;
    slowKey = 'y';                       // 远端还在取的时候，账本变了
    await new Promise((r) => { setTimeout(r, 5); });
    return { ran };
  }, { ttlMs: 1000, probe: () => slowKey, minIntervalMs: 0 });
  await racy.update();
  await racy.update();
  test('P9 ⭐ 刷新期间发生的变化不被吞掉（下一轮会再取一次）', ran === 2);
}

{
  const src = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  test('P10 inventory 层真的挂上了账本指纹（否则上面那些都只是类的能力）',
    /probe: ledgerFingerprint/.test(src) && /statSync\(LEDGER_FILE\)/.test(src));
  test('P11 ⚠ 探针读的是 Framework 自己那份账本，⛔ 不另造一份',
    /'\.termux-os', 'assets', 'registry\.v1\.json'/.test(src));
}


// ── 12. 降级的读取不许消费指纹（真机事故的回归） ────────────────────────────

{
  let now = 9_000_000;
  let key = 'k1';
  let available = false;
  let calls = 0;
  const layer = new Layer('acc', async () => { calls += 1; return { available, n: calls }; }, {
    ttlMs: 30_000, probe: () => key, minIntervalMs: 0, backstopMs: 300_000,
    accepted: (v) => v?.available === true, now: () => now,
  });

  await layer.update();
  test('A1 第一次读到的是降级值', calls === 1 && layer.value.available === false);
  await layer.update();
  test('A2 ⭐ 失败的读取不消费指纹 ⇒ 下一轮还会再试（⛔ 不能卡到 backstop）', calls === 2);
  test('A3 ⚠ 「有值」与「值可用」是两个字段', layer.snapshot().known === true && layer.snapshot().usable === false);
  available = true;
  await layer.update();
  test('A4 一旦读成功就记下指纹', calls === 3 && layer.snapshot().usable === true);
  now += 60_000;
  await layer.update();
  test('A5 成功之后指纹没变就不再打（省的部分仍然在）', calls === 3);
  key = 'k2';
  await layer.update();
  test('A6 指纹变了照旧立刻刷', calls === 4);
}

test('A7 inventory 层挂了 accepted 判据（否则上面这些只是类的能力）',
  /accepted: \(v\) => v\?\.available === true/.test(fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8')));


// ── 13. 写操作必须走能力面（0.1.2：第一个真实消费方暴露的缺口） ──────────────

{
  const ops = ['install', 'fetch', 'verify', 'remove', 'operation', 'operations', 'events'];
  for (const op of ops) {
    test(`W1 action 支持 ${op}`, new RegExp(`case '${op}'`).test(pkgSource));
  }
  test('W2 ⭐ 未知 op 的 supported 列表包含写操作（否则消费方读了也不知道能做）',
    ops.every((op) => new RegExp(`'${op}'`).test(pkgSource.slice(pkgSource.indexOf('supported:')))));
  test('W3 ⚠ remove 把 HTTP 状态码带出去（409 asset_in_use ≠ 删掉了，而 action 返回值没有状态码这一维）',
    /http_status: r\.status/.test(pkgSource));
  test('W4 长操作给足超时（下载几百 MB）', /timeoutMs: 120_000/.test(pkgSource));
  test('W5 ⛔ 写操作同样要求 asset_id，不许对 undefined 动手',
    (pkgSource.match(/if \(!id\) return \{ ok: false, error: 'asset_id required' \}/g) ?? []).length >= 2);
}


// ── 14. 一个资产视图只有一种形状 ────────────────────────────────────────────

test('V1 ⭐ 三条路都走同一个 enrich（⛔ 不许各补各的字段）', (() => {
  // ⚠ 定义写成 `const enrichAsset = (`（等号后有空格），所以这个正则只数**调用点**。
  const calls = (mainSource.match(/enrichAsset\(/g) ?? []).length;
  return /const enrichAsset = /.test(mainSource) && calls === 3;  // /assets · detail · /live
})());
/**
 * ⚠ 判据是「只出现一次」，⛔ 不是「一次都不出现」——
 * 第一版写成后者，于是它把 `enrichAsset` **自己的定义**当成了违规。
 * 一条禁令必须允许那个唯一的合法实现存在，否则它禁掉的是修好之后的样子。
 */
test('V2 ⛔ 补字段只发生在一个地方（各路由不再各补各的）',
  (mainSource.match(/\.payload_bytes = /g) ?? []).length === 1
    && (mainSource.match(/\.references = references\.referencesFor/g) ?? []).length === 1);

console.log(`\n${count - failures}/${count} contract assertions passed`);
process.exit(failures ? 1 : 0);
