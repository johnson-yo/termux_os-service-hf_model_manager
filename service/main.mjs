/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: CF registry、Hugging Face API、Framework `/api/assets*`、共享 Model Store
 * [OUTPUT]: 一个 loopback HTTP 服务：catalog / installed / resolve / install / fetch /
 *           verify / update / references / logical model lifecycle / operations / unmanaged / live
 * [POS]: 全系统共用的模型与资产管理服务。⛔ 它不持有任何业务语义——
 *        「CAM++ 缺了要不要关掉助手」永远是消费方的判断。
 *
 * ⭐ 三类权威严格分开（见 merge.mjs）：Registry 说哪个版本被批准、
 *   HF 说上游此刻什么样、Framework 账本说本机装了什么。响应里恒有三个子结构。
 * ⚠ 任何一个远端挂掉都不许让这个服务倒下：已安装的东西必须仍然列得出来。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { RegistryAdapter, DEFAULT_REGISTRY } from './cf.mjs';
import { HuggingFaceAdapter } from './hf.mjs';
import { FrameworkAssets } from './framework.mjs';
import { mergeAsset, updateLabel, APPROVED_UPDATE } from './merge.mjs';
import { ReferenceRegistry, declaredReferences, removalDecision } from './references.mjs';
import { Operations } from './operations.mjs';
import { scanUnmanaged } from './unmanaged.mjs';
import { EventLog } from './events.mjs';
import { Layer, Refresher } from './hotstate.mjs';
import { currentLogicalModels, downloadChoices } from './logical.mjs';
import { userStatus, useBlockedReason, modelSummary, executableCandidates,
  requiredCompanions } from './status.mjs';
import { ModelStateStore, DOWNLOADING, DOWNLOADED, PREPARING, ENABLED, FAILED,
  KIND_PREBUILT, KIND_LOCAL, preparedBundleComplete } from './modelstate.mjs';
import { AppExecutor } from './app.mjs';

const PORT = Number(process.env.PORT || process.env.PORT_HTTP || 0);
const STATUS_FILE = process.env.STATUS_FILE || '';
const DATA_ROOT = process.env.MANAGER_DATA_ROOT || '.runtime-dev/data/hf-model-manager';
const STORE = process.env.SHARED_ASSET_STORE || '/sdcard/termux-os/models';
const REGISTRY_URL = process.env.PACKAGE_REGISTRY_URL || DEFAULT_REGISTRY;
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';

const registry = new RegistryAdapter({ base: REGISTRY_URL });
const upstream = new HuggingFaceAdapter();
const local = new FrameworkAssets();
const references = new ReferenceRegistry({ file: path.join(DATA_ROOT, 'references.v1.json') });
const operations = new Operations();

/**
 * docs/092：logical model 的三样新东西。
 * ⭐ 三者职责严格分开：`app` 只负责跨过那条边，`modelState` 只记事实，
 *   而「哪个 artifact 更适合这台机器」是 `logical.mjs` 的纯函数。
 */
const app = new AppExecutor();
const modelState = new ModelStateStore({ dir: path.join(DATA_ROOT, 'models') });

/** App 的执行画像（htp/qnn）。⭐ 只用于**推荐与诊断**，⛔ 不用于判定兼容。 */
const appLayer = new Layer('app', async () => app.capabilities(), { ttlMs: 120_000 });
const appOf = () => appLayer.value ?? { available: false, target: {}, verifiable_models: [] };

let changeSeq = 0;
const changeSeqBump = () => { changeSeq += 1; };

const events = new EventLog();

/**
 * 作业每次变化都进 feed。⭐ 三种终局分开发（created / stage / completed / failed）——
 * 一个只说「变了」的事件，会让消费方为了知道变成什么而再拉一次全量。
 */
const opStage = new Map();
operations.onChange = (op) => {
  changeSeqBump();
  const seen = opStage.get(op.operation_id);
  const base = { operation_id: op.operation_id, asset_id: op.asset_id, action: op.action,
    state: op.state, stage: op.stage };
  if (!seen) events.emit('operation_created', base);
  else if (op.state === 'complete') events.emit('operation_completed', { ...base, result: op.result });
  else if (op.state === 'failed') events.emit('operation_failed', { ...base, error: op.error });
  else if (seen !== op.stage) events.emit('operation_stage', base);
  opStage.set(op.operation_id, op.stage);
  // ⚠ 有界：作业本身有上限，这张表也必须跟着裁，否则它会活得比作业还久。
  if (opStage.size > 200) opStage.delete(opStage.keys().next().value);
};

/**
 * ⭐ 三层远端事实，各自的 TTL 与新鲜度。读接口**从不等待它们**。
 *
 * 刷新的依据是「这件事多久会变一次」，⛔ 不是「我们想多快看到」：
 *   · inventory 只在装卸/取用时变 ⇒ **看账本文件的指纹**，变了才问（见下）；
 *   · catalog 变化以天计 ⇒ 10 分钟；
 *   · declared 只在装卸包时变，且读的是本地磁盘 ⇒ 60 秒。
 */

/**
 * ⭐ inventory 由**账本文件的变化**驱动，不由定时器驱动。
 *
 * ⚠ 这是真机数据逼出来的：把等待从读路径挪走之后，`/live` 中位数 16 ms，
 *   **但仍有 0.36–1.81 s 的尖峰**。根因不在本服务——Framework 是单进程 Node，
 *   后台每 30 秒打一次它的 `GET /api/assets`（参考机 12.5 秒），
 *   期间**任何**经由 Framework 转发的请求都排在后面，包括 `/live` 自己那一跳。
 *   **把慢调用挪出读路径，并没有把它挪出那个共享的线程。**
 * ⭐ 所以改成：先 stat 一下账本（微秒级，和 Framework 读的是同一个文件），
 *   指纹没变就一次远端都不打。结果是**又省又快**——装卸资产时反应比 30 秒定时器更及时。
 */
const LEDGER_FILE = process.env.ASSET_REGISTRY_FILE
  || path.join(os.homedir(), '.termux-os', 'assets', 'registry.v1.json');
const ledgerFingerprint = () => {
  try { const st = fs.statSync(LEDGER_FILE); return `${st.mtimeMs}:${st.size}`; }
  catch { return 'absent'; }   // ⚠ 「没有账本」本身也是一个稳定状态，不该每轮都重问
};

const inventoryLayer = new Layer('inventory', async () => {
  const inv = await local.inventory();
  const byId = new Map();
  for (const a of inv.assets ?? []) {
    const id = a?.id ?? a?.asset_id;
    if (id) byId.set(id, a);
  }
  return { available: inv.available, byId };
}, {
  ttlMs: 30_000,
  probe: ledgerFingerprint,
  minIntervalMs: 3_000,
  /** ⚠ 兜底：盘上的文件被手工删掉不会改账本，`ready` 却变了。 */
  backstopMs: 5 * 60_000,
  /** stale 仍按 30 秒的三倍算——⛔ 别因为「没必要刷」就宣称数据永远新鲜。 */
  staleAfterMs: 90_000,
  /**
   * ⭐ 只有真的读到账本才算数。`local.inventory()` 拿不到时返回 `available:false`
   * 而不是抛异常（那是刻意的，为了区分「不知道」与「没有」），
   * 所以这里必须显式告诉 Layer：那种答案不能消费指纹。
   */
  accepted: (v) => v?.available === true,
});

const catalogLayer = new Layer('catalog', async () => registry.catalog({ source: 'huggingface' }),
  { ttlMs: 10 * 60_000 });

const declaredLayer = new Layer('declared', async () => {
  // ⭐ 先读盘（毫秒级，且是 Framework 自己读的同一份文件）；读不到才走 HTTP。
  let withManifests = local.manifestsFromDisk();
  if (!withManifests) {
    const pk = await local.packages();
    if (!pk.available) return { available: false, refs: [], manifests: [] };
    withManifests = [];
    for (const p of pk.packages) {
      // ⚠ 顺序取：并行打一个单线程服务只会把它堵死，总时长一点不省。
      withManifests.push({ id: p.id, manifest: p.manifest ?? await local.packageManifest(p.id) });
    }
  }
  return { available: true, refs: declaredReferences(withManifests), manifests: withManifests };
}, { ttlMs: 60_000 });

/** 空值形状：⚠ 「还没读到」不是「没有」——`available:false` 让下游标 unknown。 */
const EMPTY_INV = { available: false, byId: new Map() };
const EMPTY_CAT = { available: false, projects: [] };
const EMPTY_DECL = { available: false, refs: [], manifests: [] };

