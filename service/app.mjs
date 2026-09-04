/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework 的 `termux-os.app.api` Capability（换取 App 的 base_url + 凭证）
 * [OUTPUT]: `AppExecutor` —— Manager 唯一一条通往 App 的低频边：`capabilities()`、`prepare()`、`prepareStatus()`、`deactivate()`
 * [POS]: docs/092 §23–§24。⭐ **这个文件存在的全部意义是一条边界**：
 *
 *   ⛔ Manager 里不许出现 QNN provider option、ORT session option、`ep.context_enable`、
 *     `OrtEngine`、`recycleOrt` 的内部步骤。它只说「这个 logical model、这条 artifact、
 *     验证还是编译」，其余全部是 App 的事。
 *   ⭐ 它**可以**知道 `htp` / `qnn` —— 那两个值用于**推荐与诊断**，
 *     ⛔ 不用于执行，也不用于判定兼容。
 *
 * ⚠ 凭证只在内存里活着，⛔ 不落盘、⛔ 不进日志（与 termux-speech 的同一条规矩）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const DEFAULT_PREPARE_TIMEOUT_MS = 20 * 60 * 1000;

export class AppUnavailable extends Error {
  constructor(message) { super(message); this.code = 'app_unavailable'; }
}

export class AppExecutor {
  constructor({
    frameworkUrl = process.env.TERMUX_OS_FRAMEWORK_URL || '',
    systemKey = process.env.TERMUX_OS_SYSTEM_KEY || '',
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    this.frameworkUrl = frameworkUrl;
    this.systemKey = systemKey;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.descriptor = null;
    this.descriptorAtMs = 0;
    this.lastError = null;
  }

  get configured() { return Boolean(this.frameworkUrl && this.systemKey); }

  /**
   * 换一次 App 描述符。⭐ 缓存 60 秒：App 的 token 会轮换，而这条边是**低频**的
   * （一次「使用」一次），⛔ 没有理由为它常驻一个连接。
   */
  async #describe() {
    if (this.descriptor && this.now() - this.descriptorAtMs < 60_000) return this.descriptor;
    if (!this.configured) throw new AppUnavailable('no Framework credentials in the environment');
    const r = await this.fetchImpl(`${this.frameworkUrl}/api/capabilities/termux-os.app.api/invoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.systemKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {} }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || body?.ok !== true || !body?.value) {
      throw new AppUnavailable(body?.reason ?? body?.error ?? `termux-os.app.api HTTP ${r.status}`);
    }
    let baseUrl;
    try { baseUrl = new URL(body.value.base_url).origin; }
    catch { throw new AppUnavailable('termux-os.app.api returned an invalid base_url'); }
    const authorization = body.value.headers?.Authorization
      ?? (body.value.token ? `Bearer ${body.value.token}` : '');
    if (!authorization) throw new AppUnavailable('termux-os.app.api returned no authorization');
    this.descriptor = { baseUrl, authorization };
    this.descriptorAtMs = this.now();
    return this.descriptor;
  }

  async #call(path, { method = 'GET', body, timeoutMs = 8000 } = {}) {
    const d = await this.#describe();
    const r = await this.fetchImpl(`${d.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: d.authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await r.json().catch(() => null);
    if (!r.ok || payload?.ok !== true) {
      // ⚠ 凭证轮换过就重新换一次描述符——⛔ 不把一次 401 当成「App 没了」。
      if (r.status === 401) this.descriptor = null;
      throw new AppUnavailable(payload?.error ?? `App HTTP ${r.status} ${path}`);
    }
    return payload.data ?? payload.value ?? payload;
  }

  /** 本机能准备哪些 model、执行画像是什么。⭐ `htp`/`qnn` 从这里来，⛔ Manager 不自己探。 */
  async capabilities() {
    try {
      const data = await this.#call('/api/inference/model/prepare');
      this.lastError = null;
      return { available: true, ...data };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return { available: false, error: this.lastError, target: {}, verifiable_models: [] };
    }
  }

  /**
   * 准备一个可执行体。
   *
   * ⚠ **同步调用，可能很久**（编 500 MB 的图是分钟级），所以超时给到 20 分钟；
   *   调用方必须把它包进自己的作业里，⛔ 不要让 HTTP 连接决定使用者看到什么。
   * ⭐ 「准备失败」是一个**正常返回**（`ok:false` + stage + error），⛔ 不是异常：
   *   `load_prebuilt` 失败要去下源 ONNX，`compile` 失败要看内存 —— 调用方得读得到 stage。
   *   只有**够不到 App** 才抛。
   */
  async prepare({ modelId, modelVersion, mode, artifactPath = null, sourcePath = null,
    ctxKey = null, timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS } = {}) {
    return this.#call('/api/inference/model/prepare', {
      method: 'POST',
      timeoutMs,
      body: {
        model_id: modelId,
        model_version: modelVersion,
        mode,
        ...(artifactPath ? { artifact_path: artifactPath } : {}),
        ...(sourcePath ? { source_path: sourcePath } : {}),
        ...(ctxKey ? { ctx_key: ctxKey } : {}),
      },
    });
  }

  /** App 内部的当前准备阶段；只读，不创建 Manager 的第二套作业引擎。 */
  async prepareStatus() {
    return this.#call('/api/inference/model/prepare/status');
  }

  /**
   * 逻辑模型删除前的唯一高层停用入口。Manager 不直接碰 App resident/session，
   * App 负责停止对应执行方并释放实际运行资源，然后返回 active_after 事实。
   */
  async deactivate({ modelId, modelVersion = null, reason = 'model_delete' } = {}) {
    return this.#call('/api/inference/model/deactivate', {
      method: 'POST',
      body: { model_id: modelId, model_version: modelVersion, reason },
      timeoutMs: 120_000,
    });
  }

  snapshot() {
    return {
      configured: this.configured,
      connected: Boolean(this.descriptor),
      last_error: this.lastError,
    };
  }
}
