/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Approved Registry package metadata and Framework Core's raw Asset/Package seams.
 * [OUTPUT]: A loopback service for raw model-package catalog, file transfer, verification, deletion, import, and usage.
 * [POS]: hf-model-manager/service/main.mjs.
 * [PROTOCOL]: This service never prepares or runs a model; Core owns bytes and consumers own execution.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { RegistryAdapter, DEFAULT_REGISTRY } from './cf.mjs';
import { FrameworkAssets } from './framework.mjs';
import { buildModelPackages, findModelPackage } from './model-packages.mjs';
import { Operations, STAGES } from './operations.mjs';
import { EventLog } from './events.mjs';
import { createDownloadPackage, responseFailure as responseError } from './download.mjs';
import { createDeleteCoordinator } from './delete.mjs';
import { resolveTransferFiles } from './transfer-sources.mjs';

const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 2_000;
const PORT = Number(process.env.PORT || process.env.PORT_HTTP || 0);
const STATUS_FILE = process.env.STATUS_FILE || '';
const STORE = process.env.SHARED_ASSET_STORE || '/sdcard/termux-os/models';
const REGISTRY_URL = process.env.PACKAGE_REGISTRY_URL || DEFAULT_REGISTRY;
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';

const registry = new RegistryAdapter({ base: REGISTRY_URL });
const local = new FrameworkAssets();
const operations = new Operations();
const events = new EventLog();
const deleteCoordinator = createDeleteCoordinator({ local });
const v2Unsupported = (value) => [404, 405, 501].includes(Number(value?.status));
let changeSeq = 0;
const bump = () => { changeSeq += 1; };

const opStages = new Map();
operations.onChange = (operation) => {
  bump();
  const previous = opStages.get(operation.operation_id);
  const base = { operation_id: operation.operation_id, package_key: operation.asset_id,
    action: operation.action, state: operation.state, stage: operation.stage };
  if (!previous) events.emit('operation_created', base);
  else if (operation.state === 'complete') events.emit('operation_completed', { ...base, result: operation.result });
  else if (operation.state === 'failed') events.emit('operation_failed', { ...base, error: operation.error });
  else if (previous !== operation.stage) events.emit('operation_stage', base);
  opStages.set(operation.operation_id, operation.stage);
  if (opStages.size > 200) opStages.delete(opStages.keys().next().value);
};

const ledgerFile = () => process.env.ASSET_REGISTRY_FILE
  || process.env.ASSET_PAYLOAD_LEDGER_PATH
  || path.join(os.homedir(), '.termux-os', 'assets', 'payloads.v2.json');
const ledgerFingerprint = () => {
  try { const stat = fs.statSync(ledgerFile()); return `${stat.mtimeMs}:${stat.size}`; }
  catch { return 'absent'; }
};

class SnapshotStore {
  constructor() {
    this.value = null;
    this.inFlight = null;
    this.lastRefreshAtMs = null;
    this.lastError = null;
  }

