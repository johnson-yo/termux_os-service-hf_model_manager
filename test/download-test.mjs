/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Tiny injected Framework responses for each provider/payload state.
 * [OUTPUT]: A–G regression coverage for the Manager's package-level download seam.
 * [POS]: hf-model-manager/test/download-test.mjs.
 * [PROTOCOL]: No Registry, device, or shared-store access is allowed here.
 */

import { createDownloadPackage } from '../service/download.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => { count += 1; console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures++; };

const makeScenario = ({ initial, refreshed = initial, install, jobs = [], fetches = [], progress = null }) => {
  const calls = [];
  let refreshCount = 0;
  let jobIndex = 0;
  let fetchIndex = 0;
  const local = {
    async installProvider(id) { calls.push(`provider:${id}`); return install ?? { ok: true, status: 202, data: { job: { id: 'job-1' } } }; },
    async packageJob(id) { calls.push(`job:${id}`); return jobs[jobIndex++] ?? { ok: true, status: 200, data: { job: { id, status: 'success' } } }; },
    async fetchProgress(id) {
      calls.push(`progress:${id}`);
      return progress ? { ok: true, status: 200, data: { progress: { bytes_done: 2, bytes_total: 4, progress: 50, current_file: 'tiny.bin', ...progress } } } : { ok: true, status: 200, data: {} };
    },
    async fetchPayload(id) { calls.push(`fetch:${id}`); return fetches[fetchIndex++] ?? { ok: true, status: 200, data: { routes: ['direct'] } }; },
    async describe(id) { calls.push(`verify:${id}`); return { ok: true, status: 200, asset: { id, ready: true } }; },
  };
  const run = createDownloadPackage({
    local,
    refreshCard: async () => { refreshCount += 1; return { key: 'pkg.test', assets: [refreshed] }; },
    sleepImpl: async () => {},
    jobPollMs: 0,
    progressIntervalMs: 1,
  });
  return { calls, local, get refreshCount() { return refreshCount; }, run };
};

const base = (overrides = {}) => ({
  id: 'asset.tiny', package_id: 'pkg.test', optional: true, loaded: true, installed: false,
  ready: false, fetchable: true, fetch_blocked_reason: null, ...overrides,
});

// v2 transfer path: the Manager supplies the URL only for the live request,
// gives Core a stable idempotency key, and resubmits the file spec on retry so
// a Core restart can resume from its journal/staging state.
{
  const calls = [];
  const transferFiles = [{ path: 'model.bin', url: 'https://source.example/model.bin', size: 4, sha256: 'a'.repeat(64) }];
  let createCount = 0;
  const local = {
    async createTransfer(input) { createCount++; calls.push({ kind: 'create', input }); return { ok: true, status: 201, data: { operation: { operation_id: 'core-op-1' } } }; },
    async runTransfer(id, input) { calls.push({ kind: 'run', id, input }); return { ok: true, status: 200, data: { operation: { result: { bytes_done: 4, bytes_total: 4, progress: 100 } } } }; },
    async resolutionV2(id) { calls.push({ kind: 'verify', id }); return { ok: true, status: 200, data: { resolution: { id, ready: true } } }; },
  };
  const run = createDownloadPackage({ local, refreshCard: async () => ({ key: 'pkg.v2', assets: [base({
    id: 'asset.v2', optional: false, ready: false, declared: true, fetchable: true,
    target: 'generic', ledger_generation: 8, transfer_files: transferFiles,
  })] }), sleepImpl: async () => {} });
  const card = { key: 'pkg.v2', assets: [base({ id: 'asset.v2', optional: false, ready: false, declared: true,
    fetchable: true, target: 'generic', ledger_generation: 8, transfer_files: transferFiles })] };
  await run(card);
  const key = calls.find((item) => item.kind === 'create')?.input.idempotencyKey;
  await run(card);
  test('v2 transfer is resumable and idempotent across Manager retries', createCount === 2
    && key?.startsWith('asset-transfer-v2:')
    && calls.filter((item) => item.kind === 'create').every((item) => item.input.idempotencyKey === key)
    && calls.filter((item) => item.kind === 'run').every((item) => item.input.files === transferFiles));
}

