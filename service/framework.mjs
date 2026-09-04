/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework Core's authenticated generic Package/Asset HTTP contract.
 * [OUTPUT]: Raw Asset inventory, Package manifests, declarations, transfer, import, and purge operations.
 * [POS]: hf-model-manager/service/framework.mjs.
 * [PROTOCOL]: The manager delegates bytes, hashes, resume, atomicity, and shared-store ownership to Core.
 */

import path from 'node:path';

export class FrameworkAssets {
  constructor({
    base = process.env.TERMUX_OS_FRAMEWORK_URL || '',
    key = process.env.TERMUX_OS_SYSTEM_KEY || '',
    fetchImpl = fetch,
    timeoutMs = 20_000,
  } = {}) {
    this.base = base.replace(/\/$/, '');
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
  }

  get configured() { return Boolean(this.base && this.key); }

  async call(route, { method = 'GET', body, timeoutMs = this.timeoutMs, headers = {} } = {}) {
    if (!this.configured) throw new Error('Framework connection is not configured');
    const response = await this.fetchImpl(`${this.base}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  async inventory() {
    try {
      const response = await this.call('/api/assets');
      if (!response.ok) throw new Error(response.data?.error || `HTTP ${response.status}`);
      this.lastError = null;
      const assets = response.data.assets ?? [];
      return { available: true, assets: Array.isArray(assets) ? assets : Object.values(assets) };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, assets: [] };
    }
  }

  async packages() {
    try {
      const response = await this.call('/api/packages');
      if (!response.ok) throw new Error(response.data?.error || `HTTP ${response.status}`);
      this.lastError = null;
      return { available: true, packages: response.data.packages ?? [] };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, packages: [] };
    }
  }

  async packageManifests() {
    const listed = await this.packages();
    if (!listed.available) return listed;
    const manifests = [];
    for (const item of listed.packages) {
      try {
        const response = await this.call(`/api/packages/${encodeURIComponent(item.id)}`);
        if (!response.ok || !response.data.package?.manifest) throw new Error(response.data?.error || `HTTP ${response.status}`);
        manifests.push({ id: item.id, version: item.version ?? null, manifest: response.data.package.manifest });
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        return { available: false, error: 'framework_manifest_unavailable', detail: this.lastError, manifests: [] };
      }
    }
    return { available: true, manifests };
  }

  async modelDeclarations() {
    try {
      const response = await this.call('/api/packages/model-declarations');
      if (!response.ok) throw new Error(response.data?.error || `HTTP ${response.status}`);
      return { available: true, ...response.data };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, declarations: [], packages: [] };
    }
  }

  async device() {
    try {
      const response = await this.call('/api/system/device');
      if (!response.ok) throw new Error(response.data?.error || `HTTP ${response.status}`);
      return { available: true, device: response.data.device ?? null };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, device: null };
    }
  }

  async describe(id, { verify = false } = {}) {
    try {
      const response = await this.call(`/api/assets/${encodeURIComponent(id)}${verify ? '?verify=1' : ''}`, {
        timeoutMs: verify ? 180_000 : this.timeoutMs,
      });
      return { available: true, status: response.status, asset: response.data.asset ?? response.data };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, asset: null };
    }
  }

  installProvider(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/provider`, { method: 'POST', body: {}, timeoutMs: 600_000 });
  }

  fetchPayload(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/fetch`, { method: 'POST', body: {}, timeoutMs: 3_600_000 });
  }

  fetchProgress(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/fetch/progress`, { timeoutMs: 10_000 });
  }

  reconcileFetch(id, { staleAfterMs = 120_000 } = {}) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/fetch/reconcile?stale_after_ms=${encodeURIComponent(staleAfterMs)}`, {
      method: 'POST', body: {}, timeoutMs: 20_000,
    });
  }

  purgePayload(id, expected = {}) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/payload?purge=1`, {
      method: 'DELETE', body: { expected }, timeoutMs: 120_000,
    });
  }

  /** Stream an archive to Core; this manager never stages bytes in the shared store. */
  async importArchive(readable, { contentType = 'application/gzip', contentLength = undefined } = {}) {
    if (!this.configured) throw new Error('Framework connection is not configured');
    const headers = {
      Authorization: `Bearer ${this.key}`,
      'Content-Type': contentType,
      ...(contentLength ? { 'Content-Length': String(contentLength) } : {}),
    };
    const response = await this.fetchImpl(`${this.base}/api/assets/import`, {
      method: 'POST', headers, body: readable, duplex: 'half',
      signal: AbortSignal.timeout(3_600_000),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  // Kept as a compatibility-shaped no-op for callers that want to opt into
  // Core's HTTP manifest seam. It never reads or writes a private ledger.
  manifestsFromDisk() { return null; }

  snapshot() {
    return { configured: this.configured, base: this.base, last_error: this.lastError };
  }
}

// ============================================================
// Self-test: node service/framework.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const calls = [];
  const adapter = new FrameworkAssets({
    base: 'http://framework', key: 'key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ assets: [], declarations: [] }) };
    },
  });
  const inventory = await adapter.inventory();
  await adapter.modelDeclarations();
  test('inventory delegates to Core', inventory.available && calls[0].url === 'http://framework/api/assets');
  test('declaration seam is read-only', calls.some((call) => call.url.endsWith('/api/packages/model-declarations')
    && call.options.method === 'GET'));
  test('purge carries explicit expectations', (() => {
    void adapter.purgePayload('asset.raw', { package_id: 'pkg', version: '1.0.0', target: 'generic' });
    const call = calls.at(-1);
    return call.options.method === 'DELETE' && JSON.parse(call.options.body).expected.version === '1.0.0';
  })());
  process.exit(fails ? 1 : 0);
}
