/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Registry and manifest-shaped raw model package fixtures.
 * [OUTPUT]: Grouping, identity, revision/version, multifile, and local status assertions.
 * [POS]: hf-model-manager/test/model-package-test.mjs.
 * [PROTOCOL]: Fixtures use tiny files and never touch the shared user store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RegistryAdapter } from '../service/cf.mjs';
import { buildModelPackages } from '../service/model-packages.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-model-package-test-'));
const complete = path.join(root, 'model.onnx');
const part = path.join(root, 'vocab.json.part');
fs.writeFileSync(complete, 'abc');
fs.writeFileSync(part, 'ab');

const registry = new RegistryAdapter({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ packages: [
  { source: 'huggingface', repository: 'owner/repo', package_id: 'provider.asset', types: ['asset'], versions: [
    { version: '1.0.0', upstream_ref: 'old', status: 'verified', published_at: '2026-01-01', files: [{ kind: 'model_file', name: 'model.onnx', size: 3, sha256: 'a'.repeat(64) }] },
    { version: '2.0.0', upstream_ref: 'new', status: 'verified', published_at: '2026-02-01', files: [
      { kind: 'model_file', name: 'model.onnx', size: 3, sha256: 'a'.repeat(64) },
      { kind: 'model_file', name: 'vocab.json', size: 4, sha256: 'b'.repeat(64) },
    ] },
  ] },
  { source: 'huggingface', repository: 'upstream/only', types: ['asset'], versions: [
    { version: 'rev', status: 'verified', files: [{ kind: 'model_file', name: 'x', size: 1, sha256: 'c'.repeat(64) }] },
  ] },
] }) }) });
const catalog = await registry.catalog();
test('source/repository identity is kept from Registry', catalog.projects[0].key === undefined
  && catalog.projects[0].source === 'huggingface' && catalog.projects[0].repository === 'owner/repo');
test('revision and package version stay separate', catalog.projects[0].latest.version === '2.0.0'
  && catalog.projects[0].latest.revision === 'new');
test('upstream-only project has no installable package identity', catalog.projects.length === 1);

const view = buildModelPackages({
  catalog,
  manifests: [{ id: 'provider.asset', manifest: { assets: { provides: [{
    id: 'asset.raw', payload: 'raw', files: { model: 'model.onnx', vocab: 'vocab.json' },
    source: { files: [
      { path: 'model.onnx', repo: 'owner/repo', revision: 'new', size: 3, sha256: 'a'.repeat(64) },
      { path: 'vocab.json', repo: 'owner/repo', revision: 'new', size: 4, sha256: 'b'.repeat(64) },
    ] },
  }] } } }],
  inventory: { available: true, assets: [{ id: 'asset.raw', path: root, package_id: 'provider.asset', version: '2.0.0', target: 'generic' }] },
  declarations: { available: true, declarations: [{ source: 'huggingface', identity: 'owner/repo', package_id: 'consumer.one', path: '.models/owner/repo' }] },
});
const card = view.packages.find((item) => item.key === 'huggingface:owner/repo');
test('one package card contains all approved raw files', card?.files.length === 2);
test('partial prefix is distinguished from complete file', card?.status === 'partial'
  && card.files.some((file) => file.local.state === 'partial' && file.local.part_path.endsWith('.part')));
test('complete raw path is absolute', card?.files.some((file) => file.local.path === complete && path.isAbsolute(file.local.path)));
test('usage comes from current declarations', card?.usage.count === 1 && card.usage.consumers[0].package_id === 'consumer.one');
test('package identity is never inferred from an upstream-only project', !view.packages.some((item) => item.repository === 'upstream/only'));

fs.rmSync(root, { recursive: true, force: true });
console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
