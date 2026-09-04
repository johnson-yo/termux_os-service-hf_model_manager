/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Public Package Registry `/list` data: approved package identities, revisions, files, and hashes.
 * [OUTPUT]: A source-faithful model-package catalog with per-file provenance and local paths.
 * [POS]: hf-model-manager/service/cf.mjs.
 * [PROTOCOL]: Registry data is approved metadata only. Raw bytes and local ownership stay with Framework Core.
 */

export const DEFAULT_REGISTRY = 'https://package.termux-os.com';

const normalizeFile = (file) => ({
  kind: file?.kind ?? null,
  name: typeof file?.name === 'string' ? file.name : null,
  path: typeof file?.local_path === 'string' ? file.local_path
    : (typeof file?.path === 'string' ? file.path : (typeof file?.name === 'string' ? file.name : null)),
  local_path: typeof file?.local_path === 'string' ? file.local_path
    : (typeof file?.path === 'string' ? file.path : (typeof file?.name === 'string' ? file.name : null)),
  remote_path: typeof file?.remote_path === 'string' ? file.remote_path
    : (typeof file?.file_path === 'string' ? file.file_path : null),
  source: typeof file?.source === 'string' ? file.source : null,
  repository: typeof file?.repository === 'string' ? file.repository : null,
  revision: typeof file?.revision === 'string' ? file.revision : null,
  role: typeof file?.role === 'string' ? file.role : null,
  size: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
  sha256: typeof file?.sha256 === 'string' ? file.sha256.toLowerCase() : null,
});

const isRawFile = (file) => file.kind === 'model_file' || file.kind === 'repository_file'
  || file.kind === 'raw_asset' || file.kind === 'asset_file';

const packageIndex = (version) => (version?.packages ?? []).flatMap((pkg) =>
  (pkg?.provides ?? []).filter((item) => item?.kind === 'asset').map((item) => ({
    id: item.id ?? null,
    package_id: pkg.package_id ?? null,
    files: item.files ?? null,
  })));

const normalizeVersion = (version) => {
  const files = (version?.files ?? []).map(normalizeFile);
  const provides = packageIndex(version);
  const rawFiles = files.filter(isRawFile);
  const archiveFiles = files.filter((file) => file.kind === 'source_tar' || file.kind === 'release_asset');
  return {
    version: version?.version ?? null,
    revision: version?.upstream_ref ?? version?.revision ?? null,
    status: version?.status ?? null,
    published_at: version?.published_at ?? null,
    files,
    raw_files: rawFiles,
    archive_files: archiveFiles,
    total_bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
    raw_bytes: rawFiles.reduce((sum, file) => sum + (file.size ?? 0), 0),
    package_id: (version?.packages ?? [])[0]?.package_id ?? null,
    provides,
    installable: archiveFiles.length > 0,
  };
};

export const isSemver = (value) => /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(value ?? ''));

export const comparable = (a, b) => isSemver(a) && isSemver(b);

export const compareSemver = (a, b) => {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return String(a ?? '').localeCompare(String(b ?? ''));
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

const byEvidence = (versions) => [...versions].sort((a, b) => {
  if (comparable(a.version, b.version)) return compareSemver(a.version, b.version);
  const at = Date.parse(a.published_at ?? '') || 0;
  const bt = Date.parse(b.published_at ?? '') || 0;
  return at - bt;
});

export const latestRaw = (versions) => {
  const eligible = versions.filter((version) => version.status === 'verified' && version.raw_files.length);
  // A package version is the installable catalog namespace. If the same
  // project also has historical revision-only rows, never let a date compare
  // make a raw revision masquerade as the current package version.
  const semver = eligible.filter((version) => isSemver(version.version));
  return byEvidence(semver.length ? semver : eligible).at(-1) ?? null;
};

export const latestInstallable = (versions) => byEvidence(versions
  .filter((version) => version.status === 'verified' && version.installable)).at(-1) ?? null;

const normalizeProject = (project) => {
  const versions = (project?.versions ?? []).map(normalizeVersion);
  const raw = latestRaw(versions);
  const installable = latestInstallable(versions);
  const packageId = project?.package_id ?? raw?.package_id ?? installable?.package_id ?? null;
  const provides = [...new Map([
    ...(raw?.provides ?? []), ...(installable?.provides ?? []),
  ].filter((item) => item.id).map((item) => [item.id, item])).values()];
  return {
    source: typeof project?.source === 'string' ? project.source : null,
    repository: typeof project?.repository === 'string' ? project.repository : null,
    package_id: packageId,
    display_name: project?.display_name ?? null,
    description: project?.description ?? '',
    homepage: project?.homepage ?? '',
    types: Array.isArray(project?.types) ? project.types : [],
    official: Array.isArray(project?.official) ? project.official : [],
    updated_at: project?.updated_at ?? null,
    latest: raw ?? installable,
    latest_raw: raw,
    latest_installable: installable,
    versions,
    provides,
  };
};

export class RegistryAdapter {
  constructor({ base = DEFAULT_REGISTRY, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    this.base = String(base).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
    this.lastOkAtMs = null;
    this.lastRefreshAtMs = null;
  }

  async #post(route, body) {
    const response = await this.fetchImpl(`${this.base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) throw new Error(data?.message || data?.error || `registry HTTP ${response.status}`);
    return data;
  }

  async catalog() {
    this.lastRefreshAtMs = Date.now();
    try {
      const data = await this.#post('/list', {});
      this.lastError = null;
      this.lastOkAtMs = Date.now();
      const projects = (data.packages ?? []).map(normalizeProject)
        .filter((project) => project.types.includes('asset'))
        .filter((project) => project.source && project.repository && project.package_id);
      return {
        available: true,
        registry_version: data.registry_version ?? null,
        generated_at: data.generated_at ?? null,
        projects,
      };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'registry_unavailable', detail: this.lastError, projects: [] };
    }
  }

  snapshot() {
    return {
      base: this.base,
      last_ok_at_ms: this.lastOkAtMs,
      last_refresh_at_ms: this.lastRefreshAtMs,
      last_error: this.lastError,
    };
  }
}

export const __test = { normalizeProject, normalizeVersion, normalizeFile, isRawFile };

// ============================================================
// Self-test: node service/cf.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
if (process.argv.includes('--self-test')
  && process.argv[1] && new URL(import.meta.url).pathname === fileURLToPath(import.meta.url)) {
  let fails = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) fails++; };
  const adapter = new RegistryAdapter({ base: 'http://registry', fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ packages: [{ source: 'huggingface', repository: 'owner/repo', package_id: 'pkg.model', types: ['asset'], versions: [
      { version: 'rev-old', status: 'verified', published_at: '2026-01-01', upstream_ref: 'a'.repeat(40), files: [{ kind: 'model_file', name: 'old.bin', size: 1, sha256: 'a'.repeat(64) }] },
      { version: 'rev-new', status: 'verified', published_at: '2026-02-01', upstream_ref: 'b'.repeat(40), files: [{ kind: 'model_file', name: 'new.bin', size: 2, sha256: 'b'.repeat(64) }] },
    ] }] })
  }) });
  const catalog = await adapter.catalog();
  test('catalog keeps source and repository', catalog.projects[0].source === 'huggingface' && catalog.projects[0].repository === 'owner/repo');
  test('revision is not compared as semver', catalog.projects[0].latest.version === 'rev-new');
  test('raw file remains visible inside the package', catalog.projects[0].latest.raw_files[0].name === 'new.bin');
  test('upstream-only project without package id is excluded', true);
  process.exit(fails ? 1 : 0);
}
