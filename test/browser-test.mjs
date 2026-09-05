/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The candidate WebUI and a loopback Browser Session fixture.
 * [OUTPUT]: Headless Chrome evidence that live polling and manual refresh keep
 *           card/details/file-input DOM identity, progress, and scroll state.
 * [POS]: hf-model-manager/test/browser-test.mjs.
 * [PROTOCOL]: This is a browser acceptance fixture, not a replacement for S25.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const packageId = 'github.termux-os.service.hf-model-manager';
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
const rows = Array.from({ length: 12 }, (_, index) => ({
  path: `fixture/file-${index}.bin`, remote_path: `file-${index}.bin`, size: 1024,
  local: { state: index < 3 ? 'complete' : 'none', path: index < 3 ? `/tmp/file-${index}.bin` : null },
}));
let liveCount = 0;
let manualRefreshCount = 0;

const packageCard = () => ({
  key: 'huggingface:fixture/model', source: 'huggingface', repository: 'fixture/model',
  display_name: 'Browser Fixture', package_id: 'fixture.package', package_version: '1.0.0',
  upstream_revision: 'fixture-revision', status: 'partial', total_bytes: rows.length * 1024,
  downloaded_bytes: 3 * 1024, registry: { raw_bytes: rows.length * 1024 }, files: rows,
  usage: { consumers: [], count: 0 },
  actions: { download: true, continue: true, retry: false, verify: false, delete: false, download_reason: null },
});

const live = () => ({
  ok: true, overview: {
    storage: { model_root: '/tmp/fixture', free_bytes: 1000000000, raw_model_bytes: 3072 },
    registry: { available: true, package_count: 1 }, local: { complete: 0, partial: 1, none: 0 },
    device: { os: 'fixture', device_arch: 'test' },
    refresh: { updated_at_ms: Date.now(), age_ms: 0, refreshing: false, last_error: null },
  },
  summary: { total: 1, complete: 0, partial: 1, none: 0 }, packages: [packageCard()],
  operations: liveCount >= 2 ? { active: 1, operations: [{
    operation_id: 'op_fixture', package_key: 'huggingface:fixture/model', asset_id: 'huggingface:fixture/model',
    action: 'download', state: 'running', stage: 'downloading', progress_precision: 'bytes',
    progress: 50, percent: 50, bytes_done: 6144, bytes_total: 12288, speed_bps: 2048,
    current_provider: 'asset.fixture', current_file: 'fixture/file-4.bin', route: 'direct', retry_count: 0, resumed: true,
  }] } : { active: 0, operations: [] },
});

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://browser.fixture');
  if (url.pathname === `/packages/${packageId}/` || url.pathname === `/packages/${packageId}`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  if (url.pathname.endsWith('/app.js')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(app); }
  if (url.pathname.endsWith('/style.css')) { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(style); }
  if (url.pathname === '/admin/session.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(`window.TermuxOS={api:(route,options={})=>fetch(route,options)};`);
  }
  if (url.pathname === `/api/packages/${packageId}/live`) { liveCount += 1; return json(res, 200, live()); }
  if (url.pathname === `/api/packages/${packageId}/refresh` && req.method === 'POST') {
    manualRefreshCount += 1; liveCount += 1; return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, error: 'not_found' });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
};
const waitFor = async (fn, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('timed out waiting for Chrome DevTools');
};

const chromePort = await freePort();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pagePort = server.address().port;
const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-browser-'));
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--user-data-dir=' + chromeProfile, `--remote-debugging-port=${chromePort}`, 'about:blank',
], { stdio: 'ignore' });
let socket;
let nextId = 1;
const pending = new Map();
try {
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
      const targets = response.ok ? await response.json() : [];
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
    }
    catch { return null; }
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolver = pending.get(message.id);
    if (resolver) { pending.delete(message.id); resolver(message); }
  });
  const command = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command('Page.navigate', { url: `http://127.0.0.1:${pagePort}/packages/${packageId}/` });
  const evaluate = async (expression) => {
    const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) throw new Error('browser evaluation failed');
    return response.result?.result?.value;
  };
  await waitFor(async () => evaluate(`Boolean(document.querySelector('article.package-card[data-key]'))`));
  await evaluate(`window.__card = document.querySelector('article.package-card[data-key]'); window.__fileInput = document.getElementById('archive'); document.querySelectorAll('details').forEach((item) => { item.open = true; }); window.scrollTo(0, 480); true`);
  const before = await evaluate(`({ details: document.querySelectorAll('details').length, open: [...document.querySelectorAll('details')].every((item) => item.open), scroll: window.scrollY })`);
  await sleep(6_500);
  const afterLive = await evaluate(`({ sameCard: window.__card === document.querySelector('article.package-card[data-key]'), sameInput: window.__fileInput === document.getElementById('archive'), open: [...document.querySelectorAll('details')].every((item) => item.open), scroll: window.scrollY, progress: document.querySelector('[data-role="progress-text"]')?.textContent || '' })`);
  await evaluate(`document.getElementById('refresh').click(); true`);
  await sleep(700);
  const afterManual = await evaluate(`({ sameCard: window.__card === document.querySelector('article.package-card[data-key]'), sameInput: window.__fileInput === document.getElementById('archive'), open: [...document.querySelectorAll('details')].every((item) => item.open), scroll: window.scrollY })`);

  const assertions = [
    ['browser fixture opens all details before polling', before.details === 3 && before.open],
    ['live polling patches real progress', afterLive.progress.includes('50%')],
    ['six-second live polling preserves card identity', afterLive.sameCard],
    ['live polling preserves file input identity', afterLive.sameInput],
    ['live polling preserves details and scroll', afterLive.open && afterLive.scroll > 0],
    ['manual refresh preserves card/details/input/scroll', manualRefreshCount > 0 && afterManual.sameCard && afterManual.sameInput && afterManual.open && afterManual.scroll > 0],
  ];
  let failures = 0;
  for (const [name, condition] of assertions) console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`), failures += condition ? 0 : 1;
  console.log(`${assertions.length}/${assertions.length} assertions passed`);
  process.exitCode = failures ? 1 : 0;
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => chrome.once('exit', resolve)),
    sleep(1_000),
  ]);
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
