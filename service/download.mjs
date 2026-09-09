/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A model-package card, Framework Core's generic Asset adapter, and an
 *          operation's stage/progress callbacks.
 * [OUTPUT]: One package-level download operation that correctly separates
 *           provider installation, provider readiness, optional Asset fetch,
 *           verification, and Package job failures.
 * [POS]: hf-model-manager/service/download.mjs.
 * [PROTOCOL]: Framework Core remains the only byte authority. This module owns
 *             orchestration and state transitions, never URLs, .part files,
 *             Range requests, hashes, or shared-store paths.
 */

import crypto from 'node:crypto';

const TERMINAL_PACKAGE_JOBS = new Set(['success', 'failed']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const responseFailure = (result, fallback) => {
  if (result?.ok) return null;
  const data = result?.data ?? {};
  const error = new Error(data.detail || data.error || result?.error || fallback);
  error.code = data.error || result?.error || (result?.status === 409 ? 'conflict' : 'request_failed');
  error.status = result?.status ?? null;
  error.response = result;
  return error;
};

const operationError = (code, message, cause = null) => {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

const candidateError = (candidate) => operationError(
  candidate?.fetch_blocked_reason ?? 'provider_unavailable',
  `${candidate?.id ?? 'asset'} is not ready for transfer (${candidate?.fetch_blocked_reason ?? 'provider_unavailable'})`,
);

const transferIdempotencyKey = (candidate) => {
  const material = JSON.stringify({
    asset_id: candidate?.id ?? null,
    variant_id: candidate?.target ?? 'generic',
    ledger_generation: candidate?.ledger_generation ?? null,
    files: (candidate?.transfer_files ?? []).map((file) => ({
      path: file.path, size: file.size, sha256: file.sha256,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  });
  return `asset-transfer-v2:${crypto.createHash('sha256').update(material).digest('hex')}`;
};

const assetCandidate = (card, id) => (card?.assets ?? []).find((item) => item.id === id) ?? null;

const progressWatcher = ({ local, assetId, setProgress, intervalMs = 750 }) => {
  let stopped = false;
  let previous = null;
  const poll = async () => {
    if (stopped) return;
    try {
      const response = await local.fetchProgress(assetId);
      const progress = response.data?.progress;
      if (!progress) return;
      const bytesDone = Number(progress.bytes_done);
      const observedAt = Date.now();
      const speedBps = previous && observedAt > previous.at && bytesDone >= previous.bytes
        ? ((bytesDone - previous.bytes) * 1000) / (observedAt - previous.at) : null;
      previous = { bytes: bytesDone, at: observedAt };
      setProgress({
        assetId,
        providerId: assetId,
        bytesDone,
        bytesTotal: Number(progress.bytes_total),
        progress: Number(progress.progress),
        precision: 'bytes',
        currentFile: progress.current_file,
        speedBps,
        route: progress.route ?? null,
        retry: Number(progress.retry_count ?? progress.retry),
        resumed: progress.resumed === true,
        resumeFromBytes: Number(progress.resume_from_bytes),
      });
    } catch {
      // The fetch result remains authoritative. A short progress read outage
      // must not turn a running Framework transfer into a fake failure.
    }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  void poll();
  return () => { stopped = true; clearInterval(timer); };
};

const transferProgressWatcher = ({ local, operationId, assetId, setProgress, intervalMs = 750 }) => {
  let stopped = false;
  let previous = null;
  const poll = async () => {
    if (stopped) return;
    try {
      const response = await local.transferOperation(operationId);
      const operation = response.data?.operation ?? response.data;
      if (!operation) return;
      const bytesDone = Number(operation.bytes_done);
      const bytesTotal = Number(operation.bytes_total);
      const observedAt = Date.now();
      const speedBps = previous && observedAt > previous.at && bytesDone >= previous.bytes
        ? ((bytesDone - previous.bytes) * 1000) / (observedAt - previous.at) : null;
      previous = { bytes: bytesDone, at: observedAt };
      setProgress({ assetId, providerId: assetId, bytesDone, bytesTotal,
        progress: Number(operation.progress), precision: 'bytes', currentFile: operation.current_file,
        speedBps, resumed: operation.resumed === true, resumeFromBytes: Number(operation.resume_from_bytes) });
    } catch {
      // The transfer result remains authoritative; progress is observational.
    }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  void poll();
  return () => { stopped = true; clearInterval(timer); };
};

const waitForPackageJob = async ({ local, jobId, setStage, sleepImpl, now, timeoutMs, pollMs }) => {
  if (typeof local.packageJob !== 'function') {
    throw operationError('package_job_status_unavailable', 'Framework package job status API is unavailable');
  }
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() <= deadline) {
    setStage('resolving');
    const response = await local.packageJob(jobId);
    const failure = responseFailure(response, `package job status failed for ${jobId}`);
    if (failure) throw failure;
    const job = response.data?.job ?? response.data;
    last = job;
    if (job?.status === 'success') return job;
    if (TERMINAL_PACKAGE_JOBS.has(job?.status)) {
      throw operationError('provider_install_failed', `provider Package job ${jobId} failed: ${job?.error ?? job?.status}`, job);
    }
    await sleepImpl(pollMs);
  }
  throw operationError('provider_install_timeout', `provider Package job ${jobId} did not finish before timeout`, last);
};

/**
 * Build the package operation with injected dependencies. Keeping this pure
 * seam separate from the HTTP server makes the 409/202 state machine testable
 * without a device or a large model.
 */
export const createDownloadPackage = ({
  local,
  refreshCard = async (card) => card,
  sleepImpl = sleep,
  now = () => Date.now(),
  jobTimeoutMs = 10 * 60_000,
  jobPollMs = 250,
  progressIntervalMs = 750,
} = {}) => {
  if (!local) throw new Error('download operation requires a Framework adapter');
  return async (card, setStage = () => {}, setProgress = () => {}, { update = false } = {}) => {
    const ids = [...new Set((card?.assets ?? []).map((asset) => asset.id).filter(Boolean))];
    if (!ids.length) throw operationError('no_asset_provider', 'raw package has no declared Asset provider');
    let currentCard = card;
    const results = [];

    const refresh = async () => {
      const next = await refreshCard(card.key, { force: true });
      if (next) currentCard = next;
      return currentCard;
    };
    const current = async (id) => assetCandidate(currentCard, id) ?? assetCandidate(await refresh(), id);

    const verifyReady = async (candidate) => {
      setStage('verifying');
      let verified = typeof local.resolutionV2 === 'function'
        ? await local.resolutionV2(candidate.id, { verify: true })
        : await local.describe(candidate.id, { verify: true });
      // A Manager can be upgraded before the device's Core. Keep the old
      // read-only verification seam as a narrow fallback for an explicitly
      // unsupported v2 route; any other v2 error remains authoritative.
      if (!verified.ok && [404, 405, 501].includes(Number(verified.status))
        && typeof local.describe === 'function') {
        verified = await local.describe(candidate.id, { verify: true });
      }
      const asset = verified.data?.resolution ?? verified.asset;
      // FrameworkAssets returns HTTP-shaped { ok, data }; older injected
      // adapters and the legacy describe seam return { available, asset }.
      // Normalize both at this boundary so the v2 path does not make old
      // fixtures (or a transitional Core) look like a failed checksum.
      const responseOk = verified.ok ?? (verified.available !== false
        && (verified.status === undefined || (verified.status >= 200 && verified.status < 300)));
      if (!responseOk || !asset?.ready) {
        throw operationError('verification_failed', `raw verification failed for ${candidate.id}: ${asset?.reason ?? 'unknown'}`);
      }
      results.push({ id: candidate.id, action: 'verify', reused: true, verified: true });
    };

    for (const id of ids) {
      let candidate = await current(id);
      if (!candidate) throw operationError('provider_state_missing', `provider state disappeared for ${id}`);

      if (candidate.ready && !update) {
        await verifyReady(candidate);
        continue;
      }

      if (!candidate.declared && candidate.installable) {
        setStage('resolving');
        const installed = await local.installProvider(candidate.id);
        const failure = responseFailure(installed, `provider install failed for ${candidate.id}`);
        if (failure && failure.code !== 'already_declared') throw failure;
        const jobId = installed.data?.job?.id ?? installed.data?.job_id ?? null;
        if (!failure) {
          if (jobId) {
            await waitForPackageJob({ local, jobId, setStage, sleepImpl, now, timeoutMs: jobTimeoutMs, pollMs: jobPollMs });
          }
        }
        // A 409 can be a benign race: another caller loaded the provider in
        // the interval between the snapshot and /provider. Re-read the state;
        // only a still-missing provider is an operation failure.
        candidate = await refresh().then((next) => assetCandidate(next, id));
        if (!candidate) throw operationError('provider_state_missing', `provider state missing after install for ${id}`);
        if (!candidate.declared && !candidate.loaded && !candidate.fetchable) throw candidateError(candidate);
        results.push({ id, action: failure ? 'already_declared' : 'install_provider', job_id: jobId });
      }

      candidate = await current(id);
      if (!candidate) throw operationError('provider_state_missing', `provider state disappeared for ${id}`);
      // An explicit update request must pass through even when the old
      // selection is still ready.  The catalog's changed coordinate is the
      // reason this path exists; re-verifying the predecessor here would turn
      // the update action into a no-op.
      if (candidate.ready && !update) {
        await verifyReady(candidate);
        continue;
      }
      const updateable = update && candidate.declared && Array.isArray(candidate.transfer_files)
        && candidate.transfer_files.length > 0;
      if (!candidate.fetchable && !updateable) throw candidateError(candidate);

      setStage('downloading');
      const useV2 = typeof local.createTransfer === 'function' && typeof local.runTransfer === 'function'
        && Array.isArray(candidate.transfer_files) && candidate.transfer_files.length > 0;
      let stopWatching = () => {};
      try {
        if (useV2) {
          const created = await local.createTransfer({
            type: 'pull', assetId: candidate.id, variantId: candidate.target ?? 'generic',
            files: candidate.transfer_files, expectedGeneration: candidate.ledger_generation,
            select: true,
            idempotencyKey: transferIdempotencyKey(candidate),
          });
          const createFailure = responseFailure(created, `raw transfer creation failed for ${candidate.id}`);
          if (createFailure) throw createFailure;
          const operationId = created.data?.operation?.operation_id;
          if (!operationId) throw operationError('transfer_operation_missing', `Core did not return an operation for ${candidate.id}`);
          if (typeof local.transferOperation === 'function') stopWatching = transferProgressWatcher({
            local, operationId, assetId: candidate.id, setProgress, intervalMs: progressIntervalMs,
          });
          const fetched = await local.runTransfer(operationId, { files: candidate.transfer_files });
          const fetchFailure = responseFailure(fetched, `raw transfer failed for ${candidate.id}`);
          if (fetchFailure) throw fetchFailure;
          const payload = fetched.data?.operation?.result ?? fetched.data?.operation ?? fetched.data ?? {};
          setProgress({ assetId: candidate.id, providerId: candidate.id, bytesDone: Number(payload.bytes_done),
            bytesTotal: Number(payload.bytes_total), progress: Number(payload.progress), precision: 'bytes',
            currentFile: payload.current_file, resumed: payload.resumed === true,
            resumeFromBytes: Number(payload.resume_from_bytes) });
          results.push({ id: candidate.id, action: update ? 'update' : 'transfer', operation_id: operationId, download: payload, routes: [] });
        } else {
          stopWatching = progressWatcher({
            local, assetId: candidate.id, setProgress, intervalMs: progressIntervalMs,
          });
          const fetched = await local.fetchPayload(candidate.id);
          const fetchFailure = responseFailure(fetched, `raw download failed for ${candidate.id}`);
          if (fetchFailure) throw fetchFailure;
          const payload = fetched.data ?? {};
          const routes = Array.isArray(payload.routes) ? payload.routes : [];
          setProgress({
            assetId: candidate.id,
            providerId: candidate.id,
            route: routes.at(-1) ?? null,
            currentFile: payload.current_file ?? null,
            retry: Number(payload.retry_count ?? payload.retry),
            resumed: payload.resumed === true,
            resumeFromBytes: Number(payload.resume_from_bytes),
          });
          results.push({ id: candidate.id, action: 'fetch', download: payload, routes });
        }
      } finally {
        stopWatching();
      }
      const afterFetch = await current(id);
      await verifyReady(afterFetch ?? candidate);
    }

    await refresh();
    return {
      package_key: card.key,
      assets: results,
      routes: [...new Set(results.flatMap((item) => item.routes ?? []))],
    };
  };
};

export const __test = { waitForPackageJob, progressWatcher, candidateError, transferIdempotencyKey };
