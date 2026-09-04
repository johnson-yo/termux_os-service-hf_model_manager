/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个数据目录
 * [OUTPUT]: `ModelStateStore` —— 每个 logical model 在**这台机器上**的下载/启用事实
 * [POS]: docs/092 §7–§8。⭐ 这是 Manager 唯一新增的持久层，**一个 model 一个小 JSON**，
 *        ⛔ 不引数据库、⛔ 不把 App 的 runtime 状态复制进来。
 *
 * ⭐ 它回答的是三类权威都答不了的那个问题：
 *   Registry 说「哪个版本被批准」、HF 说「上游此刻什么样」、Framework 账本说「盘上有什么文件」——
 *   **没有一个说得出「这台机器上这个模型现在能不能跑」**。那正是 `enabled` 的含义。
 *
 * ⚠ `enabled` 是**「最近一次被 App verify 成功」**，⛔ 不是一个永久保证（§29）：
 *   App 升级、QNN 换版、OTA 之后它可能不再成立。真正开始用的时候 runtime 仍有自己的 readiness，
 *   ⛔ 不许因为这里写着 enabled 就跳过那一步。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'termux-os.model-state.v1';

export const NOT_DOWNLOADED = 'not_downloaded';
export const DOWNLOADING = 'downloading';
export const DOWNLOADED = 'downloaded';
export const PREPARING = 'preparing';
export const ENABLED = 'enabled';
export const FAILED = 'failed';

export const KIND_PREBUILT = 'prebuilt';
export const KIND_LOCAL = 'local';

/** Pure read-back predicate used by Manager and unit tests. It deliberately
 * checks paths/roles, not filesystem bytes: Framework owns asset-file truth and
 * App owns executable verification. */
export const preparedBundleComplete = (state, {
  modelVersion = null, executablePath = null, requiredRoles = [],
} = {}) => {
  const prepared = state?.prepared;
  if (state?.state !== ENABLED || !prepared?.executable?.path
    || (executablePath !== null && prepared.executable.path !== executablePath)) return false;
  if (modelVersion !== null && prepared.model_version !== null
    && String(prepared.model_version) !== String(modelVersion)) return false;
  return requiredRoles.every((role) => typeof prepared.companions?.[role]?.path === 'string'
    && prepared.companions[role].path.length > 0);
};

