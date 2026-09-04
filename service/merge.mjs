/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 三类权威各自的原始答案：registry 项目、upstream 元数据、本机资产条目
 * [OUTPUT]: 一个业务友好的 asset 视图 + 更新状态三分法
 * [POS]: ⭐ **纯函数，没有 IO**。三类权威的边界是这个包最重要的一条规则，
 *        它必须能在毫秒级被证伪，而不是等到某台设备上出现一个说不清来源的字段。
 *
 * ⛔ 三类事实**永不压平**：输出里恒有 `registry` / `upstream` / `local` 三个子结构，
 *   每个字段都能指回它是谁说的。压平之后，「本机装的是 1.0.0」与「上游有个新 commit」
 *   会变成同一个 `version` 字段，而它们的可信度完全不同。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { compareSemver, comparable, isSemver } from './cf.mjs';

export const UP_TO_DATE = 'up_to_date';
export const APPROVED_UPDATE = 'approved_update_available';
export const UPSTREAM_UNAPPROVED = 'upstream_changed_unapproved';
export const NOT_INSTALLED = 'not_installed';
export const UNKNOWN = 'unknown';

/**
 * ⭐ 更新状态三分法。
 *
 * 判据的顺序本身就是规则：
 *   ① 只有 **Registry 里存在更高的已批准版本** 才叫「可更新」——
 *      那是唯一一个有人审过、带 sha256、能被完整性校验的东西。
 *   ② 上游动了但 Registry 没有新版本 ⇒ `upstream_changed_unapproved`。
 *      它是**提示**，不是动作；把它显示成「可更新」就等于邀请使用者去装一个没有校验值的 HEAD。
 *   ③ 两者都没有 ⇒ up_to_date。
 * ⚠ 缺少信息时返回 `unknown`，⛔ 不返回 `up_to_date` —— 后者是一个断言，
 *   而我们此刻并没有做出这个断言的依据。
 */
export const updateState = ({ localVersion, registryLatest, registryRevision, upstreamCommit }) => {
  if (!localVersion) return NOT_INSTALLED;
  if (!registryLatest) return UNKNOWN;
  /**
   * ⭐ **只有两边同为 semver 才谈「更新」。**
   *
   * ⚠ 真机实读：HF asset 的 `registryLatest` 是 **commit SHA**，而 `localVersion` 是**包版本**。
   *   旧代码把它们送进 `compareSemver`，后者在解析失败时落到 `localeCompare` —— 
   *   于是「有没有新版本」这个问题被一个字符串序静默地回答了，⛔ 不报错、⛔ 也不对。
   * ⭐ 不可比时返回 `unknown`，⛔ 不返回 `up_to_date`：后者是一个断言，
   *   而我们此刻并没有做出这个断言的依据（与本文件下面那条注释同一条规矩）。
   */
  if (comparable(registryLatest, localVersion)) {
    if (compareSemver(registryLatest, localVersion) > 0) return APPROVED_UPDATE;
  } else if (isSemver(registryLatest) !== isSemver(localVersion)) {
    // 一边 semver 一边 revision：两个命名空间，⛔ 无从比较。
    return UNKNOWN;
  } else if (registryLatest !== localVersion) {
    /**
     * 两边都是 revision：⭐ 只能谈**相等**。不同 ⇒ 目录里批准的是另一份字节，
     * 那确实是一个可安装的新东西（⛔ 但它不是「更高版本」，只是「不是同一个」）。
     */
    return APPROVED_UPDATE;
  }
  if (registryRevision && upstreamCommit && upstreamCommit !== registryRevision) {
    return UPSTREAM_UNAPPROVED;
  }
  return UP_TO_DATE;
};

/**
 * 本机账本条目 → `local` 子结构。
 *
 * ⚠ 拿不到账本时是 `unknown`，不是「没装」。
 * ⭐ **「被声明」不等于「已安装」。** Framework 的 `/api/assets` 列出的是**全部已声明**的资产，
 *   包括可选的、还没取下来的那些（`ready:false, version:null, path:null`）。
 *   把「列表里有这一条」当成已安装，会在同一行里同时出现 `installed:true` 与
 *   `update_state:not_installed` —— 两个字段互相打脸，而每一个单看都像是对的。
 *   判据是**盘上有没有一个已知位置**：`path`。
 */
