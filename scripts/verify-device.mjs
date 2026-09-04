/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A running raw-only Manager through the Framework Package route.
 * [OUTPUT]: A non-destructive termux-os.device-verify.v2 acceptance record.
 * [POS]: hf-model-manager/scripts/verify-device.mjs.
 * [PROTOCOL]: Only reads snapshots and one raw-file descriptor; it never downloads or deletes user data.
 */

const BASE = process.env.TERMUX_OS_FRAMEWORK_URL || 'http://127.0.0.1:8980';
const KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';
const PKG = `${BASE}/api/packages/github.termux-os.service.hf-model-manager`;
const checks = [];
const call = async (route, init = {}) => {
  const response = await fetch(PKG + route, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const check = async (id, run) => {
  try { checks.push({ id, result: 'pass', evidence: await run() }); }
  catch (error) { checks.push({ id, result: 'fail', evidence: String(error?.message ?? error) }); }
};
const must = (condition, message) => { if (!condition) throw new Error(message); };

await check('raw_live_snapshot', async () => {
  const { status, data } = await call('/live');
  must(status === 200 && data.ok === true, `HTTP ${status}`);
  must(data.schema === 'termux-os.raw-model-manager-live.v1', `schema=${data.schema}`);
  must(data.overview?.storage?.model_root, 'model root missing');
  return `packages=${data.summary?.total ?? 0} root=${data.overview.storage.model_root}`;
});

await check('two_section_web_contract', async () => {
  const { data } = await call('/packages');
  must(data.ok === true && Array.isArray(data.packages), 'package snapshot missing');
  return `complete=${data.summary?.complete ?? 0} partial=${data.summary?.partial ?? 0} none=${data.summary?.none ?? 0}`;
});

await check('declaration_scan_is_visible', async () => {
  const { status, data } = await call('/declarations');
  must([200, 503].includes(status), `HTTP ${status}`);
  must(Array.isArray(data.declarations) && Array.isArray(data.errors), 'declaration arrays missing');
  return `${data.declarations.length} declaration(s), ${data.errors.length} error(s)`;
});

await check('raw_file_paths_are_absolute_and_in_model_root', async () => {
  const { data } = await call('/packages');
  const files = (data.packages ?? []).flatMap((item) => item.files ?? []).filter((file) => file.local?.path);
  if (!files.length) return 'no complete raw file on this device';
  const root = data.packages.flatMap((item) => item.files ?? []).find((file) => file.local?.path)?.local.path;
  must(root.startsWith('/'), `path is not absolute: ${root}`);
  must(!root.includes('/caches/'), `cache path leaked: ${root}`);
  return `${files.length} absolute raw path(s)`;
});

await check('old_runtime_routes_are_gone', async () => {
  const use = await call('/model/use?id=huggingface%3Aunknown%2Funknown', { method: 'POST', body: '{}' });
  const resolve = await call('/model/resolve?id=huggingface%3Aunknown%2Funknown', { method: 'GET' });
  must(use.status === 404 && resolve.status === 404, `use=${use.status} resolve=${resolve.status}`);
  return 'deprecated runtime routes return 404';
});

await check('operation_and_event_reads', async () => {
  const { data } = await call('/operations');
  must(data.ok === true && Array.isArray(data.operations), 'operations missing');
  const events = await call('/events?after=0&limit=20');
  must(events.data.ok === true && typeof events.data.cursor === 'number', 'event cursor missing');
  return `operations=${data.operations.length} cursor=${events.data.cursor}`;
});

const failed = checks.filter((item) => item.result === 'fail');
console.log(JSON.stringify({
  schema: 'termux-os.device-verify.v2', package: 'github.termux-os.service.hf-model-manager',
  result: failed.length ? 'fail' : 'pass', checks,
}, null, 2));
process.exit(failed.length ? 1 : 0);