/** 每一层的新鲜度。⭐ 只有一个构造处，页面与 API 不会各拼一份。 */
const freshness = () => ({
  inventory: inventoryLayer.snapshot(),
  catalog: catalogLayer.snapshot(),
  declared: declaredLayer.snapshot(),
  upstream: upstream.snapshot(),
  registry_available: (catalogLayer.value?.available ?? false),
  framework_available: (inventoryLayer.value?.available ?? false),
});

const inventoryOf = () => inventoryLayer.value ?? EMPTY_INV;
const catalogOf = () => catalogLayer.value ?? EMPTY_CAT;
const declaredOf = () => declaredLayer.value ?? EMPTY_DECL;

/** 装卸/取用之后立刻重取——⛔ 别让 30 秒的 TTL 把刚发生的事实盖掉。 */
const invalidateLocal = async () => {
  await Promise.all([inventoryLayer.update({ force: true }), declaredLayer.update({ force: true })]);
  events.emit('inventory_changed', { reason: 'lifecycle_action' });
};

/**
 * asset id → **payload** 字节数。
 *
 * ⚠ registry 那个 `total_bytes` 是**描述包归档**的大小（十几 KB），不是模型的大小。
 *   拿它当「大小」显示，一个 479 MB 的 ctx 会写着 0.0 MB——那是在说错话。
 * ⭐ 真正的 payload 尺寸写在**描述包自己的 manifest** 里（`assets.provides[].source.files[].size`），
 *   而那份 manifest 已经在 `manifestsFromDisk()` 读进来了，不需要再打任何网络。
 * ⚠ 同一个 asset id 可能有多个硬件变体，取**与本机已装 target 相同**的那一份；
 *   都对不上就不猜，返回 null。
 */
const payloadBytesByAsset = (manifests, inv) => {
  const out = new Map();
  for (const { manifest } of manifests ?? []) {
    for (const decl of manifest?.assets?.provides ?? []) {
      if (!decl?.id) continue;
      const bytes = (decl.source?.files ?? []).reduce((n, f) => n + (Number(f.size) || 0), 0);
      if (!bytes) continue;
      const installedTarget = inv.byId.get(decl.id)?.target ?? null;
      const declTarget = decl.target?.id ?? 'generic';
      const exact = installedTarget ? declTarget === installedTarget : declTarget === 'generic';
      // 先来的不覆盖，除非后来的这一份精确匹配本机 target
      if (!out.has(decl.id) || exact) out.set(decl.id, bytes);
    }
  }
  return out;
};

/**
 * 一个 manifest 里的 source 坐标。正常情况下 asset id 已经在最新 package index 的
 * `provides[]` 里，直接按 id 命中；Audio8 encoder 暴露的是一个真实存在的、单独
 * 审批过的 HF payload，但旧 package index 漏了它，所以这里才允许第二条路：
 * 用 manifest 自己声明的 `source.files[].repo` + 文件 sha256 回接同一个 Registry 项目。
 * ⛔ 不从 package id 前缀猜，也不把一个没有精确 source 坐标的 asset 硬塞进项目。
 */
const sourceHintsFor = (decl, assetId) => {
  const out = [];
  for (const { manifest } of decl?.manifests ?? []) {
    for (const provide of manifest?.assets?.provides ?? []) {
      if (provide?.id !== assetId) continue;
      for (const file of provide?.source?.files ?? []) {
        if (typeof file?.repo !== 'string' || !file.repo) continue;
        out.push({
          repository: file.repo,
          path: typeof file.path === 'string' ? file.path : null,
          remote_path: typeof file.remote_path === 'string' ? file.remote_path : null,
          sha256: typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : null,
        });
      }
    }
  }
  return out;
};

const registryHasSourceFile = (project, hints) =>
  (project?.versions ?? []).some((version) =>
    (version.files ?? []).some((file) => hints.some((hint) =>
      (hint.sha256 && typeof file.sha256 === 'string'
        && hint.sha256 === file.sha256.toLowerCase())
      || (hint.remote_path && hint.remote_path === file.name)
      || (hint.path && hint.path === file.name))));

/** 哪个 registry 项目提供了这个 asset。⚠ 一个 asset 只可能有一个提供方。 */
const projectForAsset = (cat, assetId, decl = EMPTY_DECL) => {
  const direct = (cat.projects ?? []).find((p) => (p.provides ?? []).includes(assetId));
  if (direct) return { ...direct, asset_listed: true };

  // Audio8 encoder 的现行包索引漏了 provides，但 HF payload 自身仍有批准记录。
  const hints = sourceHintsFor(decl, assetId);
  if (!hints.length) return null;
  const fallback = (cat.projects ?? []).find((p) =>
    hints.some((hint) => hint.repository === p.repository));
  if (!fallback) return null;
  return { ...fallback, asset_listed: registryHasSourceFile(fallback, hints) };
};

/**
 * 一个 asset 的完整视图。⚠ `upstream` 只在**显式要**的时候去打 HF——
 * 列表页对 20 个资产各打一次外网请求，会把一个本地问题变成一个网络问题。
 */
const describeAsset = async (assetId, { cat, inv, decl = declaredOf(), withUpstream = false } = {}) => {
  const project = cat.available ? projectForAsset(cat, assetId, decl) : null;
  const up = withUpstream && project?.repository
    ? await upstream.describe(project.repository)
    : null;
  return mergeAsset(assetId, {
    project,
    upstream: up,
    localEntry: inv.byId.get(assetId) ?? null,
    frameworkAvailable: inv.available,
    registryAvailable: cat.available,
  });
};

/**
 * ⭐ **一个资产视图只有一种形状。**
 *
 * ⚠ 这里原本没有这个函数：`/live` 自己补 `references`/`update_label`/`payload_bytes`，
 *   `/assets/<id>` 补前两个，`/assets` 一个都不补。于是同一个资产经由不同的口问出来
 *   **字段不一样**——而消费方按 `/live` 的形状写代码，改用 `assets` 就静静地少几个字段。
 *   termux-speech 接进来时，模型页上每一行的大小都是空的，正是这个原因。
 * ⛔ 所以补充只有一处，三条路由都走它。
 */
const enrichAsset = (view, { decl, bytes }) => {
  view.references = references.referencesFor(view.asset_id, decl.refs);
  view.update_label = updateLabel(view.update_state);
  view.payload_bytes = bytes?.get(view.asset_id) ?? null;
  return view;
};

/** 目录里已知的全部 asset id ∪ 本机已装的。⭐ 两侧都要出现，缺一边都会漏掉东西。 */
const allAssetIds = (cat, inv) => {
  const ids = new Set();
  for (const p of cat.projects ?? []) for (const id of p.provides ?? []) ids.add(id);
  for (const id of inv.byId.keys()) ids.add(id);
  return [...ids].sort();
};

// ────────────────────────────────── HTTP

/**
 * ⭐ logical model 的对外视图：**派生的结构 + 本机的事实**，合在一起。
 * ⛔ 状态不从这里推断——它是 `modelState` 落盘的那一份，页面刷新/服务重启都还在。
 */