  async refresh({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    const age = this.lastRefreshAtMs === null ? null : Date.now() - this.lastRefreshAtMs;
    const cacheTtl = this.lastError ? FAILURE_RETRY_MS : CACHE_TTL_MS;
    if (!force && this.value && age !== null && age < cacheTtl) return this.value;
    this.inFlight = (async () => {
      try {
        const [catalog, inventory, declarations, manifests, device] = await Promise.all([
          registry.catalog(),
          local.inventoryV2().then((value) => value.available || !v2Unsupported(value) ? value : local.inventory()),
          local.declarationsV2().then((value) => value.available || !v2Unsupported(value) ? value : local.modelDeclarations()),
          local.packageManifests(), local.device(),
        ]);
        this.value = { catalog, inventory, declarations, manifests, device, refreshed_at_ms: Date.now() };
        this.lastRefreshAtMs = this.value.refreshed_at_ms;
        const failures = [catalog, inventory, declarations, manifests, device].filter((item) => item?.available === false);
        this.lastError = failures.length ? failures.map((item) => item.error ?? 'unavailable').join(',') : null;
        bump();
        if (failures.length) events.emit('source_availability_changed', { sources: failures.map((item) => item.error ?? 'unavailable') });
        else events.emit('inventory_changed', { reason: 'refresh' });
        return this.value;
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        if (!this.value) this.value = {
          catalog: { available: false, projects: [], error: this.lastError },
          inventory: { available: false, assets: [], error: this.lastError },
          declarations: { available: false, declarations: [], packages: [], error: this.lastError },
          manifests: { available: false, manifests: [], error: this.lastError },
          device: { available: false, device: null, error: this.lastError },
          refreshed_at_ms: null,
        };
        return this.value;
      } finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }

  async ensure() {
    if (!this.value) return this.refresh({ force: true });
    const age = this.lastRefreshAtMs === null ? null : Date.now() - this.lastRefreshAtMs;
    if (this.lastError && (age === null || age >= FAILURE_RETRY_MS)) return this.refresh({ force: true });
    return this.value;
  }

  snapshot() {
    const age = this.lastRefreshAtMs === null ? null : Date.now() - this.lastRefreshAtMs;
    return {
      known: this.value !== null,
      refreshing: this.inFlight !== null,
      updated_at_ms: this.lastRefreshAtMs,
      age_ms: age,
      stale: age === null || age > 15 * 60_000,
      last_error: this.lastError,
      ledger_fingerprint: ledgerFingerprint(),
    };
  }
}

const snapshots = new SnapshotStore();
const modelView = (value) => buildModelPackages({
  catalog: value?.catalog,
  manifests: value?.manifests?.manifests ?? [],
  inventory: value?.inventory,
  declarations: value?.declarations,
});

const refreshCard = async (key, { force = true } = {}) => {
  const value = await snapshots.refresh({ force });
  return findModelPackage(modelView(value), key);
};

// The operation is deliberately built from the Framework adapter.  The HTTP
// server below only chooses the package; Core owns provider jobs, bytes,
// resume, hashes, and the final payload path.
const downloadPackage = createDownloadPackage({ local, refreshCard });

const existingPath = (p) => {
  let current = path.resolve(p);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
};

const storageInfo = (cards) => {
  let free = null;
  try {
    const stat = fs.statfsSync(existingPath(STORE));
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch { /* storage is explicitly unknown */ }
  const paths = new Set();
  let used = 0;
  for (const card of cards) for (const file of card.files ?? []) {
    const candidate = file.local?.path;
    if (!candidate || paths.has(candidate)) continue;
    paths.add(candidate);
    try { used += fs.statSync(candidate).size; } catch { /* disappeared between reads */ }
  }
  return { model_root: STORE, free_bytes: free, raw_model_bytes: used };
};

const overviewOf = (value, view) => {
  const statuses = view.summary ?? {};
  const device = value?.device?.device ?? {};
  return {
    schema: 'termux-os.hf-model-manager-overview.v1',
    device: {
      platform: process.platform,
      arch: process.arch,
      os: device.os ?? null,
      device_arch: device.arch ?? null,
    },
    storage: storageInfo(view.packages ?? []),
    registry: {
      available: value?.catalog?.available === true,
      package_count: view.packages.length,
      error: value?.catalog?.error ?? null,
    },
    local: {
      available: value?.inventory?.available === true,
      complete: statuses.complete ?? 0,
      partial: statuses.partial ?? 0,
      none: statuses.none ?? 0,
      unknown: statuses.unknown ?? 0,
      error: statuses.error ?? 0,
    },
    refresh: snapshots.snapshot(),
  };
};

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  req.on('error', () => resolve(null));
});

const authorized = (req) => !SYSTEM_KEY || req.headers.authorization === `Bearer ${SYSTEM_KEY}`;

const requireCard = (view, id) => findModelPackage(view, id);

const verifyPackage = async (card) => {
  const results = [];
  for (const asset of card.assets ?? []) {
    const result = typeof local.resolutionV2 === 'function'
      ? await local.resolutionV2(asset.id, { verify: true })
      : await local.describe(asset.id, { verify: true });
    const resolved = result.data?.resolution ?? result.asset;
    results.push({ id: asset.id, ok: resolved?.ready === true, reason: resolved?.reason ?? null });
  }
  await snapshots.refresh({ force: true });
  return { package_key: card.key, assets: results, ok: results.length > 0 && results.every((item) => item.ok) };
};

const operationReply = (res, result) => send(res, 202, { ok: true, operation: result.operation, deduplicated: result.deduplicated });

const deleteFailureReply = (res, error) => {
  const status = error?.code === 'confirmation_required' || error?.code === 'confirmation_invalid'
    || error?.code === 'confirmation_package_mismatch' || error?.code === 'confirmation_payload_mismatch'
    || error?.code === 'generation_mismatch' || error?.code === 'selection_detach_required' ? 409
    : error?.code === 'payload_not_found' ? 404
      : error?.code === 'payload_ledger_corrupt' ? 500 : 400;
  return send(res, status, { ok: false, error: error?.code ?? 'delete_failed', detail: String(error?.message ?? error) });
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://manager.local');
  const route = parsed.pathname.replace(/\/+$/, '') || '/';
  if (route === '/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'hf-model-manager', mode: 'raw-only', change_seq: changeSeq });
  }
  if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
  try {
    if (route === '/refresh' && req.method === 'POST') {
      const body = await readJson(req);
      const value = await snapshots.refresh({ force: body?.force !== false });
      const view = modelView(value);
      return send(res, 200, { ok: true, packages: view.packages, summary: view.summary, refresh: snapshots.snapshot() });
    }

    // Payload inventory and orphan deletion deliberately do not depend on the
    // remote catalog snapshot. A replacement Manager must be able to take
    // over, inspect, verify, and remove existing Core Payload facts even when
    // its previous Manager or the catalog is unavailable.
    if (route === '/payloads' && req.method === 'GET') {
      const payloads = await local.payloadsV2();
      const status = payloads.available ? 200 : payloads.error === 'payload_ledger_corrupt' ? 500 : 503;
      return send(res, status, {
        ok: payloads.available === true,
        schema: payloads.schema ?? 'termux-os.asset-payload-ledger.v2',
        generation: payloads.generation ?? null,
        payloads: payloads.payloads ?? [],
        selections: payloads.selections ?? [],
        error: payloads.error ?? null,
        detail: payloads.detail ?? null,
      });
    }
    const directPayloadId = parsed.searchParams.get('id');
    if (route === '/payload/delete-plan' && req.method === 'POST') {
      try {
        const plan = await deleteCoordinator.inspectPayload(directPayloadId);
        return send(res, 200, { ok: true, plan });
      } catch (error) { return deleteFailureReply(res, error); }
    }
    if (route === '/payload/delete' && (req.method === 'DELETE' || req.method === 'POST')) {
      const body = await readJson(req);
      let confirmation;
      try {
        if (!body?.confirmation_token) {
          const plan = await deleteCoordinator.inspectPayload(directPayloadId);
          return send(res, 409, { ok: false, error: 'confirmation_required', plan });
        }
        confirmation = deleteCoordinator.takePayload(directPayloadId, body.confirmation_token);
      } catch (error) { return deleteFailureReply(res, error); }
      const payloadId = String(directPayloadId ?? '').trim();
      const started = operations.start('delete-payload', `payload:${payloadId}`, async ({ setStage }) => {
        const result = await deleteCoordinator.removePayload(setStage, confirmation);
        await snapshots.refresh({ force: true });
        return result;
      }, { stages: STAGES, progressPrecision: 'stage' });
      return operationReply(res, started);
    }

    const value = await snapshots.ensure();
    const view = modelView(value);

    if (route === '/overview' && req.method === 'GET') return send(res, 200, { ok: true, overview: overviewOf(value, view) });
    if ((route === '/packages' || route === '/models') && req.method === 'GET') {
      return send(res, 200, { ok: true, schema: 'termux-os.raw-model-packages.v1', packages: view.packages,
        summary: view.summary, refresh: snapshots.snapshot() });
    }
    if (route === '/catalog' && req.method === 'GET') {
      return send(res, value.catalog?.available ? 200 : 503, { ok: value.catalog?.available === true,
        registry: { available: value.catalog?.available === true, base: REGISTRY_URL, error: value.catalog?.error ?? null },
        packages: view.packages });
    }
    if (route === '/resolve-transfer' && req.method === 'POST') {
      const body = await readJson(req);
      const requested = Array.isArray(body?.files) ? body.files : [];
      if (!requested.length) return send(res, 400, { ok: false, error: 'transfer_files_required' });
      const files = resolveTransferFiles(requested);
      if (files.length !== requested.length) {
        const resolved = new Set(files.map((file) => `${file.path}|${file.size}|${file.sha256}`));
        const unresolved = requested.filter((file) => !resolved.has(`${file.path}|${file.size}|${String(file.sha256 ?? '').toLowerCase()}`))
          .map((file) => file.path ?? file.remote_path ?? null).filter(Boolean);
        return send(res, 400, { ok: false, error: 'source_coordinate_unresolved', unresolved });
      }
      return send(res, 200, { ok: true, schema: 'termux-os.asset-transfer-spec.v2', files });
    }
    if (route === '/installed' && req.method === 'GET') {
      return send(res, value.inventory?.available ? 200 : 503, { ok: value.inventory?.available === true,
        assets: value.inventory?.assets ?? [], error: value.inventory?.error ?? null });
    }
    if (route === '/declarations' && req.method === 'GET') {
      return send(res, value.declarations?.available ? 200 : 503, { ok: value.declarations?.available === true,
        schema: value.declarations?.schema ?? 'termux-os.model-declarations.v1',
        declarations: value.declarations?.declarations ?? [], packages: value.declarations?.packages ?? [],
        errors: value.declarations?.errors ?? [], error: value.declarations?.error ?? null });
    }
    if (route === '/live' && req.method === 'GET') {
      if (!snapshots.inFlight) void snapshots.refresh();
      return send(res, 200, { ok: true, schema: 'termux-os.raw-model-manager-live.v1', change_seq: changeSeq,
        overview: overviewOf(value, view), packages: view.packages, summary: view.summary,
        operations: operations.snapshot(20), events: { latest_seq: events.seq }, sources: snapshots.snapshot() });
    }
    if (route === '/events' && req.method === 'GET') {
      const after = Number(parsed.searchParams.get('after') ?? 0) || 0;
      const limit = Math.max(1, Math.min(200, Number(parsed.searchParams.get('limit') ?? 100) || 100));
      return send(res, 200, { ok: true, ...events.since(after, limit) });
    }
    if (route === '/operations' && req.method === 'GET') return send(res, 200, { ok: true, ...operations.snapshot(50) });
    const operationMatch = route.match(/^\/operations\/([^/]+)$/);
    if (operationMatch && req.method === 'GET') {
      const operation = operations.get(decodeURIComponent(operationMatch[1]));
      return operation ? send(res, 200, { ok: true, operation }) : send(res, 404, { ok: false, error: 'unknown_operation' });
    }

    const packageId = parsed.searchParams.get('id');
    if ((route === '/package' || route === '/model') && req.method === 'GET') {
      const card = packageId ? requireCard(view, packageId) : null;
      return card ? send(res, 200, { ok: true, package: card }) : send(res, 404, { ok: false, error: 'unknown_package' });
    }
    if (route === '/file' && req.method === 'GET') {
      const card = packageId ? requireCard(view, packageId) : null;
      const filePath = parsed.searchParams.get('path');
      const file = card?.files?.find((item) => item.path === filePath || item.remote_path === filePath);
      if (!file) return send(res, 404, { ok: false, error: 'unknown_raw_file' });
      return send(res, 200, { ok: true, package_key: card.key, source: card.source, repository: card.repository,
        file: { path: file.path, local_path: file.local_path, remote_path: file.remote_path,
          source: file.source, repository: file.repository, revision: file.revision, role: file.role,
          size: file.size, sha256: file.sha256,
          local: file.local } });
    }
    if (route === '/assets' && req.method === 'GET') {
      const files = view.packages.flatMap((card) => card.files.map((file) => ({ package_key: card.key, ...file })));
      return send(res, 200, { ok: true, schema: 'termux-os.raw-asset-files.v1', files });
    }

    const actionRoute = route === '/package/download' || route === '/model/download'
      || route === '/package/update' || route === '/model/update';
    if (actionRoute && req.method === 'POST') {
      const card = packageId ? requireCard(view, packageId) : null;
      if (!card) return send(res, 404, { ok: false, error: 'unknown_package' });
      const update = route.endsWith('/update');
      const started = operations.start(update ? 'update' : 'download', card.key,
        ({ setStage, setProgress }) => downloadPackage(card, setStage, setProgress, { update }), {
        stages: STAGES, progressPrecision: 'bytes',
      });
      return operationReply(res, started);
    }
    if ((route === '/package/verify' || route === '/model/verify') && req.method === 'POST') {
      const card = packageId ? requireCard(view, packageId) : null;
      if (!card) return send(res, 404, { ok: false, error: 'unknown_package' });
      const started = operations.start('verify', card.key, ({ setStage }) => {
        setStage('verifying');
        return verifyPackage(card);
      }, { stages: STAGES, progressPrecision: 'stage' });
      return operationReply(res, started);
    }
    if ((route === '/package/import' || route === '/model/import') && req.method === 'POST') {
      const stream = new PassThrough();
      req.pipe(stream);
      const started = operations.start('import', `archive:${Date.now()}`, async ({ setStage }) => {
        setStage('importing');
        const imported = await (typeof local.importArchiveV2 === 'function' ? local.importArchiveV2(stream, {
          contentType: req.headers['content-type'] || 'application/gzip',
          contentLength: req.headers['content-length'],
        }) : local.importArchive(stream, {
          contentType: req.headers['content-type'] || 'application/gzip',
          contentLength: req.headers['content-length'],
        }));
        const failure = responseError(imported, 'raw archive import failed');
        if (failure) throw failure;
        await snapshots.refresh({ force: true });
        return imported.data;
      }, { stages: STAGES, progressPrecision: 'stage' });
      return operationReply(res, started);
    }
    if ((route === '/package/delete-plan' || route === '/model/delete-plan') && req.method === 'POST') {
      const card = packageId ? requireCard(view, packageId) : null;
      if (!card) return send(res, 404, { ok: false, error: 'unknown_package' });
      try {
        const plan = await deleteCoordinator.inspect(card);
        return send(res, 200, { ok: true, plan });
      } catch (error) { return deleteFailureReply(res, error); }
    }
    if ((route === '/package/delete' || route === '/model/delete')
      && (req.method === 'DELETE' || req.method === 'POST')) {
      const card = packageId ? requireCard(view, packageId) : null;
      if (!card) return send(res, 404, { ok: false, error: 'unknown_package' });
      const body = await readJson(req);
      let confirmation;
      try {
        if (!body?.confirmation_token) {
          const plan = await deleteCoordinator.inspect(card);
          return send(res, 409, { ok: false, error: 'confirmation_required', plan });
        }
        confirmation = deleteCoordinator.take(card.key, body.confirmation_token);
      } catch (error) { return deleteFailureReply(res, error); }
      const started = operations.start('delete', card.key, async ({ setStage }) => {
        const result = await deleteCoordinator.remove(card, setStage, confirmation);
        await snapshots.refresh({ force: true });
        return result;
      }, {
        stages: STAGES, progressPrecision: 'stage',
      });
      return operationReply(res, started);
    }
    return send(res, 404, { ok: false, error: 'not_found', route });
  } catch (error) {
    return send(res, 500, { ok: false, error: 'internal', detail: String(error?.message ?? error) });
  }
});

void snapshots.refresh({ force: true }).catch(() => {});

server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address().port;
  if (STATUS_FILE) {
    try {
      fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
      fs.writeFileSync(STATUS_FILE, JSON.stringify({
        schema: 'termux-os.service-status.v1', service: 'hf-model-manager', mode: 'raw-only',
        state: 'ready', port: bound, started_at: new Date().toISOString(),
      }, null, 2));
    } catch { /* status reporting must not stop the service */ }
  }
  console.log(`[hf-model-manager] listening on 127.0.0.1:${bound}`);
  console.log(`[hf-model-manager] registry=${REGISTRY_URL} store=${STORE}`);
});
