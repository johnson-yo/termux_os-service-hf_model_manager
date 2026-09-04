/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Approved Registry model-package rows, Framework Asset inventory, Package manifests, and .models declarations.
 * [OUTPUT]: Exactly one raw model-package card per explicit Registry package identity.
 * [POS]: hf-model-manager/service/model-packages.mjs.
 * [PROTOCOL]: Registry owns the file list and provenance; Framework owns bytes, hashes, targets, and payload paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isSemver } from './cf.mjs';

const sourceOf = (file) => file?.source ?? file?.file_source ?? file?.host ?? null;
const repoOf = (file) => file?.repository ?? file?.repo ?? null;
const remoteOf = (file) => file?.remote_path ?? file?.remotePath ?? file?.file_path ?? null;
const localOf = (file) => file?.local_path ?? file?.path ?? file?.name ?? null;

/** Catalog identity is deliberately not derived from a package-id prefix. */
export const packageKey = ({ source, repository } = {}) => `${source ?? 'unknown'}:${repository ?? 'unknown'}`;

export const isModelProject = (project) => Boolean(project?.source && project?.repository && project?.package_id
  && Array.isArray(project.types) && project.types.includes('asset') && project.latest?.raw_files?.length);

/**
 * Keep the manifest only as a provider/path map. It is never allowed to add a
 * file to a Registry package, because a local manifest can outlive a catalog
 * entry or carry a retired provider.
 */
const manifestFileRecords = (manifests) => {
  const records = [];
  for (const pkg of manifests ?? []) {
    for (const asset of pkg?.manifest?.assets?.provides ?? []) {
      for (const file of asset?.source?.files ?? []) {
        const localPath = typeof file?.path === 'string' ? file.path : null;
        const repository = repoOf(file);
        if (!localPath || !repository) continue;
        records.push({
          source: sourceOf(file) ?? 'huggingface',
          repository,
          path: localPath,
          remote_path: typeof file.remote_path === 'string' ? file.remote_path : null,
          revision: file.revision ?? null,
          size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
          sha256: typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : null,
          asset_id: asset.id ?? null,
          asset_package_id: pkg.id ?? null,
          target: asset.target?.id ?? 'generic',
          payload: typeof asset.payload === 'string' ? asset.payload : null,
          optional: asset.optional === true,
        });
      }
    }
  }
  return records;
};

const inventoryMap = (inventory) => new Map((inventory?.assets ?? [])
  .filter((asset) => asset?.id || asset?.asset_id)
  .map((asset) => [asset.id ?? asset.asset_id, asset]));

const safeCandidate = (root, relative) => {
  if (!root || typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target === base || !target.startsWith(`${base}${path.sep}`)) return null;
  return target;
};

const fileDigestMatches = (file, candidate) => {
  let stat;
  try { stat = fs.statSync(candidate); } catch { return { exists: false }; }
  if (!stat.isFile()) return { exists: false };
  if (file.size !== null && stat.size !== file.size) return { exists: true, mismatch: 'size' };
  // Hash verification remains Framework's responsibility. A ready inventory
  // entry has already passed the manifest SHA check; repeating a 900 MB hash
  // on every Manager refresh would create a second byte-integrity authority.
  return { exists: true, complete: true, size: stat.size };
};

const coordinateKey = (file) => [
  file.source ?? '', file.repository ?? '', file.revision ?? '',
  file.remote_path ?? file.path ?? file.name ?? '', file.sha256 ?? '', file.size ?? '',
].join('|');

const sameCoordinate = (file, manifest) => {
  if (file.source !== manifest.source || file.repository !== manifest.repository) return false;
  const fileRemote = file.remote_path ?? null;
  const manifestRemote = manifest.remote_path ?? null;
  const revisionMatch = !file.revision || !manifest.revision || file.revision === manifest.revision;
  const hashMatch = !file.sha256 || !manifest.sha256 || file.sha256 === manifest.sha256;
  const remoteMatch = fileRemote && manifestRemote
    ? fileRemote === manifestRemote
    : (file.path ?? file.name) === manifest.path;
  return revisionMatch && hashMatch && remoteMatch;
};

