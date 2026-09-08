/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 服务内部发生的事实变化
 * [OUTPUT]: 一条有界的、带单调游标的事件流（feed capability 的载体）
 * [POS]: Framework 的 feed 契约是**游标端点**（默认 `jsonl-cursor`），不是推送——
 *        `describeCapability` 只返回 `{endpoint, format}`，由消费方自己拉。
 *        ⛔ 所以这里不发明第二套订阅协议，只提供 `?after=<seq>`。
 *
 * ⭐ 有界是硬要求：常驻服务里一个只增不减的数组就是一个慢性内存泄漏。
 * ⚠ 丢弃发生时要**说出来**（`truncated`/`oldest_seq`），否则一个断线太久的消费方
 *   会以为自己拿到了完整历史，而中间那段永远不会再出现。
 * [PROTOCOL]: 纯逻辑，无 IO。变更时更新此头部，然后检查 CLAUDE.md
 */

export const EVENT_TYPES = Object.freeze([
  'inventory_changed',
  'operation_created',
  'operation_stage',
  'operation_completed',
  'operation_failed',
  'source_availability_changed',
]);

export class EventLog {
  constructor({ keep = 200, now = () => Date.now() } = {}) {
    this.keep = keep;
    this.now = now;
    this.seq = 0;
    this.events = [];
    /** 被裁掉的最老那一条的下一个 seq —— 消费方据此知道自己错过了东西。 */
    this.oldestSeq = 1;
  }

  emit(type, data = {}) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type: ${type}`);
    this.seq += 1;
    const event = { seq: this.seq, type, at_ms: this.now(), ...data };
    this.events.push(event);
    while (this.events.length > this.keep) {
      const dropped = this.events.shift();
      this.oldestSeq = dropped.seq + 1;
    }
    return event;
  }

  /**
   * 取 `after` 之后的事件。
   * ⚠ `after < oldestSeq - 1` 表示中间有一段已经被裁掉，必须如实标 `truncated`——
   *   消费方要么接受缺口，要么重新拉一次全量状态。
   */
  since(after = 0, limit = 100) {
    const from = Number.isFinite(Number(after)) ? Math.max(0, Number(after)) : 0;
    const truncated = from > 0 && from < this.oldestSeq - 1;
    const slice = this.events.filter((e) => e.seq > from).slice(0, limit);
    return {
      events: slice,
      cursor: slice.length ? slice.at(-1).seq : Math.max(from, this.seq),
      latest_seq: this.seq,
      oldest_seq: this.oldestSeq,
      truncated,
      more: this.events.some((e) => e.seq > (slice.length ? slice.at(-1).seq : from)),
    };
  }
}
