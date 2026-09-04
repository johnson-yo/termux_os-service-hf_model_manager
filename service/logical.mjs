/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 已装包的 manifest（`assets.provides[]`）+ 本机执行画像（htp / qnn）
 * [OUTPUT]: `logicalModels()` —— 一组 **logical model**，每个带 source / prebuilt / companion 三类 artifact
 * [POS]: docs/092 §2–§6 的 logical model 层。⭐ **它是一个派生，不是一张新表。**
 *
 * ⭐ 为什么是派生：现有 asset id 已经把关系写在名字与 target 里
 *   （`model.sensevoice.ctx` 带 htp target = 预制；`model.sensevoice.graph` 无 target = 源）。
 *   派生出来 ⇒ **零 schema 变更、零迁移、不动任何已发布的 HF 仓库与 URL**（§4）。
 * ⚠ 但派生规则必须写下来并被测试钉住，否则它就是一堆猜测。
 *   需要显式覆盖时，manifest 里加一个**可选**的 `logical` 块即可（向后兼容，见 [declaredLogical]）。
 *
 * ⛔ **local artifact 不在这里**：本机生成的 CTX 不来自 HF、不进公开 manifest，
 *   它是 device-local state（见 `modelstate.mjs`）。把它混进来就等于伪造一个已发布资产。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const ROLE_SOURCE = 'source';
export const ROLE_PREBUILT = 'prebuilt';
export const ROLE_COMPANION = 'companion';

/**
 * Historical logical models remain derivable so old device state and asset
 * references can still be understood, but they must not enter the current
 * model picker. Retirement is a discovery policy, not payload destruction.
 */
/**
 * ⚠ `model.audio8` 随 0.25.x 退役（App 侧的编排与端点已整体删除）。
 * ⭐ 仍然**保留在派生里**、只是不进选项：旧设备上还装着它的 asset，
 *   而一个 Manager 认不出来的已安装资产，比一个明确写着「已退役」的更难处理。
 */
export const RETIRED_LOGICAL_MODEL_IDS = Object.freeze(['model.qwen3asr', 'model.audio8']);
export const isRetiredLogicalModel = (modelOrId) => {
  const id = typeof modelOrId === 'string' ? modelOrId : modelOrId?.model_id;
  return RETIRED_LOGICAL_MODEL_IDS.includes(id);
};

/** 普通卡片只给一句用途；完整 manifest / 供应包说明留给高级信息。 */
const MODEL_COPY = Object.freeze({
  'model.campplus': {
    display_name: 'CAM++',
    user_description: '说话人识别模型；用于声纹特征提取和说话人判断。',
  },
  'model.fireredvad': {
    display_name: 'FireRedVAD',
    user_description: '语音活动检测模型；用于判断当前音频中是否有人说话。',
  },
  'model.qwen3asr': {
    display_name: 'Qwen3-ASR',
    user_description: '语音识别模型；用于语音转文字。',
  },
  'model.sensevoice': {
    display_name: 'SenseVoice',
    user_description: '语音识别模型；用于语音转文字。',
  },
});

/**
 * Qwen3-ASR 的 q4 decoder 虽然旧 manifest 标成 optional，但它与 encoder 共同构成
 * 这个 logical model 的完整产品合同；仅有 encoder 不能运行 ASR。effective contract
 * 在 Manager 聚合层修正，不回写旧 manifest，也不改变 Framework 的通用 optional 语义。
 */
export const isEffectiveRequired = (modelId, assetId) => (
  modelId === 'model.qwen3asr' && assetId === 'model.qwen3asr.decoder.q4'
);