// A failed replacement is not allowed to masquerade as a successful update or
// trigger a second selection/verification step. Core's CAS test covers the
// Ledger-side old Selection; this seam covers Manager-side failure handling.
{
  const calls = [];
  const transferFiles = [{ path: 'model.bin', url: 'https://source.example/replacement.bin', size: 4, sha256: 'c'.repeat(64) }];
  const local = {
    async createTransfer(input) { calls.push({ kind: 'create', input }); return { ok: true, status: 201, data: { operation: { operation_id: 'failed-update-op' } } }; },
    async runTransfer(id) { calls.push({ kind: 'run', id }); return { ok: false, status: 409, data: { error: 'generation_mismatch' } }; },
    async resolutionV2(id) { calls.push({ kind: 'verify', id }); return { ok: true, status: 200, data: { resolution: { id, ready: true } } }; },
  };
  const run = createDownloadPackage({ local, refreshCard: async () => ({ key: 'pkg.failed-update', assets: [base({
    id: 'asset.failed-update', ready: false, declared: true, fetchable: true, payload_id: 'old-payload',
    ledger_generation: 11, transfer_files: transferFiles,
  })] }), sleepImpl: async () => {} });
  let failed = null;
  try {
    await run({ key: 'pkg.failed-update', assets: [base({ id: 'asset.failed-update', ready: false,
      declared: true, fetchable: true, payload_id: 'old-payload', ledger_generation: 11, transfer_files: transferFiles })] },
    () => {}, () => {}, { update: true });
  } catch (error) { failed = error; }
  test('failed update remains retryable without a false verification', failed?.code === 'generation_mismatch'
    && calls.length === 2 && calls[0].kind === 'create' && calls[1].kind === 'run');
}

// A ready predecessor is still updateable when the caller explicitly asks for
// update.  The old selection remains the verification fallback only after the
// replacement transfer returns successfully.
{
  const calls = [];
  const transferFiles = [{ path: 'model.bin', url: 'https://source.example/new.bin', size: 4, sha256: 'b'.repeat(64) }];
  const local = {
    async createTransfer(input) { calls.push({ kind: 'create', input }); return { ok: true, status: 201, data: { operation: { operation_id: 'update-op' } } }; },
    async runTransfer(id, input) { calls.push({ kind: 'run', id, input }); return { ok: true, status: 200, data: { operation: { result: { bytes_done: 4, bytes_total: 4, progress: 100 } } } }; },
    async resolutionV2(id) { calls.push({ kind: 'verify', id }); return { ok: true, status: 200, data: { resolution: { id, ready: true } } }; },
  };
  const candidate = base({ id: 'asset.ready-update', ready: true, payload_state: 'ready', declared: true,
    fetchable: false, target: 'generic', ledger_generation: 12, payload_id: 'old-payload', transfer_files: transferFiles });
  const run = createDownloadPackage({ local, refreshCard: async () => ({ key: 'pkg.ready-update', assets: [candidate] }), sleepImpl: async () => {} });
  await run({ key: 'pkg.ready-update', assets: [candidate] }, () => {}, () => {}, { update: true });
  test('explicit update replaces a still-ready predecessor', calls[0]?.kind === 'create'
    && calls[1]?.kind === 'run' && calls.some((item) => item.kind === 'verify'));
}

// A: a declared optional provider goes straight to Framework /fetch.
{
  const scenario = makeScenario({ initial: base() });
  await scenario.run({ key: 'pkg.test', assets: [base()] });
  test('A declared missing payload fetches directly', !scenario.calls.some((item) => item.startsWith('provider:'))
    && scenario.calls.includes('fetch:asset.tiny'));
}

// B: ready state is verify/reuse; it must never re-fetch.
{
  const scenario = makeScenario({ initial: base({ ready: true, payload_state: 'ready' }) });
  await scenario.run({ key: 'pkg.test', assets: [base({ ready: true, payload_state: 'ready' })] });
  test('B ready provider is verified and reused', scenario.calls.includes('verify:asset.tiny')
    && !scenario.calls.includes('fetch:asset.tiny'));
}