const modelsView = () => {
  const decl = declaredOf();
  const inv = inventoryOf();
  const bytes = payloadBytesByAsset(decl.manifests, inv);
  const target = appOf().target ?? {};
  const models = currentLogicalModels(decl.manifests ?? [], target).map((m) => {
    const st = modelState.read(m.model_id);
    /**
     * ⚠ **Framework 的账本是按 asset id 记的，而一个 id 可以有多个 target 变体**
     *   （SenseVoice 的 v73 与 v79 就共用 `model.sensevoice.ctx`）。
     *   只按 id 查，两个变体会同时显示成「已安装」——而盘上只有一份。
     * ⭐ 判据要带上 target：账本里的 `target` 说的就是**实际装的是哪一份**。
     */
    const withLocal = (a) => {
      const entry = inv.byId?.get(a.asset_id) ?? null;
      const wantTarget = a.target?.id ?? null;
      const sameTarget = wantTarget === null
        || entry?.target === wantTarget
        // 账本没记 target（旧条目）时不冤枉它：按 id 命中即算
        || entry?.target == null;
      const installed = Boolean(entry?.path) && sameTarget;
      return { ...a, installed, path: installed ? entry.path : null,
        ready: installed ? (entry?.ready ?? null) : null,
        installed_target: entry?.target ?? null,
        payload_bytes: bytes.get(a.asset_id) ?? null };
    };
    const result = {
      ...m,
      source: m.source ? withLocal(m.source) : null,
      prebuilt: m.prebuilt.map(withLocal),
      companions: m.companions.map(withLocal),
      choices: downloadChoices(m),
      state: st.state,
      executable: st.executable,
      prepared: st.prepared,
      download: st.download,
      diagnostics: st.diagnostics,
      /** ⭐ 「能不能点使用」是一个**事实**：盘上有没有可准备的东西。 */
      can_use: false,
    };
    result.can_use = Boolean(
      result.prebuilt.some((p) => p.installed)
      || (result.source && result.source.installed),
    );
    return result;
  });
  /**
   * ⭐ **使用者看到的状态由两类事实合成**（docs/094 §3）：
   *   Framework 账本说盘上有什么 + Manager state 说准备到哪一步。
   * ⚠ 只读 state JSON 会让一台早就装满模型的机器每一行都写着「未下载」——
   *   每个字段单看都诚实，合起来是一句假话。
   */
  const cap = appOf();
  const withStatus = models.map((m) => {
    const internalIds = new Set(modelRuntimeAssets(m)
      .filter((a) => a.internal === true)
      .map((a) => a.asset_id));
    const statusModel = internalIds.size
      ? {
        ...m,
        companions: [
          ...(m.companions ?? []),
          ...modelRuntimeAssets(m).map((a) => ({ ...a, role: 'companion', optional: a.optional === true })),
        ],
      }
      : m;
    const s = userStatus(statusModel);
    const visibleMissing = (s.missing ?? []).filter((item) => !internalIds.has(item.asset_id));
    return {
      ...m,
      user_status: s.status,
      missing: visibleMissing,
      usable: s.usable,
      use_blocked_reason: s.usable
        ? useBlockedReason(m, {
          verifiable: cap.verifiable_models ?? [],
          appAvailable: cap.available === true,
        })
        : null,
      /** 已经落到盘上的产物（给「详情」显示已下载大小与执行方式）。 */
      installed_parts: [...executableCandidates(statusModel), ...(statusModel.companions ?? [])]
        .filter((a) => a.installed && a.internal !== true)
        .map((a) => ({ asset_id: a.asset_id, role: a.role, path: a.path, target: a.installed_target,
          bytes: a.payload_bytes ?? null })),
      required_missing: requiredCompanions(statusModel)
        .filter((c) => !c.installed && c.internal !== true)
        .map((c) => c.asset_id),
      operation: operations.active().find((o) => o.asset_id === m.model_id) ?? null,
    };
  });
  return {
    models: withStatus,
    summary: modelSummary(withStatus),
    target,
    app: app.snapshot(),
    device_known: cap.available === true,
  };
};

/**
 * ⭐ **给消费方的 executable descriptor**（docs/093 §15）。
 *
 * 它回答的只有一件事：**「现在能跑的是什么，它的伴随文件在哪」**。
 * ⛔ 刻意**不**回答的：这是预制还是本机编的、target 是 v73 还是 v79、
 *   为什么选了这一份、fallback 的源在哪 —— 那些是 Manager 的事，
 *   消费方知道了只会长出第二套选择逻辑，而两套迟早会不一致。
 *
 * ⚠ `state !== 'enabled'` 时**明确说不可用**，⛔ 不回落到某个「看起来能用」的路径：
 *   悄悄回落会让「使用者到底有没有准备过这个模型」永远答不出来。
 */
const resolveDescriptor = (model) => {
  const st = model.state;
  const prepared = model.prepared;
  const preparedVersionMatches = !prepared
    || prepared.model_version == null
    || model.version == null
    || String(prepared.model_version) === String(model.version);
  const executable = prepared?.executable ?? model.executable;
  const base = {
    model_id: model.model_id,
    display_name: model.display_name,
    version: model.version,
    state: st,
    diagnostics: model.diagnostics ?? null,
  };
  if (st !== ENABLED || !executable?.path || !preparedVersionMatches) {
    return {
      ...base,
      available: false,
      reason: !preparedVersionMatches ? 'prepared_version_mismatch'
        : st === 'failed' ? 'model_prepare_failed'
        : st === 'preparing' ? 'model_preparing'
          : 'model_not_enabled',
      hint: '请在「模型管理器」里下载并点「使用」。',
      executable: null,
      companions: {},
    };
  }
  /**
   * 伴随文件按 **role** 给出，⛔ 不给文件名让调用方去拼。
   * 旧伴随资产仍按 asset id 保留；prepared bundle 则按 runtime role 直接给路径。
   * 消费方只读最终 role，不知道 source/build asset 的生命周期。
   */
  const companions = {};
  for (const [role, companion] of Object.entries(prepared?.companions ?? {})) {
    if (!companion?.path) continue;
    companions[role] = {
      role,
      path: companion.path,
      kind: companion.kind ?? 'asset',
      asset_id: companion.asset_id ?? null,
      ownership: companion.ownership ?? null,
      shared: companion.shared === true,
    };
  }
  for (const c of model.companions ?? []) {
    if (!c.installed || !c.path) continue;
    companions[c.asset_id] = {
      root: c.path,
      files: Object.fromEntries(Object.entries(c.roles ?? {})
        .map(([role, name]) => [role, `${c.path}/${name}`])),
    };
    // New consumers may ask for a role directly; the asset-keyed shape above
    // remains for SenseVoice/old speech versions.
    for (const [role, name] of Object.entries(c.roles ?? {})) {
      if (companions[role]) continue;
      companions[role] = {
        role,
        asset_id: c.asset_id,
        path: path.join(c.path, name),
        root: c.path,
        files: { [role]: path.join(c.path, name) },
        kind: 'asset',
        ownership: 'shared',
        shared: true,
      };
    }
  }
  return {
    ...base,
    available: true,
    reason: null,
    executable: {
      /**
       * ⚠ `kind` 只进诊断。消费方**不许**据此改变行为——
       *   「预制」与「本机编」产出的是同一个可执行体，区别只在它是怎么来的。
       */
      kind: executable.kind,
      path: executable.path,
      verified_at: executable.verified_at ?? null,
    },
    companions,
    prepared: prepared ?? null,
  };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * App 的 prepare 是同步业务调用，但 App 另有一个只读 status seam；轮询它只把 App
 * 已经确认完成的 stage/percent 镜像到 Manager operation，不按时间补数字。
 */
const prepareWithProgress = async (params, setStage, setProgress) => {
  let watching = true;
  void (async () => {
    while (watching) {
      try {
        const status = await app.prepareStatus();
        if (status?.stage) setStage(status.stage);
        if (Number.isFinite(status?.progress)) {
          setProgress({ progress: status.progress, precision: 'stage' });
        }
      } catch { /* App 不可达由 prepare 本身返回；进度轮询不能覆盖主错误。 */ }
      if (watching) await delay(400);
    }
  })();
  try {
    const result = await app.prepare(params);
    if (result?.stage) setStage(result.stage);
    if (Number.isFinite(result?.progress)) {
      setProgress({ progress: result.progress, precision: 'stage' });
    }
    return result;
  } finally {
    watching = false;
  }
};

/** 盘上这条 asset 的目录；取不到就是 null（⛔ 不猜路径）。 */
const assetPathOf = (assetId) => inventoryOf().byId?.get(assetId)?.path ?? null;

const assetFile = (asset, role) => {
  if (!asset?.path || typeof asset.roles?.[role] !== 'string') return null;
  const root = path.resolve(asset.path);
  const candidate = path.resolve(root, asset.roles[role]);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
};

/** ⚠ Audio8 退役后再没有「隐藏 runtime 依赖」这一类；保留空实现让调用点不必分叉。 */
const modelRuntimeAssets = () => [];

const APP_MODEL_CACHE_ROOT = path.resolve(
  process.env.APP_MODEL_CACHE_ROOT || '/sdcard/termux-os/caches',
);

/** 只允许删除 App 约定的缓存根下、当前 model state 明确拥有的 local artifact。 */
const removeLocalGenerated = (model, { dryRun = false } = {}) => {
  const artifact = model?.executable;
  if (artifact?.kind !== KIND_LOCAL || !artifact.path) return { ok: true, removed: false, path: null };
  const target = path.resolve(artifact.path);
  if (target !== APP_MODEL_CACHE_ROOT && !target.startsWith(`${APP_MODEL_CACHE_ROOT}${path.sep}`)) {
    return { ok: false, error: 'local_artifact_outside_cache', path: artifact.path };
  }
  if (dryRun) return { ok: true, removed: false, path: artifact.path, planned: true };
  try {
    const existed = fs.existsSync(target);
    if (existed) fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, removed: existed, path: artifact.path };
  } catch (error) {
    return { ok: false, error: 'local_artifact_delete_failed', path: artifact.path,
      detail: String(error?.message ?? error) };
  }
};