/** 文件名安全化：model id 直接当文件名，⛔ 不许它带路径分隔符出去。 */
const fileFor = (dir, modelId) =>
  path.join(dir, `${String(modelId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

const emptyState = (modelId) => ({
  schema: SCHEMA,
  model_id: modelId,
  model_version: null,
  state: NOT_DOWNLOADED,
  download: null,
  executable: null,
  /**
   * ⭐ 一个可运行的模型不是只有一个 CTX 文件：FireRedVAD 还需要 cmvn，
   * SenseVoice 需要 frontend。`executable` 保留为 v1 旧字段的镜像；新的
   * 消费契约全部落在这里，且一次 `write()` 原子提交。
   */
  prepared: null,
  diagnostics: {
    target_htp: null,
    target_qnn: null,
    last_failure_stage: null,
    last_error: null,
    last_attempt_at: null,
  },
  updated_at: null,
});

export class ModelStateStore {
  constructor({ dir, now = () => Date.now() }) {
    this.dir = dir;
    this.now = now;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 首次写时会再报 */ }
  }

  read(modelId) {
    try {
      const raw = JSON.parse(fs.readFileSync(fileFor(this.dir, modelId), 'utf8'));
      if (raw?.schema !== SCHEMA) return emptyState(modelId);
      return { ...emptyState(modelId), ...raw };
    } catch {
      return emptyState(modelId);
    }
  }

  /**
   * 原子写。⭐ 先写 `.tmp` 再 rename——⛔ 崩在中途绝不留下一个「读得出来但内容是半截」的
   * 状态文件；而这个文件的全部意义就是「下次启动能相信它」。
   */
  write(modelId, patch) {
    const next = { ...this.read(modelId), ...patch, updated_at: new Date(this.now()).toISOString() };
    const file = fileFor(this.dir, modelId);
    const tmp = `${file}.tmp`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return next;
  }

  list() {
    let names;
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); }
    catch { return []; }
    return names.map((n) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
        return raw?.schema === SCHEMA ? raw : null;
      } catch { return null; }
    }).filter(Boolean);
  }

  // ── 生命周期动作 ─────────────────────────────────────────────────────

  /**
   * ⭐ **删除模型时必须让 state 一起失效**（docs/094 §11）。
   *
   * ⚠ 只删文件而留下 `enabled` 记录，会造出一个最坏的状态：
   *   页面写着「已启用」、`resolve` 交出一条指向**已经不存在的文件**的路径，
   *   而消费方要到真的去加载时才会失败 —— 那时错误已经离开这里很远了。
   * ⭐ 归零用**整文件重写**，⛔ 不是 `write(patch)`：patch 会把
   *   `executable` / `diagnostics` 这些旧字段留在原地。
   */
  forget(modelId) {
    const file = fileFor(this.dir, modelId);
    const tmp = `${file}.tmp`;
    const next = { ...emptyState(modelId), updated_at: new Date(this.now()).toISOString() };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return next;
  }

  noteDownloaded(modelId, { modelVersion, kind, assetId, path: artifactPath }) {
    return this.write(modelId, {
      model_version: modelVersion ?? null,
      state: DOWNLOADED,
      download: {
        kind, asset_id: assetId, path: artifactPath ?? null,
        downloaded_at: new Date(this.now()).toISOString(),
      },
      // A successful retry clears the old fetch failure diagnosis; otherwise
      // Settings keeps showing `already_fetching` after the model is healthy.
      diagnostics: {
        ...this.read(modelId).diagnostics,
        last_failure_stage: null,
        last_error: null,
        last_attempt_at: new Date(this.now()).toISOString(),
      },
    });
  }

  notePreparing(modelId, { modelVersion } = {}) {
    return this.write(modelId, {
      ...(modelVersion ? { model_version: modelVersion } : {}),
      state: PREPARING,
      diagnostics: { ...this.read(modelId).diagnostics, last_attempt_at: new Date(this.now()).toISOString() },
    });
  }

  /**
   * ⭐ **只有这一处能把状态写成 enabled**，而调用它的前提是 App 已经
   * load + minimal inference 都成功了（§16 的五步里的第四步）。
   * ⚠ 它必须在**删除 source ONNX 之前**成功落盘：写失败时源文件必须还在。
   */
  noteEnabled(modelId, {
    modelVersion, kind, artifactPath, derivedFrom = null, target = {}, companions = {},
  }) {
    const executable = {
      kind,
      path: artifactPath,
      derived_from: derivedFrom,
      verified_at: new Date(this.now()).toISOString(),
    };
    const preparedCompanions = Object.fromEntries(
      Object.entries(companions ?? {})
        .map(([role, value]) => {
          const item = typeof value === 'string' ? { path: value } : value;
          if (!item?.path) return [role, null];
          return [role, {
            role,
            path: item.path,
            kind: item.kind ?? 'asset',
            ...(item.asset_id ? { asset_id: item.asset_id } : {}),
            ...(item.ownership ? { ownership: item.ownership } : {}),
            ...(item.shared === true ? { shared: true } : {}),
          }];
        })
        .filter(([, value]) => value !== null),
    );
    const prepared = {
      model_version: modelVersion ?? null,
      executable,
      companions: preparedCompanions,
    };
    return this.write(modelId, {
      ...(modelVersion ? { model_version: modelVersion } : {}),
      state: ENABLED,
      // Legacy mirror: old Manager UI and old state readers still get the same answer.
      executable,
      prepared,
      diagnostics: {
        ...this.read(modelId).diagnostics,
        target_htp: target?.htp ?? null,
        target_qnn: target?.qnn ?? null,
        last_failure_stage: null,
        last_error: null,
      },
    });
  }

  noteFailed(modelId, { stage, error, clearPrepared = false }) {
    return this.write(modelId, {
      state: FAILED,
      ...(clearPrepared ? { executable: null, prepared: null } : {}),
      diagnostics: {
        ...this.read(modelId).diagnostics,
        last_failure_stage: stage ?? null,
        last_error: error ?? null,
        last_attempt_at: new Date(this.now()).toISOString(),
      },
    });
  }

  /** source 被删除之后调用：executable 仍然有效，只是下载记录不再指向源文件。 */
  noteSourceRemoved(modelId) {
    const cur = this.read(modelId);
    if (!cur.download) return cur;
    return this.write(modelId, { download: { ...cur.download, removed_at: new Date(this.now()).toISOString() } });
  }

  /**
   * ⭐ **启动对赈**（§8）：`preparing` 是一个只能由**正在运行的作业**持有的状态。
   * 重新加载之后没有任何作业还在跑 ⇒ 它一定是被打断的，必须变成可重试的 `failed`，
   * ⛔ 绝不能永久卡在「准备中」——那是一个使用者点不动、也看不懂的死状态。
   */
  reconcile({ activeModelIds = [] } = {}) {
    const active = new Set(activeModelIds);
    const recovered = [];
    for (const s of this.list()) {
      if (s.state !== PREPARING || active.has(s.model_id)) continue;
      this.noteFailed(s.model_id, {
        stage: 'interrupted',
        error: '准备过程被中断（服务重启或进程退出）；已下载的资源仍在，可以直接重试。',
      });
      recovered.push(s.model_id);
    }
    return { recovered };
  }
}
