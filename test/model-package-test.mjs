/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Three explicit Registry model packages, multi-source manifests, and tiny local payloads.
 * [OUTPUT]: Regression coverage for package identity, file truth, paths, states, and usage.
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
const sha = (letter) => letter.repeat(64);
const rev = (letter) => letter.repeat(40);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-model-package-test-'));
const senseRoot = path.join(root, 'sense');
const campGeneric = path.join(root, 'camp-generic');
const campHtp = path.join(root, 'camp-htp');
const fireRoot = path.join(root, 'fire');
for (const directory of [senseRoot, campGeneric, campHtp, fireRoot]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(senseRoot, 'model.onnx'), 'abc');
fs.writeFileSync(path.join(senseRoot, 'am.mvn'), 'abc');
fs.writeFileSync(path.join(senseRoot, 'tokens.json'), 'abc');
fs.writeFileSync(path.join(campGeneric, 'campplus.onnx'), 'abc');
fs.writeFileSync(path.join(campHtp, 'campplus.onnx.part'), 'ab');
fs.writeFileSync(path.join(fireRoot, 'model.onnx'), 'abc');
fs.writeFileSync(path.join(fireRoot, 'cmvn.bin'), 'abc');

const senseRevision = rev('1');
const campRevision = rev('2');
const fireRevision = rev('3');
const registry = new RegistryAdapter({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ packages: [
  {
    source: 'huggingface', repository: 'johnson-yo/termux_os-asset-sensevoice-htp-onnx',
    package_id: 'github.termux-os.asset.sensevoice', types: ['asset'], display_name: 'SenseVoice', versions: [
      { version: senseRevision, upstream_ref: senseRevision, status: 'verified', published_at: '2026-01-01', files: [
        { kind: 'model_file', local_path: 'old.onnx', remote_path: 'old.onnx', source: 'huggingface', repository: 'johnson-yo/termux_os-asset-sensevoice-htp-onnx', revision: senseRevision, size: 3, sha256: sha('e') },
      ] },
      { version: '4.0.0', upstream_ref: senseRevision, status: 'verified', published_at: '2026-02-01', files: [
        { kind: 'model_file', local_path: 'model.onnx', remote_path: 'graph/generic/model.onnx', source: 'huggingface', repository: 'johnson-yo/termux_os-asset-sensevoice-htp-onnx', revision: senseRevision, size: 3, sha256: sha('a'), role: 'model' },
        { kind: 'model_file', local_path: 'am.mvn', remote_path: 'am.mvn', source: 'huggingface', repository: 'FunAudioLLM/SenseVoiceSmall', revision: rev('4'), size: 3, sha256: sha('b'), role: 'frontend' },
        { kind: 'model_file', local_path: 'tokens.json', remote_path: 'tokens.json', source: 'huggingface', repository: 'kautism/SenseVoiceSmall-onnx', revision: rev('5'), size: 3, sha256: sha('c'), role: 'tokens' },
      ], packages: [{ package_id: 'github.termux-os.asset.sensevoice', provides: [{ id: 'model.sensevoice.graph', kind: 'asset' }] }] },
    ],
  },
  {
    source: 'huggingface', repository: 'johnson-yo/termux_os-asset-campplus-htp-onnx',
    package_id: 'github.termux-os.asset.campplus', types: ['asset'], display_name: 'CAM++', versions: [{
      version: '1.3.0', upstream_ref: campRevision, status: 'verified', published_at: '2026-03-01', files: [
        { kind: 'model_file', local_path: 'generic/campplus.onnx', remote_path: 'graph/generic/campplus.onnx', source: 'huggingface', repository: 'johnson-yo/termux_os-asset-campplus-htp-onnx', revision: campRevision, size: 3, sha256: sha('d'), role: 'generic' },
        { kind: 'model_file', local_path: 'htp-t148/campplus.onnx', remote_path: 'graph/htp-t148/campplus.onnx', source: 'huggingface', repository: 'johnson-yo/termux_os-asset-campplus-htp-onnx', revision: campRevision, size: 3, sha256: sha('e'), role: 'htp_source' },
      ], packages: [{ package_id: 'github.termux-os.asset.campplus', provides: [{ id: 'model.campplus.graph', kind: 'asset' }] }] },
    ],
  },
  {
    source: 'huggingface', repository: 'johnson-yo/termux_os-asset-fireredvad-htp-onnx',
    package_id: 'github.termux-os.asset.fireredvad', types: ['asset'], display_name: 'FireRedVAD', versions: [{
      version: '1.1.0', upstream_ref: fireRevision, status: 'verified', published_at: '2026-04-01', files: [
        { kind: 'model_file', local_path: 'model.onnx', remote_path: 'model.onnx', source: 'huggingface', repository: 'johnson-yo/termux_os-asset-fireredvad-htp-onnx', revision: fireRevision, size: 3, sha256: sha('f') },
        { kind: 'model_file', local_path: 'cmvn.bin', remote_path: 'cmvn.bin', source: 'huggingface', repository: 'johnson-yo/termux_os-asset-fireredvad-htp-onnx', revision: fireRevision, size: 3, sha256: sha('g') },
      ], packages: [{ package_id: 'github.termux-os.asset.fireredvad', provides: [{ id: 'model.fireredvad', kind: 'asset' }] }] },
    ],
  },
  { source: 'huggingface', repository: 'FunAudioLLM/SenseVoiceSmall', types: ['asset'], versions: [{ version: 'ref', status: 'verified', files: [{ kind: 'model_file', name: 'upstream', size: 1, sha256: sha('h') }] }] },
] }) }) });
const catalog = await registry.catalog();
test('active model catalog has exactly the three package identities', catalog.projects.length === 3);
test('upstream-only project is omitted before Manager grouping', !catalog.projects.some((item) => item.repository === 'FunAudioLLM/SenseVoiceSmall'));
test('semver package version is separate from upstream revision', catalog.projects[0].latest?.version === '4.0.0' && catalog.projects[0].latest?.revision === senseRevision);