/**
 * Build the prepared runtime companion map from manifest roles.
 *
 * `source.runtime_companions` is the explicit contract (with the small
 * FireRedVAD compatibility inference in logical.mjs). Separate companion
 * assets, such as SenseVoice frontend files, use the same role-keyed output.
 * No file name is guessed here; every name came from a manifest role.
 */
const preparedCompanionsFor = (model, { sourcePath = null } = {}) => {
  const companions = {};
  const missing = [];
  const add = (role, file, meta) => {
    if (typeof file !== 'string' || !file) {
      missing.push({ role, reason: 'manifest_role_missing' });
      return;
    }
    const root = path.resolve(meta.root);
    const candidate = path.resolve(root, file);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      missing.push({ role, reason: 'manifest_role_outside_asset', path: file });
      return;
    }
    if (!fs.existsSync(candidate)) {
      missing.push({ role, reason: 'companion_missing', path: candidate });
      return;
    }
    companions[role] = {
      path: candidate,
      kind: meta.kind ?? 'asset',
      asset_id: meta.assetId ?? null,
      ownership: meta.ownership ?? 'shared',
      shared: meta.shared === true,
    };
  };

  if (sourcePath && model.source) {
    for (const [role, file] of Object.entries(model.source.runtime_companions ?? {})) {
      add(role, file, {
        root: sourcePath,
        assetId: model.source.asset_id,
        kind: 'asset',
        ownership: 'shared',
        shared: true,
      });
    }
  }

  for (const asset of model.companions ?? []) {
    if (asset.shadowed === true || asset.legacy === true || !asset.installed || !asset.path) continue;
    for (const [role, file] of Object.entries(asset.roles ?? {})) {
      add(role, file, {
        root: asset.path,
        assetId: asset.asset_id,
        kind: 'asset',
        ownership: 'shared',
        shared: true,
      });
    }
  }
  return { companions, missing };
};

const requiredDeclaredCompanions = (model) => (model.companions ?? [])
  .filter((asset) => asset.optional !== true && asset.shadowed !== true && asset.legacy !== true)
  .filter((asset) => !asset.installed || !asset.path)
  .map((asset) => asset.asset_id);

const refreshSpeechConsumer = async () => {
  try {
    const r = await local.restartService('termux-speech');
    return {
      requested: true,
      ok: r.ok === true,
      status: r.status ?? null,
      error: r.ok === true ? null : (r.data?.error ?? `HTTP ${r.status}`),
      service: r.data?.service ?? r.data?.id ?? 'termux-speech',
    };
  } catch (error) {
    return {
      requested: true,
      ok: false,
      status: null,
      error: String(error?.message ?? error),
      service: 'termux-speech',
    };
  }
};

const preparedStateMatches = (state, { modelVersion, executablePath, companions }) =>
  preparedBundleComplete(state, {
    modelVersion,
    executablePath,
    requiredRoles: Object.keys(companions ?? {}),
  })
  && Object.entries(companions ?? {}).every(([role, value]) =>
    state.prepared?.companions?.[role]?.path === value.path);

/** Only delete companions explicitly copied into Manager's cache. Asset-store
 * companions are shared Framework payloads and are removed through their asset
 * lifecycle below, never by a raw filesystem delete. */
const removeManagerOwnedCompanions = (model, { dryRun = false } = {}) => {
  const removed = [];
  const failed = [];
  for (const [role, companion] of Object.entries(model?.prepared?.companions ?? {})) {
    if (companion?.ownership !== 'manager' || !companion.path) continue;
    const target = path.resolve(companion.path);
    if (target !== APP_MODEL_CACHE_ROOT
      && !target.startsWith(`${APP_MODEL_CACHE_ROOT}${path.sep}`)) {
      failed.push({ role, error: 'manager_companion_outside_cache', path: companion.path });
      continue;
    }
    if (dryRun) continue;
    try {
      const existed = fs.existsSync(target);
      if (existed) fs.rmSync(target, { recursive: true, force: true });
      removed.push({ role, path: companion.path, removed: existed });
    } catch (error) {
      failed.push({ role, error: 'manager_companion_delete_failed', path: companion.path,
        detail: String(error?.message ?? error) });
    }
  }
  return { ok: failed.length === 0, removed, failed };
};

const downloadPlanFor = (model, picked) => {
  const selected = picked.choice === 'prebuilt'
    ? model.prebuilt.find((x) => x.asset_id === picked.asset_id)
    : model.source;
  return [selected, ...(model.companions ?? []), ...modelRuntimeAssets(model)]
    .filter((a) => a && a.installed !== true && a.shadowed !== true && a.legacy !== true);
};

/**
 * Framework 的 fetch/restore 才有文件流字节事实；provider 安装没有被本包伪造成字节进度。
 * poll 是低频观察，不参与下载控制，也不创建第二个任务引擎。
 */
const runFetchWithProgress = async (asset, { offset = 0, knownTotal = null, setProgress, run }) => {
  if (Number.isFinite(knownTotal) && knownTotal > 0) {
    setProgress({
      bytesDone: offset, bytesTotal: knownTotal,
      progress: Math.floor((offset / knownTotal) * 100), precision: 'bytes',
    });
  }
  let watching = true;
  void (async () => {
    while (watching) {
      try {
        const r = await local.fetchProgress(asset.asset_id);
        const p = r.data?.progress;
        if (p && Number.isFinite(p.bytes_done)) {
          const total = Number.isFinite(knownTotal) && knownTotal > 0
            ? knownTotal
            : (Number.isFinite(p.bytes_total) ? offset + p.bytes_total : null);
          const done = offset + p.bytes_done;
          setProgress({
            bytesDone: done,
            bytesTotal: total,
            progress: total > 0 ? Math.floor((done / total) * 100) : null,
            precision: 'bytes',
            currentFile: p.current_file ?? null,
          });
        }
      } catch { /* 进度观察失败不改变下载结果。 */ }
      if (watching) await delay(500);
    }
  })();
  try { return await run(); }
  finally { watching = false; }
};

/**
 * A failed Manager request can outlive its HTTP caller in Framework. If the
 * Framework answer says the asset is already fetching, reconcile the worker
 * first; only a stale worker is aborted, and only then is one retry allowed.
 */
const fetchOnceWithReconcile = async (asset, run) => {
  let result = await run();
  if (result.ok || result.data?.error !== 'already_fetching') return result;
  const reconciled = await local.reconcileFetch(asset.asset_id).catch((error) => ({
    ok: false, data: { error: 'reconcile_failed', detail: String(error?.message ?? error) },
  }));
  if (reconciled.ok && reconciled.data?.reconciled === true) result = await run();
  return result;
};

const fetchOrRestoreAsset = async (asset, context) => {
  const described = await local.describe(asset.asset_id);
  const entry = described.asset ?? {};
  /**
   * logical 删除会先摘掉 Framework active inventory；因此删除后再 describe 同一个
   * asset 时，`package` 故意为空，但 provider 仍然由当前 manifest 声明并已加载。
   * required asset 不能因为这个“已停用”的 inventory 形状而误走 installProvider，
   * 必须走带 logical_model_id/deactivated=1 的受限 restore。
   */
  const needsRestore = asset.optional !== true && !entry.path;
  if (asset.optional === true) {
    return runFetchWithProgress(asset, {
      ...context,
      run: () => fetchOnceWithReconcile(asset, () => local.fetchPayload(asset.asset_id)),
    });
  }
  if (needsRestore) {
    return runFetchWithProgress(asset, {
      ...context,
      run: () => fetchOnceWithReconcile(asset,
        () => local.restorePayload(asset.asset_id, context.logicalModelId)),
    });
  }
  return local.installProvider(asset.asset_id);
};

/**
 * ⭐ **「使用」的状态机**（docs/092 §10）。
 *
 * 顺序是硬的：**预制优先 → 失败自动回落源 ONNX（必要时补下载）→ 本地编译**。
 * ⚠ 每一步失败都不删任何东西：`prebuilt` 失败留着 prebuilt，`compile` 失败留着 source。
 *   使用者重启之后可以直接重试，⛔ 不需要重新下载。
 */
