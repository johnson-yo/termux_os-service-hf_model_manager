/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个 async 执行体 + 它自报的阶段
 * [OUTPUT]: `queued → running → verifying → complete|failed` 的可查询原始资产作业。
 * [POS]: Framework 的大文件操作是同步阻塞 HTTP；这里把它包成作业，
 *        立即回 operation_id，之后轮询真实文件流状态。
 *
 * ⚠ **不伪造进度。** 下载的 bytes_done/bytes_total 只接受 Framework 文件流的真实值；
 *   准备动作的百分比只由真实 stage 映射，绝不按时间自增。
 * [PROTOCOL]: Package operation state is persisted only when the caller marks
 * a download/update resumable; no credentials or request headers are stored.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const QUEUED = 'queued';
export const RUNNING = 'running';
export const VERIFYING = 'verifying';
export const COMPLETE = 'complete';
export const FAILED = 'failed';
export const TERMINAL = new Set([COMPLETE, FAILED]);
export const OPERATIONS_SCHEMA = 'termux-os.raw-model-manager-operations.v1';

export const STAGES = Object.freeze([
  'resolving', 'downloading', 'verifying', 'importing', 'deleting', 'done',
]);

const isMap = (value) => value && typeof value === 'object' && !Array.isArray(value);

const operationCopy = (operation) => ({
  operation_id: operation.operation_id,
  asset_id: operation.asset_id,
  action: operation.action,
  state: operation.state,
  stage: operation.stage,
  started_at_ms: operation.started_at_ms,
  updated_at_ms: operation.updated_at_ms,
  bytes_total: operation.bytes_total,
  bytes_done: operation.bytes_done,
  progress: operation.progress,
  progress_precision: operation.progress_precision,
  stages: operation.stages,
  error: operation.error,
  error_code: operation.error_code,
  result: operation.result,
  package_key: operation.package_key,
  current_asset: operation.current_asset,
  current_provider: operation.current_provider,
  current_file: operation.current_file,
  route: operation.route,
  speed_bps: operation.speed_bps,
  retry_count: operation.retry_count,
  resumed: operation.resumed,
  resume_from_bytes: operation.resume_from_bytes,
  resumable: operation.resumable === true,
});

const readPersisted = (file, keep) => {
  if (!file) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schema !== OPERATIONS_SCHEMA || !Array.isArray(value.operations)) return [];
    return value.operations.filter((item) => isMap(item)
      && typeof item.operation_id === 'string' && item.operation_id
      && typeof item.asset_id === 'string' && item.asset_id
      && typeof item.action === 'string' && item.action
      && typeof item.state === 'string' && typeof item.stage === 'string')
      .slice(0, keep);
  } catch { return []; }
};

export class Operations {
  constructor({ keep = 50, now = () => Date.now(), file = process.env.OPERATIONS_FILE || '' } = {}) {
    this.keep = keep;
    this.now = now;
    this.file = file;
    this.list = readPersisted(file, keep);
    /** `${action}|${assetId}` → operation_id。⭐ 同一件事不许排两次队。 */
    this.inFlight = new Map();
    this.onChange = () => {};
    for (const operation of this.list) {
      if (!TERMINAL.has(operation.state) && operation.resumable === true) {
        this.inFlight.set(this.key(operation.action, operation.asset_id), operation.operation_id);
      }
    }
  }

