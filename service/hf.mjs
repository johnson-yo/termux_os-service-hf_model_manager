/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `https://huggingface.co/api/models/<repo>`（公开 repo，无凭证）
 * [OUTPUT]: `describe(repo)` —— 上游此刻的样子：latest commit、修改时间、license、tags、文件表
 * [POS]: 三类权威里的 **上游**。它是唯一知道「原作者动没动过」的人。
 *
 * ⛔ **它说的不是「可以更新」。** HF 的 HEAD 比我们登记的 revision 新，只说明上游变了；
 *   能不能装取决于 Registry 有没有批准一个更高的版本。把两者混成一个布尔，
 *   就等于允许任何人把一个没人审过、没有 sha256 的 HEAD 装成正式资产。
 * ⚠ HF **不提供 sha256**：LFS 文件给的是 `oid`/`x-linked-etag`（恰好等于 sha256），
 *   普通小文件给的是 git blob sha1。所以 size 可以参考，校验值必须来自 Registry。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const HF_API = 'https://huggingface.co/api/models';

const normalize = (repo, d) => ({
  repo,
  exists: true,
  /** 上游此刻的 commit。⚠ 与我们登记的 revision 是两个东西。 */
  latest_commit: typeof d?.sha === 'string' ? d.sha : null,
  last_modified: d?.lastModified ?? null,
  private: d?.private === true,
  license: (d?.cardData ?? {})?.license ?? null,
  tags: Array.isArray(d?.tags) ? d.tags : [],
  downloads: Number.isFinite(Number(d?.downloads)) ? Number(d.downloads) : null,
  likes: Number.isFinite(Number(d?.likes)) ? Number(d.likes) : null,
  files: (d?.siblings ?? []).map((s) => ({
    path: s?.rfilename ?? null,
    // ⚠ 只有带 `?blobs=true` 才有 size；没有就如实 null，⛔ 不填 0
    size: Number.isFinite(Number(s?.size)) ? Number(s.size) : null,
  })),
});

export class HuggingFaceAdapter {
  constructor({ api = HF_API, fetchImpl = fetch, timeoutMs = 15_000, ttlMs = 10 * 60_000 } = {}) {
    this.api = api;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    /** repo → { at, value }。⚠ 上游元数据不是热数据，每次开页面都去打一次是浪费。 */
    this.cache = new Map();
    this.lastError = null;
  }

  async describe(repo, { blobs = false, force = false } = {}) {
    const key = `${repo}|${blobs ? 'blobs' : 'plain'}`;
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return { ...hit.value, cached: true };
    try {
      const url = `${this.api}/${repo}${blobs ? '?blobs=true' : ''}`;
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status === 404) {
        const miss = { repo, exists: false, available: true };
        this.cache.set(key, { at: Date.now(), value: miss });
        return miss;
      }
      if (!response.ok) throw new Error(`HF HTTP ${response.status}`);
      const value = { ...normalize(repo, await response.json()), available: true };
      this.cache.set(key, { at: Date.now(), value });
      this.lastError = null;
      return value;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      /**
       * ⚠ 上游读不到**不是错误状态**，只是少了一类信息。
       * 返回 `available:false` 而不是抛——Registry 的已批准版本仍然应该能装。
       */
      if (hit) return { ...hit.value, available: false, stale: true, error: this.lastError };
      return { repo, available: false, error: 'upstream_unavailable', detail: this.lastError };
    }
  }

  snapshot() { return { api: this.api, cached_repos: this.cache.size, last_error: this.lastError }; }
}

export const __test = { normalize };