const useModel = async (model, setStage, setProgress) => {
  const id = model.model_id;
  const version = model.version ?? 'unknown';
  const attempts = [];

  const missingDeclared = requiredDeclaredCompanions(model);
  if (missingDeclared.length) {
    const error = `缺少必需伴随资产: ${missingDeclared.join(', ')}`;
    modelState.noteFailed(id, { stage: 'companion_missing', error });
    return { enabled: false, stage: 'companion_missing', error, attempts };
  }

  const sharedCompanions = preparedCompanionsFor(model);
  if (sharedCompanions.missing.length) {
    const error = `伴随文件不完整: ${JSON.stringify(sharedCompanions.missing)}`;
    modelState.noteFailed(id, { stage: 'companion_missing', error });
    return { enabled: false, stage: 'companion_missing', error, attempts };
  }

  // ── ① 预制（如果盘上有的话）─────────────────────────────────────────
  const prebuilt = model.prebuilt
    .map((p) => ({ ...p, path: assetPathOf(p.asset_id) }))
    .filter((p) => p.path)
    // ⭐ 推荐的排前面，⛔ 但不推荐的**照样尝试** —— 兼容性以真实 load 为准。
    .sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true));
  for (const p of prebuilt) {
    setStage('load_prebuilt');
    const r = await prepareWithProgress({
      modelId: id, modelVersion: version, mode: 'verify_prebuilt', artifactPath: p.path,
    }, setStage, setProgress);
    attempts.push({ mode: 'verify_prebuilt', asset_id: p.asset_id, ok: r.ok === true,
      stage: r.stage, error: r.error ?? null });
    if (r.ok === true) {
      modelState.noteEnabled(id, {
        modelVersion: version, kind: KIND_PREBUILT,
        artifactPath: r.artifact?.path ?? p.path, derivedFrom: p.asset_id, target: r.target,
        companions: sharedCompanions.companions,
      });
      const persisted = modelState.read(id);
      const executablePath = r.artifact?.path ?? p.path;
      if (!preparedStateMatches(persisted, {
        modelVersion: version, executablePath, companions: sharedCompanions.companions,
      })) {
        modelState.noteFailed(id, {
          stage: 'persist_state', error: 'prepared state read-back failed', clearPrepared: true,
        });
        return { enabled: false, stage: 'persist_state', error: 'prepared state read-back failed', attempts };
      }
      const consumerRefresh = await refreshSpeechConsumer();
      return { enabled: true, kind: KIND_PREBUILT, artifact: r.artifact,
        inference_ms: r.inference_ms, attempts, consumer_refresh: consumerRefresh };
    }
  }

  // ── ② 回落到源 ONNX；没下过就现在补下（Framework 的 optional/fetch）──
  let sourcePath = model.source ? assetPathOf(model.source.asset_id) : null;
  if (model.source && !sourcePath) {
    setStage('downloading');
    const r = model.source.optional
      ? await local.fetchPayload(model.source.asset_id)
      : await local.installProvider(model.source.asset_id);
    if (!r.ok) {
      const err = r.data?.error ?? `HTTP ${r.status}`;
      modelState.noteFailed(id, { stage: 'fetch_source', error: err });
      return { enabled: false, stage: 'fetch_source', error: err, attempts };
    }
    await invalidateLocal();
    sourcePath = assetPathOf(model.source.asset_id);
  }
  if (!sourcePath) {
    /**
     * ⚠ 没有 source 就**到此为止**，而且必须说清楚：这不是「编译失败」，
     *   是**这个模型在 HF 上根本没有可编译的原材料**（Audio8 的 encoder 正是这种情况）。
     */
    const err = model.source
      ? '源 ONNX 下载后仍然找不到路径'
      : '这个模型没有可用于本地编译的源 ONNX（上游仓库里缺这份原材料）';
    modelState.noteFailed(id, { stage: 'no_source', error: err });
    return { enabled: false, stage: 'no_source', error: err, attempts };
  }

  setStage('verify_companions');
  const runtimeCompanions = preparedCompanionsFor(model, { sourcePath });
  if (runtimeCompanions.missing.length) {
    const error = `runtime companion 不完整: ${JSON.stringify(runtimeCompanions.missing)}`;
    modelState.noteFailed(id, { stage: 'companion_missing', error });
    return { enabled: false, stage: 'companion_missing', error, attempts };
  }

  // ── ③ 本地编译 ────────────────────────────────────────────────────
  setStage('compile');
  const r = await prepareWithProgress({
    modelId: id, modelVersion: version, mode: 'compile_local', sourcePath,
  }, setStage, setProgress);
  attempts.push({ mode: 'compile_local', asset_id: model.source?.asset_id ?? null,
    ok: r.ok === true, stage: r.stage, error: r.error ?? null });
  if (r.ok !== true) {
    // ⛔ 编译失败**保留 source**：下次重试不需要重新下载。
    modelState.noteFailed(id, {
      stage: r.stage ?? 'compile', error: r.error?.message ?? '本地编译失败',
    });
    return { enabled: false, stage: r.stage, error: r.error, attempts };
  }

  const executablePath = r.artifact?.path ?? null;
  if (!executablePath) {
    const error = 'App prepare 成功但没有返回 generated executable path';
    modelState.noteFailed(id, { stage: 'prepare_output', error });
    return { enabled: false, stage: 'prepare_output', error, attempts };
  }

  /**
   * ⭐ **§16 的五步**：App 生成 → load 成功 → inference verify 成功 →
   *   Manager 确认 runtime companions → **prepared 状态原子落盘** →
   *   才处理 build source。
   * ⚠ FireRedVAD 的 `cmvn.bin` 是 source asset 里的 runtime companion；本轮
   *   采用 Plan A 保留整个 2.3 MB source asset，避免 Framework 只能整包 drop
   *   时把 companion 一起删掉。
   */
  modelState.noteEnabled(id, {
    modelVersion: version, kind: KIND_LOCAL, artifactPath: executablePath,
    derivedFrom: model.source?.asset_id ?? null, target: r.target,
    companions: runtimeCompanions.companions,
  });
  const persisted = modelState.read(id);
  if (!preparedStateMatches(persisted, {
    modelVersion: version, executablePath, companions: runtimeCompanions.companions,
  })) {
    // ⚠ 写盘没成功就**不删**：宁可留一份用不上的 source，也不要丢掉唯一的 companion。
    return { enabled: false, stage: 'persist_state', error: 'prepared 状态未能落盘；source 已保留', attempts };
  }

  /**
   * ⭐⭐ **源图一律保留（docs/103）。⛔ 不再有 `drop_build_source` 这条路径。**
   *
   * 本地编出来的 EPContext 绑 **DSP 架构 + QNN 运行时版本**，而运行时是随 App 走的：
   * App 升一次级（如 QAIRT 2.47 → 2.49），盘上每一份 ctx 同时作废，
   * 唯一的补救就是**用源图再编一次**。把源图删掉等于把那次补救变成一次
   * 937 MB 的重新下载——而那正是这台机器上刚刚发生过的事。
   *
   * ⚠ 省下来的磁盘由另一头还回来：ctx 落盘时 App 会**自动清掉同一个模型被取代的旧产物**
   *   （`OrtEngine.pruneSupersededCtx`），所以常驻占用是「每个模型一份源图 + 一份 ctx」，
   *   ⛔ 不会随版本累积。
   * ⭐ **能重新生成的东西才可以删；不能重新生成的东西必须留着。**
   *   ctx 能重新生成，源图不能——它得从网上重下。
   */
  const sourceRemoved = model.source ? false : null;
  const consumerRefresh = await refreshSpeechConsumer();
  return { enabled: true, kind: KIND_LOCAL, artifact: r.artifact,
    inference_ms: r.inference_ms, source_removed: sourceRemoved,
    source_policy: 'preserve_source_for_recompile',
    runtime_companions: runtimeCompanions.companions,
    attempts, consumer_refresh: consumerRefresh };
};

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  req.on('error', () => resolve(null));
});

