/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 运行中的 hf-model-manager（经 Framework，凭注入的 System Key）
 * [OUTPUT]: 一个 termux-os.device-verify.v1 结果
 * [POS]: 只断言这个包**自己**负责的事；⛔ 不删任何资产、不下载任何模型。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const BASE = process.env.TERMUX_OS_FRAMEWORK_URL || 'http://127.0.0.1:8980';
const KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';
const PKG = `${BASE}/api/packages/github.termux-os.service.hf-model-manager`;
const checks = [];
const call = async (p, init = {}) => {
  const r = await fetch(PKG + p, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const check = async (id, run) => {
  try { checks.push({ id, result: 'pass', evidence: await run() }); }
  catch (e) { checks.push({ id, result: 'fail', evidence: String(e?.message ?? e) }); }
};
const must = (cond, why) => { if (!cond) throw new Error(why); };

await check('live_reports_three_sources', async () => {
  const { data } = await call('/live');
  must(data.ok, 'live not ok');
  must(data.sources && 'registry_available' in data.sources && 'framework_available' in data.sources,
    'live must state each source availability separately');
  return `assets=${data.counts.assets} installed=${data.counts.installed} updates=${data.counts.updates}`;
});

await check('campplus_source_is_huggingface_not_the_id_prefix', async () => {
  const { data } = await call('/asset?id=model.campplus.ctx');
  must(data.ok, 'detail not ok');
  const a = data.asset;
  must(a.source === 'huggingface', `source is ${a.source}`);
  must(String(a.local.provider_package ?? '').startsWith('github.'),
    'expected the historical github.* provider package id');
  return `source=${a.source} provider=${a.local.provider_package}`;
});

await check('campplus_ctx_target_resolves', async () => {
  const { data } = await call('/asset/resolve?id=model.campplus.ctx', { method: 'POST', body: '{}' });
  must(data.ok, 'resolve failed');
  must(data.compatible === true, `not compatible: ${data.reason}`);
  must(data.selected_target === 'android-arm64-v73-qnn247', `target=${data.selected_target}`);
  return `${data.selected_target} → ${data.local_path}`;
});

await check('wrong_target_is_never_silently_substituted', async () => {
  const { data } = await call('/asset/resolve?id=model.sensevoice.ctx', { method: 'POST', body: '{}' });
  must(data.ok, 'resolve call failed');
  must(data.selected_target === null || /v73/.test(String(data.selected_target)),
    `unexpected target ${data.selected_target}`);
  return `target=${data.selected_target} compatible=${data.compatible}`;
});

await check('speech_declared_reference_is_discovered', async () => {
  const { data } = await call('/asset/references?id=model.campplus.graph');
  must(data.ok, 'references failed');
  const speech = (data.references ?? []).find((r) => /termux-speech/.test(r.consumer_package_id));
  must(speech, 'termux-speech declaration not discovered');
  return `${data.references.length} reference(s), incl ${speech.consumer_package_id} (${speech.reference_type})`;
});

await check('remove_is_refused_while_referenced', async () => {
  const { status, data } = await call('/asset?id=model.campplus.graph', { method: 'DELETE' });
  must(status === 409, `expected 409, got ${status}`);
  must(data.error === 'asset_in_use', `expected asset_in_use, got ${data.error}`);
  must((data.referenced_by ?? []).length > 0, 'refusal must name who is using it');
  return `409 asset_in_use, referenced_by=${data.referenced_by.map((r) => r.consumer_package_id).join(',')}`;
});

await check('unmanaged_is_visible_but_not_adopted', async () => {
  const { data } = await call('/unmanaged');
  must(data.ok, 'unmanaged failed');
  must(data.cleanup_offered === false, 'must not offer cleanup');
  must((data.items ?? []).every((i) => i.managed === false && i.asset_id === undefined),
    'must not guess an asset id for a legacy directory');
  return `${data.items.length} legacy dirs, ${(data.total_bytes / (1 << 30)).toFixed(2)} GB`;
});

/**
 * ⭐ 消费方视角的验收：只靠 capability discovery，不靠「我知道这个包的 URL」。
 * ⚠ 走 Framework 根，不走 PKG——夹具全文不含本包 id，这正是它要证明的事。
 */
await check('both_capabilities_are_discoverable_by_a_stranger', async () => {
  const { runConsumer } = await import('../test/consumer-fixture.mjs');
  const r = await runConsumer({ baseUrl: BASE, token: KEY });
  must(!r.degraded, 'fixture reported the manager as absent');
  const bad = r.steps.filter((x) => !x.ok);
  must(bad.length === 0, `consumer steps failed: ${bad.map((x) => x.name).join('; ')}`);
  return `${r.steps.length} consumer steps, discovery-only`;
});

/**
 * ⭐ `/live` 必须是**快照**。它是 feed 源，一个数秒级的 feed 源会让轮询首尾相接地叠起来。
 * ⚠ 判据取三次里的**最大值**，不是平均——偶尔一次几秒同样会毁掉轮询。
 * 参考：改造前同样的调用间隔实测 2.74 / 5.04 / 3.49 秒。
 */
await check('live_is_a_snapshot_not_a_fanout', async () => {
  const times = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    const { data } = await call('/live');
    times.push(Date.now() - t0);
    must(data.ok, 'live not ok');
    must(data.schema === 'termux-os.assets-live.v1', `schema=${data.schema}`);
    await new Promise((r) => { setTimeout(r, 1500); });
  }
  const worst = Math.max(...times);
  must(worst < 1000, `worst /live took ${worst} ms — a feed source must not block on remotes`);
  return `${times.join('/')} ms (worst ${worst} ms)`;
});

/** feed 端点可拉，且游标语义完整（含「你错过了一段」这件事说不说得出来）。 */
await check('event_feed_is_pollable_with_a_cursor', async () => {
  const { data } = await call('/events?after=0&limit=5');
  must(data.ok, 'events failed');
  must(data.schema === 'termux-os.assets-events.v1', `schema=${data.schema}`);
  must(Array.isArray(data.events), 'events must be an array');
  must(typeof data.cursor === 'number' && typeof data.truncated === 'boolean',
    'cursor and truncated are part of the contract');
  const second = await call(`/events?after=${data.cursor}&limit=5`);
  must((second.data.events ?? []).length === 0, 'a caught-up cursor must not replay events');
  return `cursor=${data.cursor} latest=${data.latest_seq} truncated=${data.truncated}`;
});

/** ⚠ 每一层的新鲜度都要能单独读到——「不知道」与「旧」不是一回事。 */
await check('每层新鲜度可分别读取', async () => {
  const { data } = await call('/live');
  for (const layer of ['inventory', 'catalog', 'declared']) {
    const l = data.sources?.[layer];
    must(l && typeof l.known === 'boolean' && typeof l.stale === 'boolean',
      `${layer} must report known/stale`);
  }
  return Object.entries(data.sources)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => `${k}:${v.known ? `${v.age_ms}ms${v.stale ? '(stale)' : ''}` : 'unknown'}`).join(' ');
});

const failed = checks.filter((c) => c.result === 'fail');
console.log(JSON.stringify({
  schema: 'termux-os.device-verify.v1',
  package: 'github.termux-os.service.hf-model-manager',
  result: failed.length ? 'fail' : 'pass',
  checks,
}, null, 2));
process.exit(failed.length ? 1 : 0);