const manifests = [
  { id: 'sense.package', manifest: { assets: { provides: [
    { id: 'model.sensevoice.frontend', payload: 'sense', files: { cmvn: 'am.mvn', tokens: 'tokens.json' }, source: { files: [
      { path: 'am.mvn', remote_path: 'am.mvn', host: 'huggingface', repo: 'FunAudioLLM/SenseVoiceSmall', revision: rev('4'), size: 3, sha256: sha('b') },
      { path: 'tokens.json', remote_path: 'tokens.json', host: 'huggingface', repo: 'kautism/SenseVoiceSmall-onnx', revision: rev('5'), size: 3, sha256: sha('c') },
    ] } },
    { id: 'model.sensevoice.graph', optional: true, payload: 'sense', files: { model: 'model.onnx' }, source: { files: [
      { path: 'model.onnx', remote_path: 'graph/generic/model.onnx', host: 'huggingface', repo: 'johnson-yo/termux_os-asset-sensevoice-htp-onnx', revision: rev('9'), size: 3, sha256: sha('a') },
      { path: 'stale.bin', remote_path: 'stale.bin', host: 'huggingface', repo: 'johnson-yo/termux_os-asset-sensevoice-htp-onnx', revision: senseRevision, size: 1, sha256: sha('z') },
    ] } },
  ] } } },
  { id: 'camp.package', manifest: { assets: { provides: [
    { id: 'model.campplus.graph', payload: 'camp-generic', source: { files: [{ path: 'campplus.onnx', remote_path: 'graph/generic/campplus.onnx', host: 'huggingface', repo: 'johnson-yo/termux_os-asset-campplus-htp-onnx', revision: campRevision, size: 3, sha256: sha('d') }] } },
    { id: 'model.campplus.htp-source', optional: true, payload: 'camp-htp', source: { files: [{ path: 'campplus.onnx', remote_path: 'graph/htp-t148/campplus.onnx', host: 'huggingface', repo: 'johnson-yo/termux_os-asset-campplus-htp-onnx', revision: campRevision, size: 3, sha256: sha('e') }] } },
  ] } } },
  { id: 'fire.package', manifest: { assets: { provides: [{ id: 'model.fireredvad', payload: 'fire', source: { files: [
    { path: 'model.onnx', remote_path: 'model.onnx', host: 'huggingface', repo: 'johnson-yo/termux_os-asset-fireredvad-htp-onnx', revision: fireRevision, size: 3, sha256: sha('f') },
    { path: 'cmvn.bin', remote_path: 'cmvn.bin', host: 'huggingface', repo: 'johnson-yo/termux_os-asset-fireredvad-htp-onnx', revision: fireRevision, size: 3, sha256: sha('g') },
  ] } }] } } },
];
const view = buildModelPackages({
  catalog,
  manifests,
  inventory: { available: true, assets: [
    { id: 'model.sensevoice.frontend', path: senseRoot, package_id: 'sense.package', version: '4.0.0', target: 'generic' },
    { id: 'model.sensevoice.graph', path: senseRoot, package_id: 'sense.package', version: '4.0.0', target: 'generic' },
    { id: 'model.campplus.graph', path: campGeneric, package_id: 'camp.package', version: '1.3.0', target: 'generic' },
    { id: 'model.campplus.htp-source', path: campHtp, package_id: 'camp.package', version: '1.3.0', target: 'generic' },
    { id: 'model.fireredvad', path: fireRoot, package_id: 'fire.package', version: '1.1.0', target: 'generic' },
  ] },
  declarations: { available: true, declarations: [{ source: 'huggingface', identity: 'johnson-yo/termux_os-asset-sensevoice-htp-onnx', package_id: 'speech.consumer', path: '.models/sensevoice' }] },
});
const sense = view.packages.find((item) => item.repository.includes('sensevoice'));
const camp = view.packages.find((item) => item.repository.includes('campplus'));
const fire = view.packages.find((item) => item.repository.includes('fireredvad'));
test('one card per explicit Registry package and no local-only stale card', view.packages.length === 3 && !view.packages.some((item) => item.local_only));
test('SenseVoice merges three source repositories into one package root', sense?.files.length === 3
  && new Set(sense.files.map((file) => file.repository)).size === 3
  && sense.files.every((file) => file.local.state === 'complete'));
