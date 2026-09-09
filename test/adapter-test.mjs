/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Injected Framework HTTP responses and the Manager operation state machine.
 * [OUTPUT]: Delegation, expectation, progress, deduplication, and stage contract checks.
 * [POS]: hf-model-manager/test/adapter-test.mjs.
 * [PROTOCOL]: No network or shared store is used.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FrameworkAssets } from '../service/framework.mjs';
import { Operations, STAGES, COMPLETE, OPERATIONS_SCHEMA } from '../service/operations.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };
const calls = [];
const adapter = new FrameworkAssets({ base: 'http://core', key: 'system', fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ assets: [], packages: [], declarations: [] }) };
} });
await adapter.inventory();
await adapter.modelDeclarations();
await adapter.fetchPayload('asset.raw');
await adapter.purgePayload('asset.raw', { package_id: 'pkg', version: '1.0.0', target: 'generic', path: '/store/pkg/1.0.0/generic/raw' });
await adapter.packageJob('job-1');
test('inventory uses Core Asset endpoint', calls[0].url === 'http://core/api/assets');
test('declarations use a read-only Core seam', calls[1].url.endsWith('/api/packages/model-declarations') && calls[1].options.method === 'GET');
test('download delegates direct-first/fallback policy to Core', calls[2].url.endsWith('/api/assets/asset.raw/fetch') && calls[2].options.method === 'POST');
test('delete carries package/version/target/path expectations', (() => {
  const body = JSON.parse(calls[3].options.body);
  return calls[3].options.method === 'DELETE' && body.expected.version === '1.0.0' && body.expected.path.includes('/raw');
})());
test('package install job status uses Framework admin read route', calls.at(-1).url.endsWith('/api/admin/package-manager/jobs/job-1')
  && calls.at(-1).options.method === 'GET');

const ops = new Operations({ now: (() => { let t = 1000; return () => ++t; })() });
const started = ops.start('download', 'huggingface:owner/repo', async ({ setStage, setProgress }) => {
  setStage('downloading'); setProgress({ assetId: 'asset.raw', providerId: 'asset.raw', bytesDone: 2, bytesTotal: 4,
    currentFile: 'model.bin', route: 'direct', speedBps: 8, resumed: true, resumeFromBytes: 2 }); return { ok: true };
}, { stages: STAGES, progressPrecision: 'bytes' });
const duplicate = ops.start('download', 'huggingface:owner/repo', async () => ({ ok: true }), { stages: STAGES });
test('duplicate download returns one in-flight operation', duplicate.deduplicated === true && duplicate.operation.operation_id === started.operation.operation_id);
await new Promise((resolve) => setTimeout(resolve, 10));
test('operation reaches complete with real byte completion', ops.get(started.operation.operation_id).state === COMPLETE
  && ops.get(started.operation.operation_id).bytes_done === 4 && ops.get(started.operation.operation_id).progress === 100
  && ops.get(started.operation.operation_id).current_provider === 'asset.raw'
  && ops.get(started.operation.operation_id).route === 'direct'
  && ops.get(started.operation.operation_id).resumed === true
  && ops.get(started.operation.operation_id).resume_from_bytes === 2);
test('stages contain only raw Asset lifecycle phases', STAGES.join(',') === 'resolving,downloading,verifying,importing,deleting,done');

const operationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-operations-'));
const operationFile = path.join(operationRoot, 'operations.v1.json');
const seedOperations = new Operations({ file: operationFile });
const saved = seedOperations.start('download', 'huggingface:owner/repo', async () => new Promise(() => {}), {
  stages: STAGES, progressPrecision: 'bytes', resumable: true,
});
const persisted = JSON.parse(fs.readFileSync(operationFile, 'utf8'));
const reloadedOperations = new Operations({ file: operationFile });
const pending = reloadedOperations.pending()[0];
const pendingStateBeforeResume = pending?.state;
let resumedRuns = 0;
reloadedOperations.resume(saved.operation.operation_id, async ({ setStage }) => {
  resumedRuns += 1;
  setStage('verifying');
  return { resumed: true };
});
await new Promise((resolve) => setTimeout(resolve, 10));
const persistedAfterResume = JSON.parse(fs.readFileSync(operationFile, 'utf8'));
test('resumable download state survives Manager process reload', persisted.schema === OPERATIONS_SCHEMA
  && pending?.operation_id === saved.operation.operation_id && pending?.resumable === true
  && pendingStateBeforeResume === 'running' && persisted.operations[0]?.state === 'running');
test('reloaded download resumes and persists its terminal result', resumedRuns === 1
  && reloadedOperations.get(saved.operation.operation_id)?.state === COMPLETE
  && persistedAfterResume.operations[0]?.state === COMPLETE
  && persistedAfterResume.operations[0]?.result?.resumed === true);
fs.rmSync(operationRoot, { recursive: true, force: true });

const ledgerErrorAdapter = new FrameworkAssets({ base: 'http://core', key: 'system', fetchImpl: async () => ({
  ok: false, status: 500, json: async () => ({ error: 'payload_ledger_corrupt', detail: 'bad ledger' }),
}) });
const ledgerError = await ledgerErrorAdapter.payloadsV2();
test('payload inventory preserves Core ledger corruption', ledgerError.error === 'payload_ledger_corrupt' && ledgerError.status === 500);

const selectionCalls = [];
const clearAdapter = new FrameworkAssets({ base: 'http://core', key: 'system', fetchImpl: async (url, options) => {
  selectionCalls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
} });
await clearAdapter.setSelectionV2('asset.raw');
test('selection adapter can explicitly clear a Selection', JSON.parse(selectionCalls[0].options.body).payload_id === null);

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
