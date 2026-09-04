/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Approved Registry projects, installed Framework Asset inventory, Package manifests, and `.models` declarations.
 * [OUTPUT]: Grouped raw model-package cards and exact local file status.
 * [POS]: hf-model-manager/service/model-packages.mjs.
 * [PROTOCOL]: A card is one Registry source/repository identity; all files stay inside that card.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isSemver } from './cf.mjs';

const sourceOf = (file) => file?.source ?? file?.host ?? 'huggingface';
const repoOf = (file) => file?.repo ?? file?.repository ?? null;

export const packageKey = ({ source, repository } = {}) => `${source ?? 'unknown'}:${repository ?? 'unknown'}`;

export const isModelProject = (project) => Boolean(project?.source && project?.repository && project?.package_id
  && Array.isArray(project.types) && project.types.includes('asset') && project.latest?.raw_files?.length);

const manifestFileRecords = (manifests) => {
  const records = [];
  for (const pkg of manifests ?? []) {
    for (const asset of pkg?.manifest?.assets?.provides ?? []) {
      for (const file of asset?.source?.files ?? []) {
        if (!file?.path || !repoOf(file)) continue;
        records.push({
          source: sourceOf(file), repository: repoOf(file),
          path: file.path, remote_path: file.remote_path ?? null,
          revision: file.revision ?? null, size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
          sha256: typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : null,
          asset_id: asset.id ?? null, asset_package_id: pkg.id ?? null,
          target: asset.target?.id ?? 'generic', role_files: asset.files ?? {},
          asset_path: null,
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
  return { exists: true, complete: true, size: stat.size };
};

const localFileState = (file, providers) => {
  const verifiedFailure = providers.find((provider) =>
    typeof provider.reason === 'string' && /checksum|hash|size_mismatch/.test(provider.reason));
  if (verifiedFailure) return { state: 'error', mismatch: /checksum|hash/.test(verifiedFailure.reason) ? 'hash' : 'size', asset_id: verifiedFailure.id };
  const candidates = [];
  for (const provider of providers) {
    const root = provider?.path;
    if (!root) continue;
    const roleFiles = provider.role_files ?? {};
    const roleCandidate = Object.values(roleFiles).find((value) => value === file.path || path.basename(value) === path.basename(file.path));
    for (const relative of [file.path, roleCandidate]) {
      const candidate = safeCandidate(root, relative);
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  let partPath = null;
  for (const candidate of candidates) {
    const state = fileDigestMatches(file, candidate);
    if (state.complete) return { state: 'complete', path: candidate, bytes: state.size, asset_id: providers.find((p) => safeCandidate(p.path, file.path) === candidate)?.id ?? null };
    if (state.mismatch) return { state: 'error', path: candidate, mismatch: state.mismatch, asset_id: null };
    const part = `${candidate}.part`;
    try {
      const stat = fs.statSync(part);
      if (stat.isFile()) partPath = part;
    } catch { /* no resumable prefix */ }
  }
  return partPath ? { state: 'partial', part_path: partPath } : { state: 'none' };
};

const registryFileKey = (file) => file.sha256
  ? `sha256:${file.sha256}`
  : `path:${file.path ?? file.name ?? ''}|${file.size ?? ''}`;

const mergeFiles = (project, manifestRecords) => {
  const records = [];
  const seen = new Set();
  const add = (file, source = project.source, repository = project.repository) => {
    const normalized = {
      source,
      repository,
      path: file.path ?? file.name ?? null,
      remote_path: file.remote_path ?? null,
      revision: file.revision ?? project.latest?.revision ?? null,
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
      sha256: typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : null,
      asset_ids: file.asset_id ? [file.asset_id] : [],
      asset_package_ids: file.asset_package_id ? [file.asset_package_id] : [],
      targets: file.target ? [file.target] : [],
    };
    if (!normalized.path) return;
    const key = registryFileKey(normalized);
    const existing = records.find((item) => registryFileKey(item) === key);
    if (existing) {
      existing.asset_ids = [...new Set([...existing.asset_ids, ...normalized.asset_ids])];
      existing.asset_package_ids = [...new Set([...existing.asset_package_ids, ...normalized.asset_package_ids])];
      existing.targets = [...new Set([...existing.targets, ...normalized.targets])];
      if (normalized.asset_ids.length) existing.path = normalized.path;
      if (normalized.remote_path) existing.remote_path = normalized.remote_path;
      return;
    }
    seen.add(key);
    records.push(normalized);
  };
  for (const file of project.latest?.raw_files ?? []) add(file);
  for (const file of manifestRecords) add(file, file.source, file.repository);
  // A manifest can carry a file that the Registry list does not yet expose;
  // it remains visible only when its exact declared source coordinate matches.
  return records.filter((file) => file.source === project.source && file.repository === project.repository);
};

const providersFor = (project, records, byId) => {
  const ids = new Set(records.flatMap((record) => record.asset_ids));
  return [...ids].map((id) => {
    const local = byId.get(id);
    const manifest = records.find((record) => record.asset_ids.includes(id));
    return {
      id,
      package_id: local?.package_id ?? local?.package ?? manifest?.asset_package_ids?.[0] ?? null,
      version: local?.version ?? null,
      target: local?.target ?? manifest?.targets?.[0] ?? 'generic',
      path: local?.path ?? null,
      role_files: manifest?.role_files ?? {},
      ready: local?.ready ?? null,
      reason: local?.reason ?? null,
      installed: Boolean(local?.path),
    };
  });
};

const declarationsFor = (project, declarations) => (declarations?.declarations ?? [])
  .filter((item) => item.source === project.source && item.identity === project.repository)
  .map((item) => ({ package_id: item.package_id, active_version: item.active_version, path: item.path }));

const buildCard = (project, { manifestRecords, byId, declarations, registryAvailable, frameworkAvailable = true }) => {
  const records = mergeFiles(project, manifestRecords.filter((file) =>
    file.source === project.source && file.repository === project.repository));
  const providers = providersFor(project, records, byId);
  const files = records.map((file) => ({
    ...file,
    local: localFileState(file, providers),
  }));
  const states = files.map((file) => file.local.state);
  const status = !registryAvailable || !frameworkAvailable ? 'unknown'
    : files.some((file) => file.local.state === 'error') ? 'error'
      : files.length > 0 && files.every((file) => file.local.state === 'complete') ? 'complete'
        : states.some((state) => state === 'complete' || state === 'partial') ? 'partial' : 'none';
  const statusReason = !registryAvailable ? 'registry_unavailable'
    : !frameworkAvailable ? 'framework_unavailable'
    : files.find((file) => file.local.mismatch)?.local.mismatch ?? null;
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
    status_reason: statusReason,
    files,
    assets: providers,
    usage: { consumers: declarationsFor(project, declarations), count: declarationsFor(project, declarations).length },
    actions: {
      download: providers.length > 0,
      continue: providers.length > 0,
      retry: providers.length > 0,
      delete: providers.some((provider) => provider.installed),
      import: true,
    },
  };
};

export function buildModelPackages({ catalog = { available: false, projects: [] }, manifests = [], inventory = { available: false, assets: [] }, declarations = { available: false, declarations: [] } } = {}) {
  const manifestRecords = manifestFileRecords(manifests);
  const byId = inventoryMap(inventory);
  const projects = catalog.projects ?? [];
  const projectKeys = new Set(projects.map(packageKey));
  const cards = projects.filter(isModelProject).map((project) => buildCard(project, {
    manifestRecords, byId, declarations, registryAvailable: catalog.available === true,
    frameworkAvailable: inventory.available === true,
  }));

  // Keep a locally installed raw source visible when the Registry is offline;
  // its identity still comes from the manifest's declared repository, never a
  // Package id prefix. It is explicitly local-only and has no online action.
  const localGroups = new Map();
  for (const record of manifestRecords) {
    const key = packageKey(record);
    if (projectKeys.has(key) || !record.repository) continue;
    if (!localGroups.has(key)) localGroups.set(key, []);
    localGroups.get(key).push(record);
  }
  for (const [key, records] of localGroups) {
    const first = records[0];
    const localProject = {
      source: first.source, repository: first.repository, package_id: null, types: ['asset'],
      latest: { version: first.revision, revision: first.revision, raw_files: records, status: null },
      latest_installable: null, provides: [], display_name: first.repository, description: '', homepage: '',
    };
    const card = buildCard(localProject, { manifestRecords: records, byId, declarations, registryAvailable: false,
      frameworkAvailable: inventory.available === true });
    card.key = key;
    card.local_only = true;
    card.actions = { download: false, continue: false, retry: false, delete: card.assets.some((asset) => asset.installed), import: true };
    cards.push(card);
  }
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

export const __test = { manifestFileRecords, mergeFiles, localFileState, registryFileKey };

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
  const value = buildModelPackages({
    catalog: { available: true, projects: [{ source: 'huggingface', repository: 'owner/repo', package_id: 'pkg.asset', types: ['asset'], display_name: 'Demo', latest: {
      version: 'rev-2', revision: 'rev-2', status: 'verified', raw_files: [{ kind: 'model_file', name: 'raw.onnx', path: 'raw.onnx', size: 3, sha256: null }],
    }, latest_installable: null, provides: [] }] },
    manifests: [{ id: 'pkg.provider', manifest: { assets: { provides: [{ id: 'asset.raw', files: { model: 'raw.onnx' }, source: { files: [{ path: 'raw.onnx', repo: 'owner/repo', revision: 'rev-2', size: 3 }] } }] } } }],
    inventory: { available: true, assets: [{ id: 'asset.raw', path: root, package_id: 'pkg.provider', version: '1.0.0', target: 'generic' }] },
    declarations: { available: true, declarations: [{ source: 'huggingface', identity: 'owner/repo', package_id: 'pkg.consumer', path: '.models/owner/repo' }] },
  });
  test('multifield package groups under source/repository', value.packages[0].key === 'huggingface:owner/repo');
  test('raw file is inside the package card', value.packages[0].files.length === 1 && value.packages[0].files[0].path === 'raw.onnx');
  test('complete local file has an absolute path', value.packages[0].status === 'complete' && path.isAbsolute(value.packages[0].files[0].local.path));
  test('declaration is usage, not a second ledger', value.packages[0].usage.count === 1);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