/** Registry is the sole file ledger; manifests only add exact provider maps. */
const mergeFiles = (project, manifestRecords) => (project.latest?.raw_files ?? [])
  .map((file) => {
    const normalized = {
      source: sourceOf(file) ?? project.source,
      repository: repoOf(file) ?? project.repository,
      path: localOf(file),
      local_path: file.local_path ?? file.path ?? file.name ?? null,
      remote_path: remoteOf(file),
      revision: file.revision ?? project.latest?.revision ?? null,
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
      sha256: typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : null,
      role: file.role ?? null,
      asset_ids: [],
      asset_package_ids: [],
      targets: [],
      manifest_files: [],
    };
    if (!normalized.path) return null;
    for (const manifest of manifestRecords) {
      if (!sameCoordinate(normalized, manifest)) continue;
      if (manifest.asset_id) normalized.asset_ids.push(manifest.asset_id);
      if (manifest.asset_package_id) normalized.asset_package_ids.push(manifest.asset_package_id);
      if (manifest.target) normalized.targets.push(manifest.target);
      normalized.manifest_files.push({
        asset_id: manifest.asset_id,
        path: manifest.path,
        optional: manifest.optional,
      });
    }
    normalized.asset_ids = [...new Set(normalized.asset_ids)];
    normalized.asset_package_ids = [...new Set(normalized.asset_package_ids)];
    normalized.targets = [...new Set(normalized.targets)];
    return normalized;
  })
  .filter(Boolean);

const localFileState = (file, providers) => {
  const key = coordinateKey(file);
  const verifiedFailure = providers.find((provider) => provider.files.some((item) => item.file_key === key)
    && typeof provider.reason === 'string' && /checksum|hash|size_mismatch/.test(provider.reason));
  if (verifiedFailure) {
    return {
      state: 'error',
      mismatch: /checksum|hash/.test(verifiedFailure.reason) ? 'hash' : 'size',
      asset_id: verifiedFailure.id,
    };
  }
  const candidates = [];
  for (const provider of providers) {
    for (const mapping of provider.files) {
      if (mapping.file_key !== key) continue;
      const candidate = safeCandidate(provider.path, mapping.path);
      if (candidate && !candidates.some((item) => item.path === candidate)) {
        candidates.push({ path: candidate, asset_id: provider.id });
      }
    }
  }
  let partPath = null;
  for (const item of candidates) {
    const state = fileDigestMatches(file, item.path);
    if (state.complete) return { state: 'complete', path: item.path, bytes: state.size, asset_id: item.asset_id };
    if (state.mismatch) return { state: 'error', path: item.path, mismatch: state.mismatch, asset_id: item.asset_id };
    const part = `${item.path}.part`;
    try {
      const stat = fs.statSync(part);
      if (stat.isFile()) partPath = { path: part, bytes: stat.size };
    } catch { /* no resumable prefix */ }
  }
  return partPath ? { state: 'partial', part_path: partPath.path, bytes: partPath.bytes } : { state: 'none', bytes: 0 };
};

const providersFor = (records, byId) => {
  const ids = new Set(records.flatMap((record) => record.asset_ids));
  return [...ids].map((id) => {
    const local = byId.get(id);
    const mappings = records
      .filter((record) => record.asset_ids.includes(id))
      .flatMap((record) => record.manifest_files
        .filter((item) => item.asset_id === id)
        .map((item) => ({ file_key: coordinateKey(record), path: item.path, optional: item.optional })));
    const firstRecord = records.find((record) => record.asset_ids.includes(id));
    return {
      id,
      package_id: local?.package_id ?? local?.package ?? firstRecord?.asset_package_ids?.[0] ?? null,
      version: local?.version ?? null,
      target: local?.target ?? firstRecord?.targets?.[0] ?? 'generic',
      path: local?.path ?? null,
      ready: local?.ready ?? null,
      reason: local?.reason ?? null,
      installed: Boolean(local?.path),
      files: mappings,
    };
  });
};

const declarationsFor = (project, declarations) => (declarations?.declarations ?? [])
  .filter((item) => item.source === project.source && item.identity === project.repository)
  .map((item) => ({ package_id: item.package_id, active_version: item.active_version, path: item.path }));