  #persist() {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temp, `${JSON.stringify({
          schema: OPERATIONS_SCHEMA,
          operations: this.list.slice(0, this.keep).map(operationCopy),
          updated_at_ms: this.now(),
        }, null, 2)}\n`, { mode: 0o600 });
        const fd = fs.openSync(temp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, this.file);
      } finally { fs.rmSync(temp, { force: true }); }
    } catch (error) {
      // Operation persistence is valuable recovery state, but a read-only or
      // temporarily unavailable data directory must not turn a successful
      // in-memory transfer into a false operation failure.
      this.persistence_error = String(error?.message ?? error);
    }
  }

  #touch(op) { op.updated_at_ms = this.now(); this.#persist(); this.onChange(op); }

  key(action, assetId) { return `${action}|${assetId}`; }

  /**
   * 起一个作业。⭐ 同一个 (action, asset) 已在飞 ⇒ **返回那一个**，不新建。
   * 重复点「下载」应该看到同一条进度，而不是并排两条互相覆盖的下载。
   */
  start(action, assetId, run, { bytesTotal = null, progressPrecision = null, stages = STAGES, resumable = false } = {}) {
    const key = this.key(action, assetId);
    const existing = this.inFlight.get(key);
    if (existing) {
      const op = this.get(existing);
      if (op && !TERMINAL.has(op.state)) return { operation: op, deduplicated: true };
      this.inFlight.delete(key);
    }
    const op = {
      operation_id: `op_${this.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      asset_id: assetId,
      action,
      state: QUEUED,
      stage: 'resolving',
      started_at_ms: this.now(),
      updated_at_ms: this.now(),
      bytes_total: Number.isFinite(bytesTotal) ? bytesTotal : null,
      bytes_done: Number.isFinite(bytesTotal) ? 0 : null,
      progress: Number.isFinite(bytesTotal) && bytesTotal > 0 ? 0 : null,
      /**
       * ⭐ 显式声明精度。消费方据此知道**不许**把 stage 画成百分比——
       * 一个从阶段编出来的进度条，会让卡住的下载看起来还在动。
       */
      progress_precision: progressPrecision ?? (Number.isFinite(bytesTotal) ? 'bytes' : 'stage'),
      stages,
      error: null,
      error_code: null,
      result: null,
      // Package/provider/file are kept separately so a UI can explain which
      // layer is active without guessing from a route or a stage label.
      package_key: assetId,
      current_asset: null,
      current_provider: null,
      current_file: null,
      route: null,
      speed_bps: null,
      retry_count: 0,
      resumed: false,
      resume_from_bytes: null,
      resumable: resumable === true,
    };
    this.list.unshift(op);
    while (this.list.length > this.keep) this.list.pop();
    this.inFlight.set(key, op.operation_id);
    this.#touch(op);

    this.#launch(op, key, run, stages);
    return { operation: op, deduplicated: false };
  }

  #launch(op, key, run, stages = op.stages ?? STAGES) {
    const setStage = (stage) => {
      if (!stages.includes(stage)) return;
      op.stage = stage;
      op.state = stage === 'verifying' ? VERIFYING : RUNNING;
      this.#touch(op);
    };

    const setProgress = ({
      assetId, providerId, currentAsset, bytesDone, bytesTotal: nextTotal, progress, precision,
      currentFile, route, speedBps, retry, retryCount, resumed, resumeFromBytes,
    } = {}) => {
      if (assetId || currentAsset) op.current_asset = assetId ?? currentAsset;
      if (providerId) op.current_provider = providerId;
      if (Number.isFinite(nextTotal) && nextTotal >= 0) op.bytes_total = nextTotal;
      if (Number.isFinite(bytesDone)) {
        op.bytes_done = op.bytes_done === null ? bytesDone : Math.max(op.bytes_done, bytesDone);
      }
      if (Number.isFinite(progress)) {
        const bounded = Math.max(0, Math.min(100, progress));
        op.progress = op.progress === null ? bounded : Math.max(op.progress, bounded);
      }
      if (precision) op.progress_precision = precision;
      if (currentFile) op.current_file = currentFile;
      if (route) op.route = route;
      if (Number.isFinite(speedBps) && speedBps >= 0) op.speed_bps = speedBps;
      if (Number.isFinite(retryCount) && retryCount >= 0) op.retry_count = retryCount;
      else if (Number.isFinite(retry) && retry >= 0) op.retry_count = retry;
      if (resumed === true) op.resumed = true;
      if (Number.isFinite(resumeFromBytes) && resumeFromBytes >= 0) op.resume_from_bytes = resumeFromBytes;
      this.#touch(op);
    };

    // ⚠ 故意不 await：调用方要立刻拿到 202。
    void (async () => {
      op.state = RUNNING;
      this.#touch(op);
      try {
        const result = await run({ setStage, setProgress });
        op.result = result ?? null;
        // 文件流最后一个进度事件可能在最后几百 bytes 到达前就结束观察；
        // 成功是唯一可以把已知总量归一到 100% 的事实，不按时间补数。
        if (op.progress_precision === 'bytes' && Number.isFinite(op.bytes_total)
          && op.bytes_total > 0) {
          op.bytes_done = op.bytes_total;
          op.progress = 100;
        }
        op.state = COMPLETE;
        op.stage = 'done';
      } catch (error) {
        op.error = String(error?.message ?? error);
        op.error_code = error?.code ?? null;
        op.state = FAILED;
      } finally {
        op.updated_at_ms = this.now();
        this.#persist();
        if (this.inFlight.get(key) === op.operation_id) this.inFlight.delete(key);
        this.onChange(op);
      }
    })();
  }

  /** Resume a persisted Package download/update after the service restarts. */
  resume(id, run) {
    const op = this.get(id);
    if (!op || TERMINAL.has(op.state) || op.resumable !== true) return { ok: false, error: 'operation_not_resumable' };
    const key = this.key(op.action, op.asset_id);
    const existing = this.inFlight.get(key);
    if (existing && existing !== id) return { ok: false, error: 'operation_conflict' };
    this.inFlight.set(key, id);
    this.#launch(op, key, run, op.stages ?? STAGES);
    return { ok: true, operation: op };
  }

  /** Mark a persisted operation failed when its requested work is no longer available. */
  fail(id, error, code = 'operation_resume_failed') {
    const op = this.get(id);
    if (!op || TERMINAL.has(op.state)) return op ?? null;
    op.error = String(error?.message ?? error ?? 'operation resume failed');
    op.error_code = error?.code ?? code;
    op.state = FAILED;
    this.#touch(op);
    const key = this.key(op.action, op.asset_id);
    if (this.inFlight.get(key) === id) this.inFlight.delete(key);
    return op;
  }

  get(id) { return this.list.find((o) => o.operation_id === id) ?? null; }

  active() { return this.list.filter((o) => !TERMINAL.has(o.state)); }

  pending() { return this.list.filter((o) => !TERMINAL.has(o.state) && o.resumable === true); }

  snapshot(limit = 20) {
    return {
      active: this.active().length,
      operations: this.list.slice(0, limit),
    };
  }
}
