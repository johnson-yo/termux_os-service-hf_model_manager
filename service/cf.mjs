/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 公开 Package Registry（Cloudflare）的 `POST /list` `/check` `/details`
 * [OUTPUT]: `catalog()` —— 已批准的 asset 项目，归一化成业务友好的形状
 * [POS]: 三类权威里的 **Registry**：它说了算的只有「哪个版本被批准了、它的字节是什么」
 *        （approved version / revision / size / sha256 / 白名单）。
 *        ⛔ 它不知道上游动没动（那是 HF），也不知道本机装了什么（那是 Framework 账本）。
 *
 * ⚠ 不把 CF 的原始 schema 原样透出去。`projects/versions/files` 是登记侧的形状，
 *   业务方要的是「这个 asset 现在能装哪个版本」；两者一旦混用，
 *   将来 registry 换个形状就会同时打断所有消费方。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const DEFAULT_REGISTRY = 'https://package.termux-os.com';

/** 一次登记的文件。⭐ `sha256` 只有这里有——HF 自己不提供。 */
const normalizeFile = (f) => ({
  kind: f?.kind ?? null,
  name: f?.name ?? null,
  size: Number.isFinite(Number(f?.size)) ? Number(f.size) : null,
  sha256: typeof f?.sha256 === 'string' ? f.sha256 : null,
});

/**
 * 一个可安装的版本。
 * ⚠ `packages[]` 是登记时从归档里抽出来的索引，它告诉我们这个版本**提供哪些 asset id**——
 *   这是把「registry 项目」与「业务要的 asset id」连起来的唯一一根线。
 */
const normalizeVersion = (v) => {
  const files = (v?.files ?? []).map(normalizeFile);
  const indexed = (v?.packages ?? []).flatMap((p) => p?.provides ?? []);
  return {
    version: v?.version ?? null,
    revision: v?.upstream_ref ?? null,
    status: v?.status ?? null,
    published_at: v?.published_at ?? null,
    files,
    total_bytes: files.reduce((n, f) => n + (f.size ?? 0), 0),
    package_id: (v?.packages ?? [])[0]?.package_id ?? null,
    provides: indexed.filter((x) => x?.kind === 'asset').map((x) => x.id),
    installable: files.some((f) => f.kind === 'source_tar' || f.kind === 'release_asset'),
  };
};

export const isSemver = (v) => /^\d+\.\d+\.\d+/.test(String(v ?? ''));

/**
 * ⭐ 两个版本**能不能比大小**。
 *
 * ⚠ 这是一个真机上一直在犯的错：HF asset 项目的 `latest_version` 存的是**git commit SHA**
 *   （实读：sensevoice `65affbbf…`、audio8 `cc17625b…`、campplus `9b51004d…`、qwen3asr `44798330…`），
 *   只有 fireredvad 是 `1.1.0`；而本机装的版本是**包版本**（`3.1.0`）。
 *   拿 commit 去和包版本比，`compareSemver` 会静默落到 `localeCompare` —— 
 *   **不报错，只是稳定地给出一个没有意义的答案**。
 * ⭐ 规则：**只有两边同为 semver 才谈大小**；同为 revision 只谈相等；混着就是不可比。
 */
export const comparable = (a, b) => isSemver(a) && isSemver(b);

/** semver 比较。⛔ 不是字符串序——`0.2.7` 排在 `0.2.10` 前面正是这样来的。 */
export const compareSemver = (a, b) => {
  const parse = (s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return String(a ?? '').localeCompare(String(b ?? ''));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * ⭐ 一个项目里「哪个是最新可安装版本」。
 *
 * ⚠ 只看 **installable**（真的带归档）且 `status==='verified'` 的版本。
 *   asset 项目里还躺着以 commit sha 当版本名的 payload 行（只有 `model_file`），
 *   把它们算进来，`latest` 会变成一串 40 位十六进制。
 */
export const latestInstallable = (versions) => versions
  .filter((v) => v.installable && v.status === 'verified')
  .sort((a, b) => compareSemver(a.version, b.version))
  .at(-1) ?? null;

const normalizeProject = (p) => {
  const versions = (p?.versions ?? []).map(normalizeVersion);
  const latest = latestInstallable(versions);
  return {
    /** ⭐ source 来自 registry 的字段，⛔ 绝不从 package id 前缀猜（本包的验收点之一）。 */
    source: p?.source ?? null,
    repository: p?.repository ?? null,
    package_id: p?.package_id ?? latest?.package_id ?? null,
    display_name: p?.display_name ?? null,
    description: p?.description ?? '',
    homepage: p?.homepage ?? '',
    types: p?.types ?? [],
    official: p?.official ?? [],
    updated_at: p?.updated_at ?? null,
    latest,
    versions,
    /** 这个项目一共供应哪些 asset id（取自最新可安装版本的索引）。 */
    provides: latest?.provides ?? [],
  };
};

export class RegistryAdapter {
  constructor({ base = DEFAULT_REGISTRY, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
    this.lastOkAtMs = null;
  }

  async #post(path, body) {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || data?.error || `registry HTTP ${response.status}`);
    }
    return data;
  }

  /**
   * 全部 asset 项目。
   * ⚠ CF 不可用时**不抛**：返回 `{ available:false }`，让调用方仍然能显示已安装的东西。
   *   一个远端挂掉就整页空白，比慢一点糟糕得多（任务书 §20）。
   */
  async catalog({ source = 'huggingface' } = {}) {
    try {
      const data = await this.#post('/list', {});
      this.lastError = null;
      this.lastOkAtMs = Date.now();
      const projects = (data.packages ?? [])
        .map(normalizeProject)
        .filter((p) => (p.types ?? []).includes('asset'))
        .filter((p) => (source ? p.source === source : true));
      return {
        available: true,
        registry_version: data.registry_version ?? null,
        generated_at: data.generated_at ?? null,
        projects,
      };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: 'registry_unavailable', detail: this.lastError, projects: [] };
    }
  }

  snapshot() {
    return { base: this.base, last_ok_at_ms: this.lastOkAtMs, last_error: this.lastError };
  }
}

export const __test = { normalizeProject, normalizeVersion, normalizeFile };
