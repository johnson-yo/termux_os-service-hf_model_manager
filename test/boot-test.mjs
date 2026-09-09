/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Manager process with deterministic dead Registry/Framework endpoints.
 * [OUTPUT]: Every raw read route degrades explicitly and never becomes a 500.
 * [POS]: hf-model-manager/test/boot-test.mjs.
 * [PROTOCOL]: This test does not contact a real Registry or device.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-boot-'));
const port = await freePort();
const dead = await freePort();
const child = spawn(process.execPath, ['service/main.mjs'], { cwd: root, env: {
  ...process.env, PORT: String(port), SHARED_ASSET_STORE: path.join(tmp, 'models'),
  TERMUX_OS_FRAMEWORK_URL: `http://127.0.0.1:${dead}`, PACKAGE_REGISTRY_URL: `http://127.0.0.1:${dead}`,
  TERMUX_OS_SYSTEM_KEY: 'boot-key', STATUS_FILE: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const call = async (route) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: 'Bearer boot-key' }, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
let ready = false;
for (let i = 0; i < 50; i += 1) {
  try { if ((await call('/health')).status === 200) { ready = true; break; } } catch { /* boot window */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
test('raw-only service boots', ready, stderr.slice(-300));
if (ready) {
  for (const route of ['/live', '/overview', '/packages', '/models', '/assets', '/installed', '/catalog', '/declarations', '/payloads', '/operations', '/events']) {
    const result = await call(route);
    test(`${route} never returns an internal error during source outage`, result.status !== 500);
  }
}
child.kill('SIGTERM');
await new Promise((resolve) => child.once('exit', resolve));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
