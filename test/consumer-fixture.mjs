/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework base URL + token（其它什么都不给）
 * [OUTPUT]: 一个消费方能否**只靠 capability discovery** 完整用上管理器的证明
 * [POS]: ⭐ 这是本包对外契约的**验收夹具**，不是示例代码。
 *
 * 它被刻意写成「营养不良」的样子：全文没有本包的 package id、没有端口、
 * 没有任何 `/api/packages/...` 字面量。⛔ 只要有一处写死，这个夹具就失去意义——
 * 「我直接知道 URL 所以能访问」证明不了 capability 可发现。
 * 契约测试会对本文件做源码级检查（见 test/contract-test.mjs C 段）。
 *
 * ⚠ 未装管理器时必须**干净地降级**，不是抛异常：消费方要能在没有它的机器上活着。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const MANAGER = 'termux-os.assets.manager';
const INVENTORY = 'termux-os.assets.inventory';

const call = async (baseUrl, token, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

/**
 * 一个消费方的完整生命周期：发现 → 问一句 → 订阅 → 断线重连。
 * @returns {{ok:boolean, degraded:boolean, steps:Array<{name:string,ok:boolean,detail:string}>}}
 */
export const runConsumer = async ({ baseUrl, token }) => {
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail: String(detail) }); return ok; };

  // ① 发现。⭐ 唯一的入口是能力目录。
  const list = await call(baseUrl, token, '/api/capabilities');
  const caps = list.data?.capabilities ?? [];
  const ids = caps.map((c) => c.id ?? c.capability ?? c);
  const hasAction = ids.includes(MANAGER);
  const hasFeed = ids.includes(INVENTORY);

  if (!hasAction && !hasFeed) {
    // ⚠ 干净降级：管理器没装不是错误，消费方照旧走 Framework 自己的资产路径。
    step('discovery', true, 'manager not installed — consumer degrades cleanly');
    return { ok: true, degraded: true, steps };
  }
  step('discover action capability', hasAction, MANAGER);
  step('discover feed capability', hasFeed, INVENTORY);

  // ② describe：拿到 kind，并确认 action 不是 feed、feed 不是 action。
  const dAction = await call(baseUrl, token, `/api/capabilities/${MANAGER}`);
  const dFeed = await call(baseUrl, token, `/api/capabilities/${INVENTORY}`);
  step('action describes as kind=action', (dAction.data?.kind ?? dAction.data?.capability?.kind) === 'action',
    JSON.stringify(dAction.data).slice(0, 160));
  const feedInfo = dFeed.data?.capability ?? dFeed.data ?? {};
  const endpoint = feedInfo.endpoint ?? dFeed.data?.endpoint ?? null;
  step('feed describes with a cursor endpoint',
    Boolean(endpoint) && (feedInfo.format ?? dFeed.data?.format) === 'jsonl-cursor',
    `${endpoint} / ${feedInfo.format ?? dFeed.data?.format}`);

  // ③ 用它。⭐ 缺省输入就该给出有用的答案。
  const summary = await call(baseUrl, token, `/api/capabilities/${MANAGER}/invoke`,
    { method: 'POST', body: { input: '' } });
  /**
   * ⚠ Framework 的 invoke 回的是**信封**：`{ok, capability, provider, value}`，
   *   动作自己的返回值在 `value` 里。⛔ 不是 `result`，也不是顶层——
   *   猜错了信封，会看到一个 `ok:true` 的响应而读出 undefined，
   *   于是「调用成功」与「读错字段」在日志里长得一模一样。
   */
  const out = summary.data?.value ?? summary.data?.result ?? summary.data;
  step('invoke with empty input returns a summary',
    Boolean(out?.counts) && typeof out.counts.assets === 'number',
    JSON.stringify(out?.counts ?? out).slice(0, 160));
  step('summary carries freshness, not a bare number',
    Boolean(out?.sources) && typeof out.sources.inventory?.known === 'boolean',
    JSON.stringify(out?.sources?.inventory ?? null).slice(0, 160));

  // ④ 订阅。endpoint 来自 describe，⛔ 不是消费方拼出来的。
  if (endpoint) {
    const page = await call(baseUrl, token, `${endpoint}?after=0&limit=10`);
    const ok = page.data?.ok === true && Array.isArray(page.data.events)
      && typeof page.data.cursor === 'number';
    step('feed endpoint from describe is pollable', ok, `status=${page.status}`);
    // ⑤ 追平之后不该再重复吐同一批事件。
    const again = await call(baseUrl, token, `${endpoint}?after=${page.data?.cursor ?? 0}&limit=10`);
    step('cursor advances (no duplicate replay)', (again.data?.events ?? []).length === 0,
      `events=${(again.data?.events ?? []).length}`);
    // ⑥ ⚠ 一个断线太久的消费方必须**被告知**中间缺了一段。
    step('truncation is reported, not hidden', typeof page.data?.truncated === 'boolean',
      `truncated=${page.data?.truncated}`);
  }

  return { ok: steps.every((s) => s.ok), degraded: false, steps };
};

if (process.argv[1] && process.argv[1].endsWith('consumer-fixture.mjs')) {
  const baseUrl = process.env.FRAMEWORK_URL ?? 'http://127.0.0.1:8980';
  const token = process.env.FRAMEWORK_TOKEN ?? '';
  if (!token) { console.error('FRAMEWORK_TOKEN required'); process.exit(2); }
  const r = await runConsumer({ baseUrl, token });
  for (const s of r.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  console.log(r.degraded ? '\nDEGRADED (manager absent)' : `\n${r.ok ? 'CONSUMER OK' : 'CONSUMER FAILED'}`);
  process.exit(r.ok ? 0 : 1);
}