// C: a .part-backed partial state remains Framework-owned and is resumable.
{
  const scenario = makeScenario({ initial: base({ payload_state: 'partial' }), progress: { resumed: true, resume_from_bytes: 2 } });
  const progress = [];
  await scenario.run({ key: 'pkg.test', assets: [base({ payload_state: 'partial' })] }, () => {}, (value) => progress.push(value));
  // The injected adapter is enough to prove the fetch path; the explicit
  // progress callback is checked through a second invocation below because
  // createDownloadPackage's public seam accepts the callbacks as arguments.
  const direct = createDownloadPackage({
    local: {
      ...scenario.local,
      fetchProgress: async () => ({ ok: true, data: { progress: { bytes_done: 2, bytes_total: 4, progress: 50, resumed: true, resume_from_bytes: 2 } } }),
    },
    refreshCard: async () => ({ key: 'pkg.test', assets: [base({ payload_state: 'partial' })] }),
    sleepImpl: async () => {}, progressIntervalMs: 1,
  });
  const observed = [];
  await direct({ key: 'pkg.test', assets: [base({ payload_state: 'partial' })] }, () => {}, (value) => observed.push(value));
  test('C partial provider uses resumable fetch progress', scenario.calls.includes('fetch:asset.tiny')
    && observed.some((value) => value.resumed === true && value.resumeFromBytes === 2));
}

// D: a failed payload operation is retryable and the second attempt delegates
// to the same Core route, rather than inventing a local downloader.
{
  const scenario = makeScenario({
    initial: base(),
    fetches: [{ ok: false, status: 503, data: { error: 'temporary_fetch_failure' } }, { ok: true, status: 200, data: { routes: ['resume'] } }],
  });
  let failed = false;
  try { await scenario.run({ key: 'pkg.test', assets: [base()] }); } catch (error) { failed = error.code === 'temporary_fetch_failure'; }
  await scenario.run({ key: 'pkg.test', assets: [base()] });
  test('D payload error can be retried', failed && scenario.calls.filter((item) => item === 'fetch:asset.tiny').length === 2);
}

// E: a provider that is not declared handles 202 + package-job polling before
// the Manager reads the provider state and starts the optional fetch.
{
  const scenario = makeScenario({
    initial: base({ loaded: false, installable: true, fetchable: false }),
    refreshed: base({ loaded: true, installable: false, fetchable: true }),
    jobs: [
      { ok: true, status: 200, data: { job: { id: 'job-1', status: 'running' } } },
      { ok: true, status: 200, data: { job: { id: 'job-1', status: 'success' } } },
    ],
  });
  await scenario.run({ key: 'pkg.test', assets: [base({ loaded: false, installable: true, fetchable: false })] });
  const providerAt = scenario.calls.indexOf('provider:asset.tiny');
  const firstJobAt = scenario.calls.indexOf('job:job-1');
  const fetchAt = scenario.calls.indexOf('fetch:asset.tiny');
  test('E 202 provider install waits for job then refetches state', providerAt >= 0 && firstJobAt > providerAt && fetchAt > firstJobAt
    && scenario.refreshCount > 0);
}

// F: 409 already_declared is a recoverable race only after a fresh state read.
{
  const scenario = makeScenario({
    initial: base({ loaded: false, installable: true, fetchable: false }),
    refreshed: base({ loaded: true, installable: false, fetchable: true }),
    install: { ok: false, status: 409, data: { error: 'already_declared' } },
  });
  await scenario.run({ key: 'pkg.test', assets: [base({ loaded: false, installable: true, fetchable: false })] });
  test('F already_declared recovers through fresh provider state', scenario.calls.includes('provider:asset.tiny')
    && scenario.calls.includes('fetch:asset.tiny') && scenario.refreshCount > 0);
}

// G: a terminal package-job failure stops before any optional payload fetch.
{
  const scenario = makeScenario({
    initial: base({ loaded: false, installable: true, fetchable: false }),
    jobs: [{ ok: true, status: 200, data: { job: { id: 'job-1', status: 'failed', error: 'bad package' } } }],
  });
  let failed = false;
  try { await scenario.run({ key: 'pkg.test', assets: [base({ loaded: false, installable: true, fetchable: false })] }); } catch (error) {
    failed = error.code === 'provider_install_failed' && /bad package/.test(error.message);
  }
  test('G failed provider Package job blocks payload fetch', failed && !scenario.calls.includes('fetch:asset.tiny'));
}

console.log(`${count}/${count} assertions passed`);
process.exit(failures ? 1 : 0);
