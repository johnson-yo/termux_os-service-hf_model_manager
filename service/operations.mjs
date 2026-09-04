/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个 async 执行体 + 它自报的阶段
 * [OUTPUT]: `queued → running → verifying → complete|failed` 的可查询作业，及真实字节/阶段进度
 * [POS]: ⭐ Framework 的按需取是**同步阻塞 HTTP**（真机实测 14.7 MB 阻塞 35.4 秒，
 *        1 GB 会阻塞十几分钟）。业务 package 不能被一次下载卡住几分钟，
 *        所以这里把它包成作业：立刻回 202 + operation_id，之后轮询。
 *
 * ⚠ **不伪造进度。** 下载的 bytes_done/bytes_total 只接受 Framework 文件流的真实值；
 *   准备动作的百分比只由真实 stage 映射，绝不按时间自增。
 * [PROTOCOL]: 纯状态机（无 IO，可毫秒级单测）。变更时更新此头部，然后检查 CLAUDE.md
 */

import crypto from 'node:crypto';

export const QUEUED = 'queued';
export const RUNNING = 'running';
export const VERIFYING = 'verifying';
export const COMPLETE = 'complete';
export const FAILED = 'failed';
export const TERMINAL = new Set([COMPLETE, FAILED]);

export const STAGES = Object.freeze([
  'resolving', 'downloading', 'verifying',
  'validate_input', 'release_runtime', 'load_prebuilt', 'compile', 'load_generated',
  'inference_verify', 'restore_runtime', 'done',
]);

export class Operations {
  constructor({ keep = 50, now = () => Date.now() } = {}) {
    this.keep = keep;
    this.now = now;
    this.list = [];
    /** `${action}|${assetId}` → operation_id。⭐ 同一件事不许排两次队。 */
    this.inFlight = new Map();
    this.onChange = () => {};
  }

  #touch(op) { op.updated_at_ms = this.now(); this.onChange(op); }

  key(action, assetId) { return `${action}|${assetId}`; }

  /**
   * 起一个作业。⭐ 同一个 (action, asset) 已在飞 ⇒ **返回那一个**，不新建。
   * 重复点「下载」应该看到同一条进度，而不是并排两条互相覆盖的下载。
   */
  start(action, assetId, run, { bytesTotal = null, progressPrecision = null, stages = STAGES } = {}) {
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
      result: null,
    };
    this.list.unshift(op);
    while (this.list.length > this.keep) this.list.pop();
    this.inFlight.set(key, op.operation_id);
    this.#touch(op);

    const setStage = (stage) => {
      if (!stages.includes(stage)) return;
      op.stage = stage;
      op.state = stage === 'verifying' ? VERIFYING : RUNNING;
      this.#touch(op);
    };

    const setProgress = ({ bytesDone, bytesTotal: nextTotal, progress, precision, currentFile } = {}) => {
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
        op.state = FAILED;
      } finally {
        op.updated_at_ms = this.now();
        this.inFlight.delete(key);
        this.onChange(op);
      }
    })();

    return { operation: op, deduplicated: false };
  }

  get(id) { return this.list.find((o) => o.operation_id === id) ?? null; }

  active() { return this.list.filter((o) => !TERMINAL.has(o.state)); }

  snapshot(limit = 20) {
    return {
      active: this.active().length,
      operations: this.list.slice(0, limit),
    };
  }
}
