/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 真的把 service/main.mjs 起起来（远端全部指向一个没人监听的端口）
 * [OUTPUT]: 每一条路由都能应答，且**降级而不是 500**
 * [POS]: ⭐ 这个文件的存在理由是一次真实事故：某次重构把 `projectForAsset` 弄丢了，
 *        119 条纯逻辑断言**全绿**，而真机上每一条列表路由都回
 *        `500 {"detail":"projectForAsset is not defined"}`。
 *        ⚠ **纯模块测得再密，也证明不了那些模块被正确地接在了一起。**
 *        所以这里不测算法，只回答一件事：它到底能不能跑。
 *
 * ⚠ 顺带覆盖失败模式：Framework 不可达 + Registry 不可达时，
 *   答案必须是 `known:false` 的诚实降级，⛔ 不是 500，也⛔ 不是假装「一切正常、0 个资产」。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0; let count = 0;
const test = (name, cond, detail = '') => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-boot-'));

const freePort = async () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const port = await freePort();
/** ⭐ 一个确定没人监听的端口：远端「不可达」要是确定的，不能靠网络运气。 */
const deadPort = await freePort();

const child = spawn(process.execPath, ['service/main.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    MANAGER_DATA_ROOT: path.join(tmp, 'data'),
    SHARED_ASSET_STORE: path.join(tmp, 'store'),
    TERMUX_OS_FRAMEWORK_URL: `http://127.0.0.1:${deadPort}`,
    PACKAGE_REGISTRY_URL: `http://127.0.0.1:${deadPort}`,
    TERMUX_OS_SYSTEM_KEY: 'boot-test-key',
    STATUS_FILE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });

const base = `http://127.0.0.1:${port}`;
const get = async (p, init) => {
  const res = await fetch(`${base}${p}`, {
    ...init,
    headers: { Authorization: 'Bearer boot-test-key', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const ready = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await get('/health'); if (r.status === 200) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return false;
})();

test('B1 服务能起来并回 /health', ready, stderr.slice(-300));

if (ready) {
  const routes = ['/live', '/assets', '/installed', '/catalog', '/operations',
    '/references', '/unmanaged', '/events'];
  for (const r of routes) {
    const res = await get(r);
    // ⭐ 判据不是「200」，是「不是内部错误」——降级答案（ok:false + 明确原因）是合格的。
    const internal = res.status === 500 || res.data?.error === 'internal';
    test(`B2${r} 不是内部错误`, !internal, `${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);
  }

  const live = await get('/live');
  test('B3 ⭐ 远端全挂时 /live 仍然可用（这一页的价值就在这种时候）', live.data?.ok === true,
    JSON.stringify(live.data).slice(0, 200));
  test('B4 ⚠ 拿不到就说拿不到，⛔ 不假装「一切正常」',
    live.data?.sources?.framework_available === false && live.data?.sources?.registry_available === false,
    JSON.stringify(live.data?.sources ?? null).slice(0, 200));
  /**
   * ⭐ `known` 与 `*_available` 是**两个维度**，不许混：
   *   `known:true`  = 这一层手上有一个当前的答案；
   *   `framework_available:false` = 那个答案的内容是「远端不可用」。
   * 「我有一个新鲜的答案，答案是问不到」是完全自洽的状态。
   * ⚠ 我第一版把这两件事写成了同一个断言，于是测试红了而代码是对的——
   *   与 docs/055 里 `active` vs `owner` 是同一类错误。
   * ⛔ 而消费方必须两个一起读：只看 `counts.assets === 0` 会把「问不到」读成「没有资产」。
   */
  const inv = live.data?.sources?.inventory ?? {};
  test('B5 ⛔ 「问不到」与「没有资产」必须能分开读',
    inv.known === true && live.data?.sources?.framework_available === false
      && live.data?.counts?.assets === 0,
    JSON.stringify({ inv, counts: live.data?.counts }).slice(0, 200));
  test('B6 schema 名与契约文档一致', live.data?.schema === 'termux-os.assets-live.v1');
  test('B7 /live 带 feed 游标', typeof live.data?.event_cursor === 'number');

  const ev = await get('/events?after=0&limit=5');
  test('B8 feed 端点可拉且带游标语义',
    ev.data?.ok === true && Array.isArray(ev.data.events) && typeof ev.data.cursor === 'number'
      && typeof ev.data.truncated === 'boolean');

  // ⭐ fail-closed：连「谁在用」都问不到的时候，删除必须被拒绝。
  const del = await get('/assets/anything/x'.replace('/x', ''), { method: 'DELETE' });
  test('B9 ⭐ 列不出消费方时删除被拒（「问不到」不等于「没人用」）',
    del.data?.ok === false && ['references_unknown', 'asset_in_use'].includes(del.data?.error),
    `${del.status} ${JSON.stringify(del.data).slice(0, 160)}`);

  const unauth = await fetch(`${base}/live`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.status).catch(() => 0);
  test('B10 无凭证被拒（回环端口也不是公开端口）', unauth === 401, String(unauth));
}

child.kill('SIGTERM');
await new Promise((r) => { setTimeout(r, 300); });
child.kill('SIGKILL');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${count - failures}/${count} boot assertions passed`);
process.exit(failures ? 1 : 0);
