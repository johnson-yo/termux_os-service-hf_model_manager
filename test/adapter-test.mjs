/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Injected Framework HTTP responses and the Manager operation state machine.
 * [OUTPUT]: Delegation, expectation, progress, deduplication, and stage contract checks.
 * [POS]: hf-model-manager/test/adapter-test.mjs.
 * [PROTOCOL]: No network or shared store is used.
 */

import { FrameworkAssets } from '../service/framework.mjs';
import { Operations, STAGES, COMPLETE } from '../service/operations.mjs';

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
await adapter.purgePayload('asset.raw', { package_id: 'pkg', version: '1.0.0', target: 'generic', path: '/store/pkg/1.0.0/generic/raw' });
test('inventory uses Core Asset endpoint', calls[0].url === 'http://core/api/assets');
test('declarations use a read-only Core seam', calls[1].url.endsWith('/api/packages/model-declarations') && calls[1].options.method === 'GET');
test('delete carries package/version/target/path expectations', (() => {
  const body = JSON.parse(calls[2].options.body);
  return calls[2].options.method === 'DELETE' && body.expected.version === '1.0.0' && body.expected.path.includes('/raw');
})());

const ops = new Operations({ now: (() => { let t = 1000; return () => ++t; })() });
const started = ops.start('download', 'huggingface:owner/repo', async ({ setStage, setProgress }) => {
  setStage('downloading'); setProgress({ bytesDone: 2, bytesTotal: 4, currentFile: 'model.bin' }); return { ok: true };
}, { stages: STAGES, progressPrecision: 'bytes' });
const duplicate = ops.start('download', 'huggingface:owner/repo', async () => ({ ok: true }), { stages: STAGES });
test('duplicate download returns one in-flight operation', duplicate.deduplicated === true && duplicate.operation.operation_id === started.operation.operation_id);
await new Promise((resolve) => setTimeout(resolve, 10));
test('operation reaches complete with real byte completion', ops.get(started.operation.operation_id).state === COMPLETE
  && ops.get(started.operation.operation_id).bytes_done === 4 && ops.get(started.operation.operation_id).progress === 100);
test('stages contain only raw Asset lifecycle phases', STAGES.join(',') === 'resolving,downloading,verifying,importing,deleting,done');

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