/**
 * asset id → logical model id。
 *
 * ⭐ 规则只有一条：**去掉最后那个角色后缀**。
 *   `model.sensevoice.ctx` / `.graph` / `.frontend` → `model.sensevoice`
 *   `model.audio8.encoder_ctx` / `.decoder`        → `model.audio8`
 *   `model.fireredvad`（没有后缀）                  → `model.fireredvad`
 * ⚠ 判据是「最后一段是不是一个已知角色词」，⛔ 不是「有没有三段」——
 *   `model.fireredvad` 只有两段，而它是一个完整的 logical model。
 */
const ROLE_SUFFIX = new Set([
  'ctx', 'graph', 'frontend', 'decoder', 'encoder', 'encoder_ctx',
  'decoder_ctx', 'q4', 'q8', 'onnx',
]);

export const logicalIdOf = (assetId) => {
  const parts = String(assetId ?? '').split('.');
  if (parts.length <= 2) return String(assetId ?? '');
  const last = parts[parts.length - 1];
  if (!ROLE_SUFFIX.has(last)) return String(assetId);
  const trimmed = parts.slice(0, -1);
  // `model.qwen3asr.decoder.q4` 去掉 `q4` 之后还剩一个角色词，继续去
  const next = trimmed[trimmed.length - 1];
  if (trimmed.length > 2 && ROLE_SUFFIX.has(next)) trimmed.pop();
  return trimmed.join('.');
};

/**
 * 一条 `assets.provides[]` → 它在 logical model 里的角色。
 *
 * ⭐ 判据是 **target 有没有绑硬件**，⛔ 不是名字里有没有 `ctx`：
 *   一个绑了 `htp` 的产物必然是为某台机器预编的，那正是 prebuilt 的定义；
 *   而名字是人写的，改个名就会漂。
 * ⚠ `frontend` / `decoder` / tokenizer 这类是 **companion**：它们必需，
 *   但**不是那个可执行体** —— 分不开的话，「使用」会去 verify 一个 `am.mvn`。
 */
export const roleOf = (provide) => {
  const declared = provide?.logical?.role;
  if (declared === ROLE_SOURCE || declared === ROLE_PREBUILT || declared === ROLE_COMPANION) {
    return declared;
  }
  if (provide?.target?.htp) return ROLE_PREBUILT;
  const last = String(provide?.id ?? '').split('.').pop();
  if (last === 'frontend' || last === 'decoder' || last === 'encoder') return ROLE_COMPANION;
  return ROLE_SOURCE;
};

/** manifest 里可选的显式声明；给的话它**赢过**派生（§4 的向后兼容 schema extension）。 */
export const declaredLogical = (provide) => (provide?.logical ?? null);

/**
 * Runtime companions belong to the prepared logical model, not to App's compiler.
 *
 * The published FireRedVAD 1.0 manifest predates this field, but its existing
 * `files.cmvn` role is stable and the source payload is tiny. Keep that one
 * compatibility inference here until a future manifest can say the same thing
 * explicitly as `logical.runtime_companions: { cmvn: "cmvn.bin" }`.
 */
export const runtimeCompanionRoles = (provide) => {
  const explicit = provide?.logical?.runtime_companions;
  const declared = explicit && typeof explicit === 'object' ? explicit : null;
  const inferred = provide?.id === 'model.fireredvad'
    && typeof provide?.files?.cmvn === 'string'
    ? { cmvn: provide.files.cmvn }
    : {};
  const source = declared ?? inferred;
  return Object.fromEntries(Object.entries(source)
    .filter(([role, file]) => typeof role === 'string' && role
      && typeof file === 'string' && file));
};

/**
 * ⭐ 推荐判断。**只用核心参数**（§6）：htp + qnn。
 *
 * ⛔ 不引入 `model sha256 + ORT + ABI + provider options` 那种指纹——
 *   调查已经确认 ORT 版本从来不在 target 里而 CTX 一直正常复用，
 *   把它加进硬判据只会凭空造出「不推荐」。
 * ⚠ **推荐不是 gate**：`recommended:false` 的候选照样可以下载、可以尝试。
 *   最终兼容性永远以 App 的真实 load + minimal inference 为准。
 */