export const localView = (entry, { frameworkAvailable = true } = {}) => {
  if (!frameworkAvailable) return { known: false, reason: 'framework_unavailable' };
  if (!entry) return { known: true, declared: false, installed: false };
  return {
    known: true,
    declared: true,
    installed: Boolean(entry.path),
    provider_package: entry.package_id ?? entry.package ?? null,
    version: entry.version ?? null,
    target: entry.target ?? null,
    path: entry.path ?? null,
    files: entry.files ?? null,
    activated_at: entry.activated_at ?? null,
    fetched_on_demand: entry.fetched_on_demand === true,
    ready: entry.ready ?? null,
    reason: entry.reason ?? null,
  };
};

/**
 * 合并一个 asset id 的三方视图。
 *
 * @param assetId    业务方唯一认得的键
 * @param project    registry 归一化项目（可为 null = registry 不可用或没登记）
 * @param upstream   HF adapter 的结果（可为 null / available:false）
 * @param localEntry Framework 账本条目（可为 null = 未安装）
 */
export const mergeAsset = (assetId, { project = null, upstream = null, localEntry = null,
  frameworkAvailable = true, registryAvailable = true } = {}) => {
  const local = localView(localEntry, { frameworkAvailable });
  const latest = project?.latest ?? null;
  const state = !frameworkAvailable
    ? UNKNOWN
    : updateState({
      localVersion: local.installed ? local.version : null,
      registryLatest: registryAvailable ? latest?.version ?? null : null,
      registryRevision: latest?.revision ?? null,
      upstreamCommit: upstream?.available ? upstream.latest_commit ?? null : null,
    });

  return {
    asset_id: assetId,
    /**
     * ⭐ **source 来自 registry 的字段，绝不从 package id 前缀猜。**
     * 历史包 id 写着 `github.termux-os.asset.campplus`，而它的 descriptor 与 payload
     * 都在 Hugging Face —— 按前缀显示就会当着使用者的面说错话。
     */
    source: project?.source ?? null,
    repository: project?.repository ?? null,
    display_name: project?.display_name ?? null,
    update_state: state,
    registry: registryAvailable
      ? (project
        ? {
          known: true,
          /**
           * `known` 表示这个 asset 能回接到一个已批准的项目；`listed` 则回答更窄的
           * 问题：它是否出现在该项目最新 package index 的 provides，或能以精确的
           * source 文件坐标在项目的已批准 payload 记录中找到。两者不能压成一个布尔值。
           */
          listed: project.asset_listed !== false,
          package_id: project.package_id,
          approved_version: latest?.version ?? null,
          approved_revision: latest?.revision ?? null,
          published_at: latest?.published_at ?? null,
          total_bytes: latest?.total_bytes ?? null,
          files: latest?.files ?? [],
        }
        : { known: true, listed: false })
      : { known: false, reason: 'registry_unavailable' },
    upstream: upstream?.available
      ? {
        known: true,
        exists: upstream.exists !== false,
        latest_commit: upstream.latest_commit ?? null,
        last_modified: upstream.last_modified ?? null,
        license: upstream.license ?? null,
        tags: upstream.tags ?? [],
        file_count: (upstream.files ?? []).length || null,
      }
      : { known: false, reason: upstream?.error ?? 'upstream_unavailable' },
    local,
  };
};

/** UI 用的一句话。⚠ 只由这一个地方生成，页面不再各拼一份。 */
export const updateLabel = (state) => ({
  [UP_TO_DATE]: '已是最新',
  [APPROVED_UPDATE]: '有可安装的新版本',
  [UPSTREAM_UNAPPROVED]: '上游有改动（尚未审核批准）',
  [NOT_INSTALLED]: '未安装',
  [UNKNOWN]: '未知',
}[state] ?? '未知');