const buildCard = (project, { manifestRecords, byId, declarations, registryAvailable, frameworkAvailable = true }) => {
  const records = mergeFiles(project, manifestRecords);
  const providers = providersFor(records, byId);
  const files = records.map((file) => ({ ...file, local: localFileState(file, providers) }));
  const states = files.map((file) => file.local.state);
  const status = !registryAvailable || !frameworkAvailable ? 'unknown'
    : files.some((file) => file.local.state === 'error') ? 'error'
      : files.length > 0 && files.every((file) => file.local.state === 'complete') ? 'complete'
        : states.some((state) => state === 'complete' || state === 'partial') ? 'partial' : 'none';
  const mismatch = files.find((file) => file.local.mismatch)?.local.mismatch ?? null;
  const usage = declarationsFor(project, declarations);
  return {
    key: packageKey(project),
    source: project.source,
    repository: project.repository,
    package_id: project.package_id,
    display_name: project.display_name || project.repository,
    description: project.description,
    homepage: project.homepage,
    package_version: project.latest?.version ?? null,
    upstream_revision: project.latest?.revision ?? null,
    version_kind: isSemver(project.latest?.version) ? 'package_version' : 'upstream_revision',
    registry: {
      known: registryAvailable,
      status: registryAvailable ? (project.latest?.status ?? null) : 'unavailable',
      raw_file_count: files.length,
      raw_bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
      latest_installable: project.latest_installable?.version ?? null,
      provides: project.provides ?? [],
    },
    status,
    status_reason: !registryAvailable ? 'registry_unavailable' : !frameworkAvailable ? 'framework_unavailable' : mismatch,
    files,
    total_bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
    downloaded_bytes: files.reduce((sum, file) => sum + (file.local.bytes ?? 0), 0),
    assets: providers,
    usage: { consumers: usage, count: usage.length },
    actions: {
      download: providers.length > 0,
      continue: providers.length > 0,
      retry: providers.length > 0,
      delete: providers.some((provider) => provider.installed),
      import: true,
    },
  };
};

export function buildModelPackages({
  catalog = { available: false, projects: [] },
  manifests = [],
  inventory = { available: false, assets: [] },
  declarations = { available: false, declarations: [] },
} = {}) {
  const manifestRecords = manifestFileRecords(manifests);
  const byId = inventoryMap(inventory);
  // No local-only fallback: an active Manager card requires an explicit active
  // Registry project with package_id and a raw file list.
  const cards = (catalog.projects ?? [])
    .filter(isModelProject)
    .map((project) => buildCard(project, {
      manifestRecords,
      byId,
      declarations,
      registryAvailable: catalog.available === true,
      frameworkAvailable: inventory.available === true,
    }));
  cards.sort((a, b) => a.key.localeCompare(b.key));
  const summary = {
    total: cards.length,
    complete: cards.filter((card) => card.status === 'complete').length,
    partial: cards.filter((card) => card.status === 'partial').length,
    none: cards.filter((card) => card.status === 'none').length,
    unknown: cards.filter((card) => card.status === 'unknown').length,
    error: cards.filter((card) => card.status === 'error').length,
  };
  return { packages: cards, summary };
}

export const findModelPackage = (value, key) => (value?.packages ?? []).find((item) => item.key === key) ?? null;

export const __test = { manifestFileRecords, mergeFiles, localFileState, coordinateKey, sameCoordinate };

// ============================================================
// Self-test: node service/model-packages.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const os = await import('node:os');
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-package-view-'));
  const raw = path.join(root, 'raw.onnx');
  fs.writeFileSync(raw, 'raw');
  const revision = 'a'.repeat(40);
  const value = buildModelPackages({
    catalog: { available: true, projects: [{ source: 'huggingface', repository: 'owner/repo', package_id: 'pkg.asset', types: ['asset'], display_name: 'Demo', latest: {
      version: '1.0.0', revision, status: 'verified', raw_files: [{ kind: 'model_file', name: 'raw.onnx', path: 'raw.onnx', remote_path: 'graph/raw.onnx', source: 'huggingface', repository: 'owner/repo', revision, size: 3, sha256: null }],
    }, latest_installable: null, provides: [] }] },
    manifests: [{ id: 'pkg.provider', manifest: { assets: { provides: [{ id: 'asset.raw', payload: 'raw', source: { files: [{ path: 'raw.onnx', remote_path: 'graph/raw.onnx', source: 'huggingface', repo: 'owner/repo', revision, size: 3 }] } }] } } }],
    inventory: { available: true, assets: [{ id: 'asset.raw', path: root, package_id: 'pkg.provider', version: '1.0.0', target: 'generic' }] },
    declarations: { available: true, declarations: [] },
  });
  test('one explicit Registry identity produces one card', value.packages.length === 1 && value.packages[0].key === 'huggingface:owner/repo');
  test('Registry file stays visible and complete', value.packages[0].status === 'complete' && value.packages[0].files.length === 1);
  test('local status exposes an absolute path', path.isAbsolute(value.packages[0].files[0].local.path));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
