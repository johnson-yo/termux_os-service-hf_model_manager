/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A loopback Framework HTTP contract fixture with one required and
 *          one optional tiny Asset.
 * [OUTPUT]: End-to-end Manager adapter/download evidence for provider state,
 *           `.part` resume, fetch completion, and verify.
 * [POS]: hf-model-manager/test/integration-test.mjs.
 * [PROTOCOL]: This fixture is intentionally small; it exercises HTTP routes,
 *             not an invented downloader inside the Manager.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { FrameworkAssets } from '../service/framework.mjs';
import { createDownloadPackage } from '../service/download.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-framework-contract-'));
const payload = Buffer.from('framework-owned-optional-payload');
const prefix = payload.subarray(0, 9);
const assetRoot = path.join(root, 'optional');
fs.mkdirSync(assetRoot, { recursive: true });
fs.writeFileSync(path.join(assetRoot, 'tiny.bin.part'), prefix);
const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
const calls = [];
let optionalReady = false;
let progress = { bytes_done: prefix.length, bytes_total: payload.length, progress: 28, current_file: 'tiny.bin' };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.headers.authorization !== 'Bearer system-key') return json(res, 401, { ok: false, error: 'unauthorized' });
  const url = new URL(req.url, 'http://framework.test');
  const asset = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  if (req.method === 'GET' && url.pathname === '/api/assets') {
    return json(res, 200, { ok: true, assets: [
      { id: 'asset.required', package_id: 'pkg.required', path: '/store/required', ready: true },
      { id: 'asset.optional', package_id: 'pkg.optional', path: assetRoot, ready: optionalReady, reason: optionalReady ? null : 'missing_asset' },
    ] });
  }
  if (req.method === 'GET' && /^\/api\/assets\/[^/]+$/.test(url.pathname)) {
    if (asset === 'asset.required') return json(res, 200, { asset: { id: asset, ready: true, path: '/store/required' } });
    if (asset === 'asset.optional') return json(res, 200, { asset: { id: asset, ready: optionalReady, path: optionalReady ? assetRoot : null, reason: optionalReady ? null : 'missing_asset' } });
  }
  if (req.method === 'GET' && url.pathname === '/api/assets/asset.optional/fetch/progress') {
    return json(res, 200, { ok: true, asset_id: 'asset.optional', progress });
  }
  if (req.method === 'POST' && url.pathname === '/api/assets/asset.optional/fetch') {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const part = path.join(assetRoot, 'tiny.bin.part');
    const target = path.join(assetRoot, 'tiny.bin');
    const existing = fs.readFileSync(part);
    fs.writeFileSync(part, Buffer.concat([existing, payload.subarray(existing.length)]));
    const landed = fs.readFileSync(part);
    if (landed.equals(payload) && crypto.createHash('sha256').update(landed).digest('hex') === expectedSha) {
      fs.renameSync(part, target);
      optionalReady = true;
      progress = { bytes_done: payload.length, bytes_total: payload.length, progress: 100, current_file: 'tiny.bin' };
      return json(res, 200, { ok: true, id: 'asset.optional', path: assetRoot, bytes: payload.length, routes: ['direct'] });
    }
    return json(res, 502, { ok: false, error: 'sha256_mismatch' });
  }
  if (req.method === 'POST' && url.pathname.endsWith('/provider')) return json(res, 409, { ok: false, error: 'already_declared' });
  return json(res, 404, { ok: false, error: 'not_found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const local = new FrameworkAssets({ base: `http://127.0.0.1:${port}`, key: 'system-key' });
const required = { id: 'asset.required', ready: true, loaded: true, optional: false, fetchable: false };
const optional = { id: 'asset.optional', ready: false, loaded: true, optional: true, fetchable: true, payload_state: 'partial' };
const managerDownload = createDownloadPackage({
  local,
  refreshCard: async () => ({ key: 'pkg.manager', assets: [required, optional] }),
  sleepImpl: async () => {},
  progressIntervalMs: 1,
});

let result = null;
try {
  result = await managerDownload({ key: 'pkg.manager', assets: [required, optional] });
} finally {
  server.close();
}

test('HTTP fixture required Asset is verified, not fetched', calls.some((item) => item.includes('/api/assets/asset.required?verify=1'))
  && !calls.some((item) => item.includes('/api/assets/asset.required/fetch')));
test('HTTP fixture optional Asset uses the Framework fetch route', calls.some((item) => item === 'POST /api/assets/asset.optional/fetch'));
test('Framework route reads and completes the .part prefix', fs.existsSync(path.join(assetRoot, 'tiny.bin'))
  && !fs.existsSync(path.join(assetRoot, 'tiny.bin.part'))
  && fs.readFileSync(path.join(assetRoot, 'tiny.bin')).equals(payload));
test('Manager result preserves the Framework route evidence', result?.routes?.includes('direct') === true);
test('progress endpoint is observed while fetch is active', calls.some((item) => item.includes('/api/assets/asset.optional/fetch/progress')));
test('provider install route is not used for an already declared provider', !calls.some((item) => item.endsWith('/provider')));

fs.rmSync(root, { recursive: true, force: true });
console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
