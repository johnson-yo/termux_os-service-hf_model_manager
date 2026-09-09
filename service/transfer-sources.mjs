/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Manager-owned source coordinates and optional explicit transfer URLs.
 * [OUTPUT]: Source-neutral transfer file specs for Framework Core.
 * [POS]: hf-model-manager/service/transfer-sources.mjs.
 * [PROTOCOL]: Source policy belongs to the replaceable Manager. Core receives
 *             only the resolved URL, relative path, byte count, and SHA-256.
 */

const encodePath = (value) => String(value ?? '').split('/').map(encodeURIComponent).join('/');
// The manifest contract keeps `host` optional for compatibility: omission is
// the historical Hugging Face default.  It is a Manager default, never a Core
// source branch, and a replacement Manager may choose a different default.
const sourceOf = (file) => file?.source ?? file?.file_source ?? file?.host ?? 'huggingface';
const repositoryOf = (file) => file?.repository ?? file?.repo ?? null;
const remotePathOf = (file) => file?.remote_path ?? file?.remotePath ?? file?.file_path ?? file?.path ?? file?.name ?? null;

const validUrl = (value) => typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) ? value : null;

const builtinAdapters = new Map([
  ['huggingface', (file) => {
    const repository = repositoryOf(file);
    const revision = file?.revision;
    const remote = remotePathOf(file);
    return repository && revision && remote
      ? `https://huggingface.co/${repository}/resolve/${revision}/${encodePath(remote)}` : null;
  }],
  ['github', (file) => {
    const repository = repositoryOf(file);
    const revision = file?.revision;
    const remote = remotePathOf(file);
    return repository && revision && remote
      ? `https://raw.githubusercontent.com/${repository}/${revision}/${encodePath(remote)}` : null;
  }],
]);

export const createSourceRegistry = (entries = builtinAdapters) => {
  const registry = new Map(entries);
  return {
    register(source, resolver) {
      if (typeof source !== 'string' || !source.trim()) throw new Error('source adapter needs a source id');
      if (typeof resolver !== 'function') throw new Error(`source adapter ${source} needs a resolver`);
      registry.set(source.trim().toLowerCase(), resolver);
      return this;
    },
    resolve(file) {
      const explicit = validUrl(file?.url);
      if (explicit) return explicit;
      const source = String(sourceOf(file) ?? '').trim().toLowerCase();
      const resolver = registry.get(source);
      return validUrl(resolver?.(file)) ?? null;
    },
    has(source) { return registry.has(String(source ?? '').trim().toLowerCase()); },
  };
};

export const defaultSourceRegistry = createSourceRegistry();

export const resolveTransferFile = (file, { registry = defaultSourceRegistry } = {}) => {
  const url = registry.resolve(file);
  if (!url) return null;
  const size = Number(file?.size);
  const sha256 = typeof file?.sha256 === 'string' ? file.sha256.toLowerCase() : null;
  const localPath = typeof file?.path === 'string' ? file.path : typeof file?.local_path === 'string' ? file.local_path : null;
  if (!localPath || !Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) return null;
  return { path: localPath, url, size, sha256, ...(typeof file?.role === 'string' && file.role ? { role: file.role } : {}) };
};

export const resolveTransferFiles = (files, options = {}) => (files ?? [])
  .map((file) => resolveTransferFile(file, options))
  .filter(Boolean)
  .filter((file, index, list) => list.findIndex((other) =>
    other.path === file.path && other.size === file.size && other.sha256 === file.sha256) === index);

export const __test = { encodePath, sourceOf, repositoryOf, remotePathOf, validUrl };

// ============================================================
// Self-test: node service/transfer-sources.mjs --self-test
// ============================================================
const { fileURLToPath } = await import('node:url');
import path from 'node:path';
if (process.argv.includes('--self-test')
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const test = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
  const file = { path: 'model.bin', repository: 'owner/repo', revision: 'a'.repeat(40),
    remote_path: 'sub/model.bin', size: 4, sha256: 'b'.repeat(64) };
  const hf = resolveTransferFile({ ...file, source: 'huggingface' });
  test('HF adapter emits a complete neutral transfer spec', hf?.path === 'model.bin'
    && hf.url.endsWith('/sub/model.bin') && hf.size === 4 && hf.sha256 === 'b'.repeat(64));
  const github = resolveTransferFile({ ...file, source: 'github' });
  test('GitHub adapter is a Manager concern and emits the same shape', github?.url.startsWith('https://raw.githubusercontent.com/'));
  const omittedHost = resolveTransferFile(file);
  test('omitted host keeps the published Hugging Face compatibility default', omittedHost?.url.startsWith('https://huggingface.co/'));
  const explicit = resolveTransferFile({ ...file, source: 'modelscope', url: 'https://modelscope.example/download/signed' });
  test('a ModelScope-style Manager can use an explicit URL without Core changes', explicit?.url === 'https://modelscope.example/download/signed');
  const custom = createSourceRegistry().register('modelscope', (entry) =>
    `https://modelscope.example/${entry.repository}/${entry.revision}/${entry.remote_path}`);
  const modelscope = resolveTransferFile({ ...file, source: 'modelscope' }, { registry: custom });
  test('a replaceable Manager can add a source adapter locally', modelscope?.url.includes('modelscope.example/owner/repo'));
  test('unknown source without an explicit URL is unavailable, not guessed', resolveTransferFile({ ...file, source: 'unknown' }) === null);
  console.log(`${6 - failures}/6 assertions passed`);
  process.exit(failures ? 1 : 0);
}