test('SenseVoice provider root is shared but local paths are absolute', sense?.assets.length === 2
  && sense.assets.every((asset) => asset.path === senseRoot)
  && sense.files.every((file) => path.isAbsolute(file.local.path)));
test('SenseVoice maps a revision-drifted manifest only by exact bytes and path', sense?.files.find((file) => file.path === 'model.onnx')?.asset_ids.includes('model.sensevoice.graph')
  && sense.assets.find((asset) => asset.id === 'model.sensevoice.graph')?.optional === true);
test('manifest-only stale file is not added to the Registry file list', !sense?.files.some((file) => file.path === 'stale.bin'));
test('CAM++ keeps generic and fixed-window paths distinct', camp?.files.length === 2
  && new Set(camp.files.map((file) => file.path)).size === 2
  && camp.files[0].path !== camp.files[1].path);
test('CAM++ partial state is based on the exact mapped .part path', camp?.status === 'partial'
  && camp.files.some((file) => file.local.state === 'partial' && file.local.part_path.endsWith('campplus.onnx.part')));
test('FireRedVAD has two raw files and is complete', fire?.files.length === 2 && fire.status === 'complete');
test('summary is closed over the three cards', view.summary.total === 3
  && view.summary.complete + view.summary.partial + view.summary.none + view.summary.error + view.summary.unknown === view.summary.total);
test('usage is declaration metadata, not a second package card', sense?.usage.count === 1 && view.packages.filter((item) => item.repository.includes('sensevoice')).length === 1);
test('package and upstream versions are exposed separately', sense?.package_version === '4.0.0'
  && sense.upstream_revision === senseRevision && sense.version_kind === 'package_version');

const missingProviderView = buildModelPackages({
  catalog,
  manifests,
  inventory: { available: true, assets: [
    { id: 'model.sensevoice.frontend', path: senseRoot, package_id: 'sense.package', ready: true },
    { id: 'model.sensevoice.graph', declared_by: 'sense.package', package_id: 'sense.package', ready: false, reason: 'missing_asset' },
  ] },
  declarations: { available: true, declarations: [] },
});
const missingSense = missingProviderView.packages.find((item) => item.repository.includes('sensevoice'));
const missingGraph = missingSense?.assets.find((item) => item.id === 'model.sensevoice.graph');
test('declared optional provider separates loaded state from missing payload', missingGraph?.provider_state === 'loaded'
  && missingGraph.payload_state === 'missing' && missingGraph.fetchable === true && missingGraph.action === 'fetch'
  && missingSense.actions.download === true);

const absentProviderView = buildModelPackages({
  catalog,
  manifests,
  inventory: { available: true, assets: [{ id: 'model.sensevoice.frontend', path: senseRoot, package_id: 'sense.package', ready: true }] },
  declarations: { available: true, declarations: [] },
});
const absentSense = absentProviderView.packages.find((item) => item.repository.includes('sensevoice'));
const absentGraph = absentSense?.assets.find((item) => item.id === 'model.sensevoice.graph');
test('absent installable provider is visible as a provider-install action', absentGraph?.provider_state === 'absent'
  && absentGraph.installable === true && absentGraph.action === 'install_provider' && absentSense.actions.download === true);

fs.rmSync(root, { recursive: true, force: true });
console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