export const recommendPrebuilt = (target, device) => {
  const want = { htp: target?.htp ?? null, qnn: target?.qnn ?? null };
  const got = { htp: device?.htp ?? null, qnn: device?.qnn ?? null };
  const reasons = [];
  let unknown = false;
  for (const f of ['htp', 'qnn']) {
    if (want[f] === null) continue;                       // 不声明该维 = 不要求
    if (got[f] === null || got[f] === 'unknown') {
      unknown = true;
      reasons.push(`${f}: 这台机器报不出来（预制要求 ${want[f]}）`);
      continue;
    }
    if (String(got[f]).toLowerCase() !== String(want[f]).toLowerCase()) {
      reasons.push(`${f}: 预制是 ${want[f]}，本机是 ${got[f]}`);
    }
  }
  const mismatched = reasons.filter((r) => !r.includes('报不出来'));
  if (mismatched.length) return { recommended: false, verdict: 'mismatch', reasons };
  if (unknown) return { recommended: false, verdict: 'unknown', reasons };
  return { recommended: true, verdict: 'match', reasons: [] };
};

/**
 * 从**已装包的 manifest** 派生全部 logical model。
 *
 * @param manifests `[{ id, manifest }]`，即 `FrameworkAssets.manifestsFromDisk()` 的形状
 * @param device    `{ htp, qnn }`，本机执行画像（由 App 自报）
 */
