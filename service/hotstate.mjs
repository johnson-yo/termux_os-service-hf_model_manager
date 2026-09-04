/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 三个 refresh 函数（inventory / catalog / declared），各自的 TTL
 * [OUTPUT]: 一个**永远立刻可读**的快照 + 每一层各自的新鲜度
 * [POS]: ⭐ 热状态与远端刷新解耦。
 *
 * 为什么必须这样：参考机上 Framework 的 `GET /api/assets` 要 **12.5 秒**、
 * `/api/packages` 要 **28.3 秒**（冷热一样，它不缓存）。只要 `/live` 在缓存未命中时
 * 同步去打它们，这个端点就会周期性地变成数秒级——而一个数秒级的端点不适合做 feed 源，
 * 轮询会首尾相接地叠起来。
 *
 * ⛔ 读接口**永不等待远端**。刷新在后台按 TTL 进行；读到的可能是旧的，
 *   但旧到什么程度是**说出来的**（`age_ms` / `stale` / `known`）。
 * ⚠ 陈旧数据不标记地返回，比慢更糟：它让人以为自己看到的是此刻。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 一层缓存：知道自己多久没更新过、上次成功没有、正在刷新吗。 */
export class Layer {
  constructor(name, refresh, {
    ttlMs = 60_000, staleAfterMs = null, now = () => Date.now(),
    probe = null, minIntervalMs = 3_000, backstopMs = null, accepted = null,
  } = {}) {
    this.name = name;
    this.refresh = refresh;
    this.ttlMs = ttlMs;
    /** 超过这个岁数就标 stale（缺省 = 3×TTL）。⚠ 与「该刷新了」不是一回事。 */
    this.staleAfterMs = staleAfterMs ?? ttlMs * 3;
    this.now = now;
    /**
     * ⭐ **先看一眼，再决定问不问。** `probe()` 返回一个便宜的变化指纹
     * （例如账本文件的 mtime+size）。有它的时候，刷新由**事实变化**驱动而不是由时钟驱动：
     *   指纹变了 ⇒ 立刻刷（比定时器快）；没变 ⇒ 不打远端（比定时器省）。
     *
     * ⚠ 为什么这条重要：Framework 是**单进程** Node。后台每 30 秒打一次它的
     *   `GET /api/assets`（参考机 12.5 秒），期间**任何**经由 Framework 的请求都排在后面——
     *   于是「把等待从读路径挪走」并没有把等待从**共享的那一个线程**上挪走。
     *   真机实测：改造后 `/live` 中位数 16 ms，但仍有 0.36–1.81 s 的尖峰，全部落在刷新窗口里。
     * ⚠ `backstopMs` 是兜底：指纹之外的变化（例如有人手工删了盘上的文件）照样要被发现。
     */
    this.probe = probe;
    /**
     * ⭐ 「取到了」不等于「取成功了」。
     *
     * 本包的远端适配器**刻意不抛异常**——拿不到就返回 `{available:false}` 的降级值，
     * 好让上层区分「不知道」与「没有」。但对**指纹**来说这是个陷阱：
     * 一次降级的读取如果被当成成功，指纹就被消费掉了，而我们其实什么都没读到，
     * 于是这一层会一直卡在空值上，直到 5 分钟后的 backstop 才重试。
     *
     * ⚠ 这不是假想：真机上 Framework 重启后本服务先起来，第一次 inventory 读到
     *   `available:false`，页面于是显示 **installed=0**、25 个「未纳管」目录——
     *   资产一个都没丢，只是**我们把一次失败记成了一次成功**。
     *   `stale:true` 是唯一说了实话的字段。
     * ⛔ 所以：只有 `accepted(value)` 为真的读取才算把指纹消费掉。
     */
    this.accepted = accepted;
    this.minIntervalMs = minIntervalMs;
    this.backstopMs = backstopMs ?? ttlMs * 10;
    this.lastProbeKey = null;
    this.value = null;
    this.updatedAtMs = null;
    this.lastError = null;
    this.lastAccepted = null;
    this.inFlight = null;
  }

  /** ⚠ probe 自己出错不许让刷新逻辑崩：拿不到指纹就当它变了（宁可多问一次）。 */
  probeKey() { if (!this.probe) return null; try { return this.probe(); } catch { return `probe-error-${this.now()}`; } }

  get ageMs() { return this.updatedAtMs === null ? null : this.now() - this.updatedAtMs; }
  get known() { return this.value !== null; }
  get stale() { return this.updatedAtMs === null || this.ageMs > this.staleAfterMs; }

  get due() {
    if (this.updatedAtMs === null) return true;
    const age = this.ageMs;
    if (!this.probe) return age >= this.ttlMs;
    if (age < this.minIntervalMs) return false;                 // 防抖：变化再密也不连打
    if (this.probeKey() !== this.lastProbeKey) return true;     // 变了就立刻刷
    return age >= this.backstopMs;                              // 没变就只留一个兜底
  }

  /** ⭐ 同一层同时只有一次刷新在飞——重复触发返回同一个 promise。 */
  async update({ force = false } = {}) {
    if (!force && !this.due) return this.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      /** ⚠ 指纹要在**取之前**记下：取的过程中账本又变了，那一次变化不能被这次刷新吞掉。 */
      const keyBefore = this.probeKey();
      try {
        const next = await this.refresh();
        this.value = next;
        this.updatedAtMs = this.now();
        const ok = this.accepted ? Boolean(this.accepted(next)) : true;
        // ⛔ 失败的读取不消费指纹，下一轮还会再试（受 minIntervalMs 防抖）。
        this.lastProbeKey = ok ? keyBefore : null;
        this.lastAccepted = ok;
        this.lastError = ok ? null : (this.lastError ?? 'refresh returned an unusable value');
        return next;
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        /** ⛔ 刷新失败不清空旧值：一次网络抖动不该让整页变空。 */
        return this.value;
      } finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }

  snapshot() {
    return {
      known: this.known,
      /** ⭐ 说清楚这一层是被什么驱动的——定时器还是事实变化。 */
      driven_by: this.probe ? 'change-probe' : 'ttl',
      /** ⚠ 上一次读取算不算数——`known:true` 而 `usable:false` 是真实存在的状态。 */
      usable: this.lastAccepted !== false,
      age_ms: this.ageMs,
      stale: this.stale,
      updated_at_ms: this.updatedAtMs,
      last_error: this.lastError,
      refreshing: this.inFlight !== null,
    };
  }
}

/**
 * 后台刷新器。⚠ 用 `unref()`：一个定时器不该让进程退不掉。
 */
export class Refresher {
  constructor(layers, { intervalMs = 5_000 } = {}) {
    this.layers = layers;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const tick = () => { for (const l of this.layers) void l.update(); };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