/** ⛔ 只认 Framework 注入的 System Key；本服务不自建凭证、不接受 URL 里的 token。 */
const authorized = (req) => {
  if (!SYSTEM_KEY) return true;                       // 未注入（dev/单测）时不拦
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SYSTEM_KEY}`;
};

/**
 * ⭐ 启动对赈（docs/092 §8）：`preparing` 只能由**正在运行的作业**持有。
 * 服务重启之后没有任何作业还在跑 ⇒ 它一定是被打断的，必须变成可重试的 `failed`。
 * ⛔ 永久卡在「准备中」是一个使用者点不动、也看不懂的死状态。
 */
void appLayer.update().catch(() => {});
const recoveredPreparing = modelState.reconcile({ activeModelIds: [] }).recovered;
if (recoveredPreparing.length) {
  console.log(`[hf-model-manager] recovered interrupted preparing: ${recoveredPreparing.join(', ')}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://manager.local');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (route === '/health') {
    return send(res, 200, { ok: true, service: 'hf-model-manager', change_seq: changeSeq });
  }
  if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

  try {
    // ── 目录 ────────────────────────────────────────────────────────────
    if (route === '/catalog' && req.method === 'GET') {
      if (url.searchParams.get('refresh') === '1') await catalogLayer.update({ force: true });
      const cat = catalogOf();
      const inv = inventoryOf();
      const projects = (cat.projects ?? []).map((p) => ({
        package_id: p.package_id,
        source: p.source,
        repository: p.repository,
        display_name: p.display_name,
        description: p.description,
        asset_ids: p.provides,
        approved_version: p.latest?.version ?? null,
        approved_revision: p.latest?.revision ?? null,
        published_at: p.latest?.published_at ?? null,
        total_bytes: p.latest?.total_bytes ?? null,
        installed: (p.provides ?? []).some((id) => inv.byId.has(id)),
        /**
         * ⭐ 目录里还躺着几条**纯白名单**项目（`FunAudioLLM/SenseVoiceSmall` 之类）：
         * 没有 package_id、不供应任何 asset id，登记它们只是为了让 CF 放行被别人引用的
         * 上游文件。混进「可安装的模型」，使用者会以为有 7 个模型而其实只有 4 个。
         * ⛔ 不过滤掉它们——那会让「这个文件为什么下得动」查不出来——只是如实标出角色。
         */
        installable: Boolean(p.package_id && (p.provides ?? []).length),
        role: p.package_id ? 'asset_package' : 'upstream_reference',
      }));
      return send(res, cat.available ? 200 : 503, {
        ok: cat.available,
        registry: { available: cat.available, version: cat.registry_version ?? null,
          error: cat.error ?? null, base: REGISTRY_URL },
        framework: { available: inv.available },
        projects,
      });
    }

    // ── 资产列表 / 详情 ─────────────────────────────────────────────────
    if (route === '/assets' && req.method === 'GET') {
      const cat = catalogOf();
      const inv = inventoryOf();
      const ids = allAssetIds(cat, inv);
      const decl = declaredOf();
      const bytes = payloadBytesByAsset(decl.manifests, inv);
      const assets = [];
      for (const id of ids) assets.push(enrichAsset(await describeAsset(id, { cat, inv, decl }), { decl, bytes }));
      return send(res, 200, {
        ok: true,
        sources: { registry: cat.available, framework: inv.available, upstream: 'on_demand' },
        assets,
      });
    }
    const detail = route.match(/^\/assets\/([^/]+)$/);
    if (detail && req.method === 'GET') {
      const id = decodeURIComponent(detail[1]);
      const cat = catalogOf();
      const inv = inventoryOf();
      const decl = declaredOf();
      const view = enrichAsset(await describeAsset(id, { cat, inv, decl, withUpstream: true }),
        { decl, bytes: payloadBytesByAsset(decl.manifests, inv) });
      return send(res, 200, { ok: true, asset: view });
    }

    // ── 已安装 ─────────────────────────────────────────────────────────
    if (route === '/installed' && req.method === 'GET') {
      const inv = inventoryOf();
      const cat = catalogOf();
      const items = [];
      for (const [id, entry] of inv.byId) {
        const project = cat.available ? projectForAsset(cat, id, declaredOf()) : null;
        items.push({
          asset_id: id,
          provider_package: entry.package_id ?? null,
          /** ⭐ 来自 registry，不是包 id 前缀。 */
          source: project?.source ?? null,
          repository: project?.repository ?? null,
          version: entry.version ?? null,
          target: entry.target ?? null,
          path: entry.path ?? null,
          installed: true,
          fetched_on_demand: entry.fetched_on_demand === true,
          compatible: entry.ready ?? null,
          reason: entry.reason ?? null,
        });
      }
      return send(res, 200, {
        ok: true, framework: { available: inv.available }, count: items.length, installed: items,
      });
    }

    // ── 解析 target ────────────────────────────────────────────────────
    const resolve = route.match(/^\/assets\/([^/]+)\/resolve$/);
    if (resolve && req.method === 'POST') {
      const id = decodeURIComponent(resolve[1]);
      // ⭐ 复用 Framework 的 target matcher，⛔ 本包不再实现一套 os/arch/htp/qnn 比较。
      const r = await local.describe(id);
      if (!r.available) return send(res, 503, { ok: false, error: 'framework_unavailable', detail: r.detail });
      const a = r.asset ?? {};
      return send(res, 200, {
        ok: true,
        asset_id: id,
        compatible: a.ready === true,
        selected_target: a.target ?? null,
        provider: a.package ?? a.package_id ?? null,
        version: a.version ?? null,
        local_path: a.path ?? null,
        /** ⛔ target 不符时如实说原因，绝不悄悄换一个能跑的。 */
        reason: a.ready === true ? null : (a.reason ?? 'unknown'),
        detail: a.detail ?? null,
      });
    }

    // ── 生命周期（全部包成作业）─────────────────────────────────────────
    const install = route.match(/^\/assets\/([^/]+)\/(install|fetch)$/);
    if (install && req.method === 'POST') {
      const id = decodeURIComponent(install[1]);
      const action = install[2];
      const { operation, deduplicated } = operations.start(action, id, async ({ setStage }) => {
        setStage('resolving');
        setStage('downloading');
        const r = action === 'install' ? await local.installProvider(id) : await local.fetchPayload(id);
        if (!r.ok) {
          const e = r.data?.error ?? `HTTP ${r.status}`;
          throw new Error(`${e}${r.data?.detail ? `: ${r.data.detail}` : ''}`);
        }
        setStage('verifying');
        void invalidateLocal();
        const after = await local.describe(id);
        return { framework: r.data, ready: after.asset?.ready ?? null, path: after.asset?.path ?? null };
      });
      return send(res, 202, { ok: true, deduplicated, operation });
    }

    const verify = route.match(/^\/assets\/([^/]+)\/verify$/);
    if (verify && req.method === 'POST') {
      const id = decodeURIComponent(verify[1]);
      const { operation, deduplicated } = operations.start('verify', id, async ({ setStage }) => {
        setStage('verifying');
        // ⭐ 复用 Framework 的逐档 sha256，⛔ 不写第二个 verifier。
        const r = await local.describe(id, { verify: true });
        if (!r.available) throw new Error(r.detail ?? 'framework_unavailable');
        const a = r.asset ?? {};
        const reason = String(a.reason ?? '');
        const result = a.ready === true ? 'ok'
          : reason.startsWith('checksum_mismatch') ? 'checksum_mismatch'
            : reason.startsWith('target_mismatch') ? 'target_mismatch'
              : reason.startsWith('missing_asset') ? (a.package ? 'missing' : 'provider_missing')
                : 'missing';
        return { verify: result, reason: a.reason ?? null, detail: a.detail ?? null, path: a.path ?? null };
      });
      return send(res, 202, { ok: true, deduplicated, operation });
    }

    const checkUpdate = route.match(/^\/assets\/([^/]+)\/check-update$/);
    if (checkUpdate && req.method === 'POST') {
      const id = decodeURIComponent(checkUpdate[1]);
      await Promise.all([catalogLayer.update({ force: true }), inventoryLayer.update({ force: true })]);
      const cat = catalogOf();
      const inv = inventoryOf();
      const project = cat.available ? projectForAsset(cat, id, declaredOf()) : null;
      const up = project?.repository ? await upstream.describe(project.repository, { force: true }) : null;
      const view = mergeAsset(id, {
        project, upstream: up, localEntry: inv.byId.get(id) ?? null,
        frameworkAvailable: inv.available, registryAvailable: cat.available,
      });
      return send(res, 200, {
        ok: true,
        asset_id: id,
        update_state: view.update_state,
        update_label: updateLabel(view.update_state),
        registry: view.registry,
        upstream: view.upstream,
        local: view.local,
      });
    }

    // ── 引用 ───────────────────────────────────────────────────────────
    if (route === '/references' && req.method === 'GET') {
      const decl = declaredOf();
      return send(res, 200, {
        ok: true, declared_available: decl.available, references: references.all(decl.refs),
      });
    }
    if (route === '/references' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'invalid_json' });
      try {
        const reference = references.add(body);
        events.emit('reference_changed', { change: 'added', ...reference });
        return send(res, 200, { ok: true, reference });
      }
      catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }); }
    }
    if (route === '/references' && req.method === 'DELETE') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'invalid_json' });
      const removed = references.remove(body);
      if (removed) {
        events.emit('reference_changed', { change: 'removed',
          consumer_package_id: body.consumer_package_id, asset_id: body.asset_id });
      }
      return send(res, 200, { ok: true, removed });
    }
    const assetRefs = route.match(/^\/assets\/([^/]+)\/references$/);
    if (assetRefs && req.method === 'GET') {
      const id = decodeURIComponent(assetRefs[1]);
      const decl = declaredOf();
      return send(res, 200, { ok: true, asset_id: id, references: references.referencesFor(id, decl.refs) });
    }

    // ── 删除（带引用护栏）───────────────────────────────────────────────
    const drop = route.match(/^\/assets\/([^/]+)$/);
    if (drop && req.method === 'DELETE') {
      const id = decodeURIComponent(drop[1]);
      const decl = declaredOf();
      /**
       * ⚠ 声明式引用读不到时**拒绝删除**。
       * 「问不到谁在用」与「没有人在用」是两回事，而这两者之间差着一个不可逆的操作。
       */
      if (!decl.available) {
        return send(res, 503, { ok: false, error: 'references_unknown',
          detail: 'cannot list installed packages; refusing to delete while consumers are unknown' });
      }
      const decision = removalDecision(id, references.referencesFor(id, decl.refs));
      if (!decision.allowed) return send(res, 409, { ok: false, ...decision });
      const r = await local.dropPayload(id);
      void invalidateLocal();
      changeSeq += 1;
      return send(res, r.ok ? 200 : (r.status || 502), { ok: r.ok, asset_id: id, framework: r.data });
    }

    // ── 作业 ───────────────────────────────────────────────────────────
    if (route === '/operations' && req.method === 'GET') {
      return send(res, 200, { ok: true, ...operations.snapshot() });
    }
    const op = route.match(/^\/operations\/([^/]+)$/);
    if (op && req.method === 'GET') {
      const found = operations.get(decodeURIComponent(op[1]));
      return found ? send(res, 200, { ok: true, operation: found })
        : send(res, 404, { ok: false, error: 'unknown_operation' });
    }

    // ── 未受管理的历史目录 ──────────────────────────────────────────────
    if (route === '/unmanaged' && req.method === 'GET') {
      const inv = inventoryOf();
      const known = [...inv.byId.values()].map((a) => a.path).filter(Boolean);
      return send(res, 200, { ok: true, ...scanUnmanaged(STORE, known) });
    }

    // ── feed（capability `termux-os.assets.inventory` 的载体）────────────
    if (route === '/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 100));
      return send(res, 200, { ok: true, schema: 'termux-os.assets-events.v1', ...events.since(after, limit) });
    }
    /** 显式强制刷新。⭐ 读接口永不等远端，想要最新就走这一条。 */
    if (route === '/refresh' && req.method === 'POST') {
      await Promise.all([
        inventoryLayer.update({ force: true }),
        catalogLayer.update({ force: true }),
        declaredLayer.update({ force: true }),
      ]);
      events.emit('inventory_changed', { reason: 'explicit_refresh' });
      return send(res, 200, { ok: true, sources: freshness() });
    }

    // ── docs/092：logical model 的下载 / 使用生命周期 ────────────────────

    /** 全部 logical model + 它们此刻的本机状态。 */
    if (route === '/models' && req.method === 'GET') {
      /**
       * ⭐ 先把 App 的执行画像取到手再算推荐。⚠ 少了这一步，`target` 是空的，
       *   于是**每一个**预制都会被判成「这台机器报不出来 ⇒ 不推荐」——
       *   一个看起来很合理、其实只是没问过的答案。
       * ⚠ 有 TTL（120 秒），所以这不是每次请求都打 App。
       */
      await appLayer.update().catch(() => {});
      return send(res, 200, {
        ok: true, schema: 'termux-os.logical-models.v1', change_seq: changeSeq,
        sources: freshness(), ...modelsView(),
      });
    }

    const modelDetail = route.match(/^\/models\/([^/]+)$/);
    if (modelDetail && req.method === 'GET') {
      const id = decodeURIComponent(modelDetail[1]);
      const found = modelsView().models.find((m) => m.model_id === id);
      if (!found) return send(res, 404, { ok: false, error: 'unknown_model', model_id: id });
      return send(res, 200, { ok: true, model: found });
    }

    /**
     * ⭐ **下载**：只取字节，⛔ 不加载、⛔ 不推理、⛔ 不碰 App。
     * `choice` = `prebuilt` | `source`；缺省用推荐那条。
     */
    const modelDownload = route.match(/^\/models\/([^/]+)\/download$/);
    if (modelDownload && req.method === 'POST') {
      const id = decodeURIComponent(modelDownload[1]);
      const body = await readBody(req).catch(() => ({}));
      const model = modelsView().models.find((m) => m.model_id === id);
      if (!model) return send(res, 404, { ok: false, error: 'unknown_model', model_id: id });
      const choices = downloadChoices(model);
      const picked = body?.choice
        ? choices.find((c) => c.choice === body.choice)
        : (choices.find((c) => c.recommended) ?? choices[0]);
      if (!picked) {
        return send(res, 400, { ok: false, error: 'no_download_choice', choices });
      }
      const plan = downloadPlanFor(model, picked);
      const planTotal = plan.reduce((sum, a) => sum + (Number(a.payload_bytes) || 0), 0) || null;
      const { operation, deduplicated } = operations.start('download', id, async ({ setStage, setProgress }) => {
        modelState.write(id, {
          model_version: model.version ?? null,
          state: DOWNLOADING,
        });
        setStage('resolving');
        const companionFailures = [];
        let offset = 0;
        try {
          for (const asset of plan) {
            setStage('downloading');
            const known = Number(asset.payload_bytes) || null;
            const r = await fetchOrRestoreAsset(asset, {
              logicalModelId: id,
              offset,
              knownTotal: planTotal,
              setProgress,
            });
            if (!r.ok) {
              const e = r.data?.error ?? `HTTP ${r.status}`;
              const failure = { asset_id: asset.asset_id, error: e, detail: r.data?.detail ?? null };
              if (asset === plan[0]) {
                throw new Error(`${e}${failure.detail ? `: ${failure.detail}` : ''}`);
              }
              companionFailures.push(failure);
            }
            offset += known ?? 0;
          }
          setStage('verifying');
          await invalidateLocal();
          const after = await local.describe(picked.asset_id);
          const entry = after.asset ?? {};
          modelState.noteDownloaded(id, {
            modelVersion: model.version,
            kind: picked.choice === 'prebuilt' ? KIND_PREBUILT : 'source',
            assetId: picked.asset_id,
            path: entry.path ?? null,
          });
          changeSeqBump();
          return {
            asset_id: picked.asset_id, choice: picked.choice, path: entry.path ?? null,
            companion_failures: companionFailures,
          };
        } catch (error) {
          modelState.noteFailed(id, { stage: 'download', error: String(error?.message ?? error) });
          changeSeqBump();
          throw error;
        }
      });
      return send(res, 202, { ok: true, deduplicated, choice: picked, operation });
    }

    /**
     * ⭐ **按 logical model 删除**（docs/094 §11）。
     *
     * 使用者删的是「FireRedVAD」，⛔ 不是某一个 asset id。Package manifest 的声明
     * 只是“删后消费者可能不可用”的依赖事实，不等于当前 runtime 正在使用；
     * 真正的安全门是 App 高层 deactivate 返回的 active_after。
     */
    const modelDrop = route.match(/^\/models\/([^/]+)$/);
    if (modelDrop && req.method === 'DELETE') {
      const id = decodeURIComponent(modelDrop[1]);
      const model = modelsView().models.find((m) => m.model_id === id);
      if (!model) return send(res, 404, { ok: false, error: 'unknown_model', model_id: id });
      const decl = declaredOf();
      const parts = [...new Set((model.installed_parts ?? []).map((x) => x.asset_id))];
      const referencesWarning = decl.available
        ? { known: true, declared_count: parts.reduce((n, assetId) => n
          + references.referencesFor(assetId, decl.refs).length, 0) }
        : { known: false, warning: '声明引用暂时读不到；由 App runtime deactivate 作为唯一活跃性判据。' };

      // 先验证 local artifact 的删除边界，避免停用后才发现 state 指向了不应由 Manager 删除的路径。
      const localArtifact = removeLocalGenerated({ executable: model.executable }, { dryRun: true });
      if (!localArtifact.ok && localArtifact.error === 'local_artifact_outside_cache') {
        return send(res, 409, { ok: false, error: localArtifact.error, model_id: id, path: localArtifact.path });
      }
      const preparedCompanionPlan = removeManagerOwnedCompanions(model, { dryRun: true });
      if (!preparedCompanionPlan.ok) {
        return send(res, 409, { ok: false, error: 'prepared_companion_delete_unsafe', model_id: id,
          failed: preparedCompanionPlan.failed });
      }

      let deactivated;
      try {
        deactivated = await app.deactivate({ modelId: id, modelVersion: model.version, reason: 'model_delete' });
      } catch (error) {
        return send(res, 503, {
          ok: false, error: 'deactivate_failed', model_id: id,
          detail: String(error?.message ?? error), references: referencesWarning,
        });
      }
      const activeAfter = deactivated?.active_after === true
        || deactivated?.released?.active_after === true;
      if (activeAfter) {
        return send(res, 409, {
          ok: false, error: 'deactivate_failed', model_id: id,
          detail: 'App 报告该模型仍有 active runtime；未删除任何资产。',
          deactivated, references: referencesWarning,
        });
      }

      const removed = [];
      const failed = [];
      for (const assetId of parts) {
        const r = await local.dropLogicalPayload(assetId, id).catch((error) => ({
          ok: false, status: 502, data: { error: String(error?.message ?? error) },
        }));
        if (r.ok) removed.push(assetId);
        else failed.push({ asset_id: assetId, error: r.data?.error ?? `HTTP ${r.status}`, detail: r.data?.detail ?? null });
      }
      // 只删 state 明确标成 local 的单个生成产物；不清空整个 caches 根，不碰 records/WAV。
      const localRemoved = localArtifact.ok ? removeLocalGenerated({ executable: model.executable }) : localArtifact;
      if (!localRemoved.ok) failed.push({ asset_id: null, error: localRemoved.error, detail: localRemoved.detail ?? null });
      const preparedCompanionsRemoved = preparedCompanionPlan.ok
        ? removeManagerOwnedCompanions(model)
        : preparedCompanionPlan;
      for (const item of preparedCompanionsRemoved.failed ?? []) {
        failed.push({ asset_id: null, role: item.role, error: item.error, detail: item.detail ?? null });
      }
      if (failed.length) {
        return send(res, 502, {
          ok: false, error: 'model_delete_failed', model_id: id, removed, failed,
          deactivated, references: referencesWarning, state_cleared: false,
        });
      }
      modelState.forget(id);
      await invalidateLocal();
      const consumerRefresh = await refreshSpeechConsumer();
      changeSeqBump();
      return send(res, 200, {
        ok: true, model_id: id, removed,
        local_generated: localRemoved,
        prepared_companions: preparedCompanionsRemoved,
        failed: [], deactivated, references: referencesWarning, state_cleared: true,
        consumer_refresh: consumerRefresh,
      });
    }

    /**
     * ⭐ **消费方唯一需要的那一条**（docs/093 §15）。
     *
     * termux-speech 只说「我要 model.sensevoice」，这里回答
     * 「当前可用的可执行体是什么、它的伴随文件在哪」。
     * ⛔ 消费方**不该**知道那是预制还是本机编的、target 是 v73 还是 v79、
     *   文件叫 `model.onnx` 还是 `model_ir11.onnx` —— 那些全部在这一层之下。
     * ⚠ 消费方也⛔ 不许直接读 Manager 的 state JSON 文件：那是实现细节，
     *   而这条 API 是契约。
     */
    const modelResolve = route.match(/^\/models\/([^/]+)\/resolve$/);
    if (modelResolve && req.method === 'GET') {
      const id = decodeURIComponent(modelResolve[1]);
      const model = modelsView().models.find((m) => m.model_id === id);
      if (!model) return send(res, 404, { ok: false, error: 'unknown_model', model_id: id });
      return send(res, 200, { ok: true, ...resolveDescriptor(model) });
    }

    /**
     * ⭐ **使用**：把已下载的资源变成「这台机器上真的能跑的东西」。
     *
     * 全部执行由 App 完成（load / 编译 / minimal inference）；
     * Manager 只做三件事：**决定用哪条 artifact、按 §10 做 fallback、把结果原子落盘**。
     * ⛔ 删除 source ONNX 只发生在**状态写盘成功之后**（§16 的五步）。
     */
    const modelUse = route.match(/^\/models\/([^/]+)\/use$/);
    if (modelUse && req.method === 'POST') {
      const id = decodeURIComponent(modelUse[1]);
      const model = modelsView().models.find((m) => m.model_id === id);
      if (!model) return send(res, 404, { ok: false, error: 'unknown_model', model_id: id });
      const { operation, deduplicated } = operations.start('use', id, async ({ setStage, setProgress }) => {
        setStage('resolving');
        modelState.notePreparing(id, { modelVersion: model.version });
        changeSeqBump();
        try {
          const result = await useModel(model, setStage, setProgress);
          changeSeqBump();
          return result;
        } catch (error) {
          modelState.noteFailed(id, { stage: 'manager', error: String(error?.message ?? error) });
          changeSeqBump();
          throw error;
        }
      });
      return send(res, 202, { ok: true, deduplicated, operation });
    }

    // ── 页面用的一个热端点 ──────────────────────────────────────────────
    if (route === '/live' && req.method === 'GET') {
      /**
       * ⭐ **只读快照，永不等远端。** 参考机上 Framework 的 `/api/assets` 要 12.5 秒、
       * `/api/packages` 要 28.3 秒；只要这里同步去打它们，一个 feed 源就会周期性变成数秒级，
       * 而轮询会首尾相接地叠起来。刷新在后台按 TTL 走（见 hotstate.mjs）。
       * ⚠ 旧到什么程度是**说出来的**：`sources.*.age_ms` / `stale` / `known`。
       */
      const cat = catalogOf();
      const inv = inventoryOf();
      const decl = declaredOf();
      const bytes = payloadBytesByAsset(decl.manifests, inv);
      const assets = allAssetIds(cat, inv).map((id) => {
        const a = mergeAsset(id, {
          project: cat.available ? projectForAsset(cat, id, decl) : null,
          upstream: null,                       // ⛔ 列表不打外网；上游信息走 /asset?id= 或 check-update
          localEntry: inv.byId.get(id) ?? null,
          frameworkAvailable: inv.available,
          registryAvailable: cat.available,
        });
        // ⭐ 模型有多大，来自描述包的 manifest；registry 那个数说的是归档。
        return enrichAsset(a, { decl, bytes });
      });
      const lm = modelsView();
      return send(res, 200, {
        ok: true,
        schema: 'termux-os.assets-live.v1',
        change_seq: changeSeq,
        /** ⭐ docs/092：logical model 是**产品**要显示的东西；下面的 assets 是它的内部构成。 */
        models: lm.models,
        device: { target: lm.target, known: lm.device_known, app: lm.app },
        /** ⭐ 首屏统计数的是**模型**（§6），⛔ 不是内部 artifact 数。 */
        model_summary: lm.summary,
        /** feed 游标：消费方拿它去 `/events?after=`，⛔ 不必轮询整个列表。 */
        event_cursor: events.seq,
        sources: freshness(),
        counts: {
          assets: assets.length,
          installed: assets.filter((a) => a.local.installed).length,
          updates: assets.filter((a) => a.update_state === APPROVED_UPDATE).length,
        },
        assets,
        operations: operations.snapshot(10),
      });
    }

    return send(res, 404, { ok: false, error: 'not_found', route });
  } catch (error) {
    return send(res, 500, { ok: false, error: 'internal', detail: String(error?.message ?? error) });
  }
});

/**
 * ⭐ 后台刷新。⚠ 每 5 秒**检查一次是否到期**，不是每 5 秒真的去打远端——
 * 到期与否由每层自己的 TTL 决定（inventory 30 s / catalog 10 min / declared 60 s）。
 */
const refresher = new Refresher([inventoryLayer, catalogLayer, declaredLayer], { intervalMs: 5_000 });
refresher.start();

server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address().port;
  if (STATUS_FILE) {
    try {
      fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
      fs.writeFileSync(STATUS_FILE, JSON.stringify({
        schema: 'termux-os.service-status.v1', service: 'hf-model-manager',
        state: 'ready', port: bound, started_at: new Date().toISOString(),
      }, null, 2));
    } catch { /* 状态文件写不下不该拦住服务 */ }
  }
  console.log(`[hf-model-manager] listening on 127.0.0.1:${bound}`);
  console.log(`[hf-model-manager] registry=${REGISTRY_URL} store=${STORE}`);
  console.log(`[hf-model-manager] framework=${local.configured ? 'configured' : 'NO CREDENTIALS'}`);
});
