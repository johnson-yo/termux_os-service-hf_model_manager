/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework Core 的 `/api/assets*`、`/api/packages`，凭 loader 注入的 System Key
 * [OUTPUT]: 已安装事实（inventory / resolve / verify）与资产生命周期动作（provider / fetch / restore / drop）
 * [POS]: 三类权威里的 **本机**。⭐ Framework 的资产账本仍然是「装了什么」的唯一真相，
 *        本包**不另造第二套已安装事实**。
 *
 * ⛔ 这里不实现 sha256、不实现 `.part`、不实现原子 rename、不实现 target 比较、不实现磁盘预检——
 *   那五样 Framework 都已经做对了，复制一份只会得到两个会各自漂移的版本。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class FrameworkAssets {
  constructor({
    base = process.env.TERMUX_OS_FRAMEWORK_URL || '',
    key = process.env.TERMUX_OS_SYSTEM_KEY || '',
    fetchImpl = fetch,
    timeoutMs = 20_000,
  } = {}) {
    this.base = base;
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
  }

  get configured() { return Boolean(this.base && this.key); }

  async call(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    if (!this.configured) throw new Error('no Framework credentials in the environment');
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  /**
   * 全部已登记资产。⚠ 读不到时返回 `available:false` 而不是空列表：
   * 「没有装任何资产」与「问不到」是两个完全不同的结论，压成一个会让 UI 说谎。
   */
  async inventory() {
    try {
      const r = await this.call('/api/assets');
      if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
      this.lastError = null;
      const assets = r.data.assets ?? r.data.value ?? [];
      return { available: true, assets: Array.isArray(assets) ? assets : Object.values(assets) };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, assets: [] };
    }
  }

  /**
   * 单个资产的解析结果。⭐ target 匹配、文件存在性、（可选）逐档 sha256 全部由 Framework 做。
   * `verify:true` 会重算校验和——几百 MB 要数十秒，故只在显式要求时用。
   */
  async describe(id, { verify = false } = {}) {
    try {
      const r = await this.call(`/api/assets/${encodeURIComponent(id)}${verify ? '?verify=1' : ''}`,
        { timeoutMs: verify ? 180_000 : this.timeoutMs });
      this.lastError = null;
      return { available: true, status: r.status, asset: r.data.asset ?? r.data.value ?? r.data };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError };
    }
  }

  /** 装上提供这个 asset 的那个包。⭐ 调用方只说得出 asset id，由 Framework 查目录。 */
  installProvider(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/provider`, { method: 'POST', body: {}, timeoutMs: 600_000 });
  }

  /** 取按需 payload。⚠ Framework 这条是**同步阻塞**的，故只许在 operation 线程里调。 */
  fetchPayload(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/fetch`, { method: 'POST', body: {}, timeoutMs: 3_600_000 });
  }

  /** 逻辑模型删除后恢复包随附资产；Framework 会要求 model.* + deactivated=1。 */
  restorePayload(id, logicalModelId) {
    const query = `?logical_model_id=${encodeURIComponent(logicalModelId)}&deactivated=1`;
    return this.call(`/api/assets/${encodeURIComponent(id)}/restore${query}`, {
      method: 'POST', body: {}, timeoutMs: 3_600_000,
    });
  }

  /** 读取 Framework 维护的当前/最近一次真实文件流进度；没有任务时返回 progress:null。 */
  fetchProgress(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/fetch/progress`, { timeoutMs: 10_000 });
  }

  /**
   * Ask Framework to abort only a fetch whose byte stream has gone stale.
   * A recent worker remains authoritative; this is not a force-download path.
   */
  reconcileFetch(id, { staleAfterMs = 120_000 } = {}) {
    const query = `?stale_after_ms=${encodeURIComponent(staleAfterMs)}`;
    return this.call(`/api/assets/${encodeURIComponent(id)}/fetch/reconcile${query}`, {
      method: 'POST', body: {}, timeoutMs: 20_000,
    });
  }

  /** ⛔ 普通删除只适用于按需资产；包随附资产走受限的逻辑模型删除。 */
  dropPayload(id) {
    return this.call(`/api/assets/${encodeURIComponent(id)}/payload`, { method: 'DELETE', timeoutMs: 120_000 });
  }

  /** 仅由 Manager 在 App 已确认 inactive 后调用；不放开通用 payload 删除守卫。 */
  dropLogicalPayload(id, logicalModelId) {
    const query = `?logical_model_id=${encodeURIComponent(logicalModelId)}&deactivated=1`;
    return this.call(`/api/assets/${encodeURIComponent(id)}/payload/logical-model${query}`, {
      method: 'DELETE', timeoutMs: 120_000,
    });
  }

  /**
   * Request a generic Framework service restart after a logical model changes.
   * Manager names the consumer service only; it never knows residents, graph
   * ids, or speech internals. Framework preserves the consumer's desired state
   * while restarting it, so this is a refresh seam rather than a new event bus.
   */
  restartService(id = 'termux-speech') {
    return this.call(`/api/stage/services/${encodeURIComponent(id)}/restart`, {
      method: 'POST', body: {}, timeoutMs: 120_000,
    });
  }

  /** 已装包的 manifest —— 声明式 reference 的来源。 */
  async packages() {
    try {
      const r = await this.call('/api/packages');
      if (!r.ok) throw new Error(r.data?.error || `HTTP ${r.status}`);
      return { available: true, packages: r.data.packages ?? [] };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'framework_unavailable', detail: this.lastError, packages: [] };
    }
  }

  /**
   * ⭐ 从**已安装根目录**直接读全部 manifest。
   *
   * 为什么不走 HTTP：真机实测 `/api/packages` 要 **11.8 秒**、
   * `/api/packages/<id>` 要 **6.1 秒**，而 Framework 是单进程 Node——
   * 十个包就是一分钟，并行也没用（请求全排在同一个事件循环后面，还会堵住别人）。
   * 这里读的是 Framework 自己也在读的**同一份文件**，不是第二个真相源；
   * ⚠ 读不到就回落 HTTP，绝不假装没有包。
   */
  manifestsFromDisk() {
    const root = process.env.PACKAGES_INSTALLED_DIR
      || path.join(os.homedir(), '.termux-os', 'packages');
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return null; }
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      try {
        const active = JSON.parse(fs.readFileSync(path.join(root, d.name, 'active.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(
          path.join(root, d.name, 'versions', active.active_version, 'termux-os.package.json'), 'utf8'));
        out.push({ id: d.name, manifest });
      } catch { /* 半装好的目录跳过；它本来也不该被算作消费方 */ }
    }
    return out;
  }

  async packageManifest(id) {
    try {
      const r = await this.call(`/api/packages/${encodeURIComponent(id)}`);
      return r.ok ? (r.data.package?.manifest ?? null) : null;
    } catch { return null; }
  }

  snapshot() {
    return { base: this.base || null, configured: this.configured, last_error: this.lastError };
  }
}
