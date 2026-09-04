/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个 logical model 的**两类事实**：Framework 账本说盘上有什么 + Manager state 说准备到哪一步
 * [OUTPUT]: `userStatus(model)` —— 使用者看到的那一个状态词，外加缺什么、能不能点「使用」
 * [POS]: docs/094 §3–§4。⭐ **纯函数，没有 IO**。
 *
 * ⭐ **为什么必须有这一层**：Manager 的 state JSON 只记录「这个使用者点过什么」，
 *   它对「盘上有没有文件」一无所知。于是一台早就装满模型的机器，
 *   在没点过新版「下载」按钮之前，每个模型都写着**未下载** —— 每个字段单看都诚实，
 *   合起来是一句假话。
 * ⭐ **状态必须由事实合成**：账本负责「有没有」，state 负责「准备到哪一步」，
 *   谁也不能单独回答使用者的问题。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const NOT_DOWNLOADED = 'not_downloaded';
export const DOWNLOADING = 'downloading';
export const PARTIAL = 'partial';
export const DOWNLOADED = 'downloaded';
export const PREPARING = 'preparing';
export const ENABLED = 'enabled';
export const FAILED = 'failed';

/**
 * 一个 logical model 的**可执行体候选**：预制（非 legacy）+ 源。
 *
 * ⚠ legacy 预制不算候选（CAM++ 的 v73 ctx 就是这种）：旧安装继续能用，
 *   ⛔ 但它不该让一个模型看起来「已经准备好了」，也不该影响推荐。
 */
export const executableCandidates = (model) => [
  ...(model?.prebuilt ?? []).filter((p) => p.legacy !== true),
  ...(model?.source ? [model.source] : []),
];

/** 必需伴随（`optional !== true`）。⛔ 缺一个，这个模型就跑不起来。 */
export const requiredCompanions = (model) =>
  (model?.companions ?? []).filter((c) => c.optional !== true && c.shadowed !== true);

/**
 * ⭐ **`partial` 的判据**（§4 要求说明依据）。
 *
 * 规则一句话：**装了一部分，而缺的那些不是「另一条可执行体候选」**。
 *
 * 为什么这样定：一个 logical model 通常声明了**好几条通往同一个可执行体的路**
 *   （预制 / 源图 / 另一个 DSP 架构的预制）。少了其中一条**什么都不缺** —— 
 *   使用者已经有一条能走的路了。而少了一个**伴随**（tokenizer、cmvn、解码器权重）
 *   是真的缺东西：那条路走到一半会断。
 * ⛔ 所以判据不能是「有没有未安装的声明」，那会让每个模型永远显示「部分下载」。
 */
export const missingParts = (model) => {
  const out = [];
  for (const c of model?.companions ?? []) {
    if (c.shadowed === true || c.legacy === true) continue;
    if (!c.installed) out.push({ asset_id: c.asset_id, role: c.role ?? 'companion', optional: c.optional === true });
  }
  return out;
};

/**
 * ⭐ 使用者看到的状态。**判据顺序本身就是规则**：
 *
 *   ① 正在做事（downloading / preparing）—— 它压过一切静态事实，
 *      否则使用者点了「下载」之后看到的还是「未下载」。
 *   ② `enabled` —— 但**必须真的有一个可执行体路径**；
 *      ⚠ 只有 state 说 enabled 而路径是空的，那是一条陈旧记录，⛔ 不是「能用」。
 *   ③ `failed` —— 且**文件还在**才叫失败（可以重试）；文件没了就退回下载态。
 *   ④ 剩下的全部由**盘上的事实**决定，⛔ 与 state JSON 无关。
 */
export const userStatus = (model) => {
  const st = model?.state ?? null;
  const candidates = executableCandidates(model);
  const haveExecutable = candidates.some((a) => a.installed);
  const missing = missingParts(model);
  const missingRequired = missing.filter((m) => !m.optional);
  const anyInstalled = haveExecutable
    || (model?.companions ?? []).some((c) => c.installed)
    || (model?.prebuilt ?? []).some((p) => p.installed);

  if (st === DOWNLOADING) return { status: DOWNLOADING, missing, usable: false };
  if (st === PREPARING) return { status: PREPARING, missing, usable: false };
  if (st === ENABLED && model?.executable?.path) return { status: ENABLED, missing, usable: true };
  if (st === FAILED && haveExecutable) return { status: FAILED, missing, usable: true };
  if (!anyInstalled) return { status: NOT_DOWNLOADED, missing, usable: false };
  if (!haveExecutable || missingRequired.length || missing.length) {
    return { status: PARTIAL, missing, usable: haveExecutable && !missingRequired.length };
  }
  return { status: DOWNLOADED, missing, usable: true };
};

/**
 * ⭐ 「使用」按钮能不能点，是**另一个问题**：文件齐了不代表这台机器能验证它。
 *
 * App 只对它有 minimal-inference fixture 的 model 才能给出「准备成功」这个结论
 * （docs/092 §14：成功的定义是 load **加上**一次真实推理）。没有 fixture 时
 * `prepare` 会以 `no_verify_fixture` 失败。
 * ⚠ 与其给一个只会失败的按钮，不如把它禁掉并说出**一句人话**——
 *   一个只会失败的按钮会让人去找 force 开关（与本包 asset 卡的删除按钮同一条规矩）。
 */
export const useBlockedReason = (model, { verifiable = [], appAvailable = true } = {}) => {
  if (!appAvailable) return '本机推理服务暂时读不到，稍后再试。';
  // ⚠ 这里曾有一条 `model.audio8` 的豁免（它走 App 的专用 session endpoint，
  //   不经过 generic prepare 的白名单）。Audio8 已随 0.25.x 退役，
  //   ⛔ 豁免一并删除——留着它等于给「验不了就禁用」这条规则开一个**只对一个已经不存在的
  //   模型生效**的洞，而下一个走专用路径的模型只会照抄这个洞。
  const short = String(model?.model_id ?? '').split('.').pop();
  if (verifiable.length && !verifiable.includes(short)) {
    return '本机暂不支持自动验证这个模型，暂时不能一键启用。';
  }
  return null;
};

/** 首屏那一行统计。⭐ 数的是**模型**，⛔ 不是内部 artifact。 */
export const modelSummary = (models = []) => {
  const n = (s) => models.filter((m) => m.user_status === s).length;
  return {
    total: models.length,
    enabled: n(ENABLED),
    downloaded: n(DOWNLOADED),
    partial: n(PARTIAL),
    not_downloaded: n(NOT_DOWNLOADED),
    busy: n(DOWNLOADING) + n(PREPARING),
    failed: n(FAILED),
    updatable: models.filter((m) => m.update_available === true).length,
  };
};