export const logicalModels = (manifests = [], device = {}) => {
  const byModel = new Map();
  for (const entry of manifests) {
    const m = entry?.manifest;
    for (const provide of (m?.assets?.provides ?? [])) {
      const assetId = provide?.id;
      if (!assetId) continue;
      const explicit = declaredLogical(provide);
      const modelId = explicit?.model_id ?? logicalIdOf(assetId);
      if (!byModel.has(modelId)) {
        const copy = MODEL_COPY[modelId] ?? {};
        const technicalDescription = explicit?.technical_description ?? m?.description ?? null;
        byModel.set(modelId, {
          model_id: modelId,
          display_name: copy.display_name ?? explicit?.display_name
            ?? modelId.split('.').pop().replace(/[-_]/g, ' '),
          /**
           * 一句人话说明它是干什么的（§12）。
           * ⭐ 取**提供包自己的 description**，⛔ 不在界面里硬编码一张模型名→用途表——
           *   那张表会在加第六个模型时静默地漏掉一行，而没有任何东西会报错。
           */
          description: copy.user_description ?? explicit?.purpose ?? m?.description ?? null,
          user_description: copy.user_description ?? explicit?.purpose ?? m?.description ?? null,
          technical_description: technicalDescription,
          version: m?.version ?? null,
          provider_package: m?.id ?? entry?.id ?? null,
          retired: isRetiredLogicalModel(modelId),
          retired_reason: isRetiredLogicalModel(modelId)
            ? '不再属于当前 Termux-OS 支持模型；保留历史资产与设备状态。' : null,
          source: null,
          prebuilt: [],
          companions: [],
        });
      }
      const model = byModel.get(modelId);
      // ⚠ 版本以**提供包**的版本为准；同一个 logical model 的产物必然来自同一个包。
      if (!model.version && m?.version) model.version = m.version;
      const effectiveRequired = isEffectiveRequired(modelId, assetId) || provide?.optional !== true;
      const artifact = {
        asset_id: assetId,
        kind: provide?.kind ?? 'model',
        optional: !effectiveRequired,
        required: effectiveRequired,
        declared_optional: provide?.optional === true,
        target: provide?.target ?? null,
        /**
         * ⭐ **role → 文件名的映射**（manifest 的 `files` 块）。
         * 消费方读 `files.<role>`，⛔ 不再自己拼 `model.onnx` / `model_ir11.onnx`——
         * 那种硬编码在换一个模型时不会报错，只会打开错的文件。
         */
        roles: provide?.files ?? null,
        /** build source 与 runtime companion 的 manifest role 分界。 */
        runtime_companions: runtimeCompanionRoles(provide),
        files: (provide?.source?.files ?? []).map((f) => f?.path).filter(Boolean),
        /**
         * ⚠ **legacy 产物不参与默认选择**（CAM++ 的 v73 ctx 就是这种）：
         * 旧 URL 与旧安装继续有效，⛔ 但新设备不该被引导去下载它。
         */
        legacy: explicit?.legacy === true,
        note: explicit?.note ?? (isEffectiveRequired(modelId, assetId)
          ? '完整 Qwen3-ASR 需要这个解码器；当前 manifest 的 optional 标记只代表可延后下载。'
          : null),
      };
      switch (roleOf(provide)) {
        case ROLE_PREBUILT:
          model.prebuilt.push({
            ...artifact,
            role: ROLE_PREBUILT,
            ...recommendPrebuilt(provide?.target, device),
          });
          break;
        case ROLE_COMPANION:
          model.companions.push({ ...artifact, role: ROLE_COMPANION });
          break;
        default:
          /**
           * ⚠ 一个 logical model 只能有**一个** source。真出现第二个时保留第一个并记下来——
           * ⛔ 静默覆盖会让「本机编译用的到底是哪份原图」永远答不出来。
           */
          if (model.source) model.companions.push({ ...artifact, role: ROLE_SOURCE, shadowed: true });
          else model.source = { ...artifact, role: ROLE_SOURCE };
      }
    }
  }
  return [...byModel.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
};

/** Current user-facing model discovery. Historical derivation stays available
 * to migration/diagnostics, while the product picker only exposes supported
 * logical models. */
export const currentLogicalModels = (manifests = [], device = {}) =>
  logicalModels(manifests, device).filter((model) => !isRetiredLogicalModel(model));

/**
 * 下载时给使用者的选项（§9）。
 * ⭐ 有预制就先给预制（推荐或不推荐都列出来），⛔ 但**永不**因为「不推荐」就把它禁掉。
 * ⚠ 没有 source 时「本地编译」这一项不许出现——那会给出一个必然失败的选择。
 */
const PREBUILT_LABEL = {
  match: '预编译（推荐）',
  mismatch: '预编译（不推荐）',
  unknown: '预编译（兼容性未知）',
};

export const downloadChoices = (model) => {
  const out = [];
  // ⛔ legacy 预制不进选项：它只为兼容旧安装而保留（见 [logicalModels] 的 `legacy`）。
  for (const p of (model?.prebuilt ?? []).filter((x) => x.legacy !== true)) {
    out.push({
      choice: 'prebuilt',
      asset_id: p.asset_id,
      target: p.target?.id ?? null,
      recommended: p.recommended === true,
      verdict: p.verdict ?? 'unknown',
      reasons: p.reasons ?? [],
      /**
       * ⭐ **「不推荐」与「兼容性未知」必须分开**（docs/094 §9）。
       * ⚠ 旧代码只有 `recommended` 一个布尔，于是**读不到本机画像**时
       *   （App 不可达）每一条预制都被写成「不推荐」——
       *   那是一个我们并没有依据做出的**否定断言**，而使用者会照着它选错。
       *   `verdict` 三态早就算出来了，只是没被用上。
       * ⛔ 三种都可以选：最终兼容性永远以 App 的真实加载为准。
       */
      label: PREBUILT_LABEL[p.verdict] ?? PREBUILT_LABEL.unknown,
    });
  }
  if (model?.source) {
    out.push({
      choice: 'source',
      asset_id: model.source.asset_id,
      target: null,
      recommended: out.length === 0,   // 没有预制时它就是唯一且推荐的那条
      reasons: [],
      label: out.length === 0 ? '下载' : '本地编译',
    });
  }
  return out;
};
