/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 本包的 `/live` `/asset*` `/unmanaged`（经 Framework Browser Session）
 * [OUTPUT]: 一页可用的模型管理界面：状态、下载/更新/校验/删除、进行中的操作、历史目录
 * [POS]: ⛔ 不是调试仪表盘。raw JSON、CF 内部字段、账本结构都不出现在这里。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const pathPackageId = () => {
  const m = location.pathname.match(/^\/packages\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : 'github.termux-os.service.hf-model-manager';
};
const PKG = `/api/packages/${pathPackageId()}`;
const $ = (id) => document.getElementById(id);
/**
 * ⚠ `window.TermuxOS` 由 `/admin/session.js` 提供，它必须在 app.js **之前**加载。
 * 漏了那一行的表现是整页停在「正在读取…」——既不是错误也不是空数据，
 * 而是一个永远不会结束的初始状态。所以这里显式检查并说出原因。
 */
const api = (p, options = {}) => {
  if (!window.TermuxOS?.api) throw new Error('Browser Session 未加载（缺 /admin/session.js）');
  return window.TermuxOS.api(PKG + p, options);
};
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const mb = (n) => (Number.isFinite(Number(n)) && Number(n) > 0
  ? (Number(n) >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`)
  : '—');
const when = (s) => (s ? String(s).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16) : '—');
const bytesText = (done, total) => (Number.isFinite(Number(total)) && Number(total) > 0
  ? `${mb(done)} / ${mb(total)}` : '');
const progressValue = (o) => (Number.isFinite(Number(o?.progress))
  ? Math.max(0, Math.min(100, Number(o.progress))) : null);
const progressBlock = (o, compact = false) => {
  if (!o) return '';
  const p = progressValue(o);
  const bytes = bytesText(o.bytes_done, o.bytes_total);
  return `<div class="progress-wrap${compact ? ' compact' : ''}">
    ${p === null ? '' : `<div class="progress-track" aria-label="${p}%"><div class="progress-fill" style="width:${p}%"></div></div>`}
    <div class="row between note tiny"><span>${esc(stageText(o))}</span><span>${p === null ? '' : `${p}%`}${bytes ? ` · ${esc(bytes)}` : ''}</span></div>
  </div>`;
};
const MODEL_ASSET_LABEL = {
  'model.campplus.graph': '模型图',
  'model.campplus.ctx': '预编译模型',
  'model.fireredvad': 'VAD 模型',
  'model.qwen3asr.encoder': '编码器',
  'model.qwen3asr.decoder.q4': '解码器（q4）',
  'model.qwen3asr.decoder.q8': '解码器（q8）',
  'model.sensevoice.frontend': '前端资源',
  'model.sensevoice.ctx': '预编译模型',
  'model.sensevoice.graph': '源模型图',
};
const assetLabel = (id) => MODEL_ASSET_LABEL[id] ?? '模型部件';

/** ⭐ 人话来源名。⛔ 绝不从 package id 前缀推——历史包 id 写着 github，实际在 HF。 */
const SOURCE_LABEL = { huggingface: 'Hugging Face', github: 'GitHub' };

let busy = new Set();

const stateBadge = (a) => {
  if (!a.local.known) return '<span class="badge warn">状态未知</span>';
  if (!a.local.installed) return '<span class="badge">未安装</span>';
  if (a.local.ready === false) return `<span class="badge bad">不可用</span>`;
  return '<span class="badge ok">已安装</span>';
};
const updateBadge = (a) => {
  if (a.update_state === 'approved_update_available') return '<span class="badge warn">有新版本</span>';
  if (a.update_state === 'upstream_changed_unapproved') return '<span class="badge">上游有改动</span>';
  return '';
};

const renderAssets = (data) => {
  const box = $('assets');
  box.innerHTML = '';
  for (const a of data.assets ?? []) {
    const refs = a.references ?? [];
    const el = document.createElement('div');
    el.className = 'item';
    const canRemove = a.local.installed && a.local.fetched_on_demand && refs.length === 0;
    /**
     * ⚠ 被引用时按钮**禁用并说出被谁用**，而不是让人点下去再收到一个 409。
     * 一个只会失败的按钮，会让人去找 force 开关。
     */
    const removeNote = refs.length
      ? `<span class="note tiny">被 ${refs.length} 个 package 使用：${esc(refs.map((r) => r.consumer_package_id).join('、'))}</span>`
      : (a.local.installed && !a.local.fetched_on_demand
        ? '<span class="note tiny">随包安装，删除请卸载提供它的包</span>' : '');
    el.innerHTML = `
      <div class="row between">
        <h3>${esc(a.display_name || a.asset_id)}</h3>
        <span>${stateBadge(a)} ${updateBadge(a)}</span>
      </div>
      <p class="note tiny">${esc(a.asset_id)}</p>
      <dl class="facts">
        <dt>来源</dt><dd>${esc(SOURCE_LABEL[a.source] ?? a.source ?? '未登记')}</dd>
        <dt>已安装</dt><dd>${esc(a.local.version ?? '—')}</dd>
        <dt>可安装</dt><dd>${esc(a.registry.approved_version ?? '—')}</dd>
        <dt>更新</dt><dd>${esc(a.update_label ?? '')}</dd>
        <dt>大小</dt><dd>${mb(a.payload_bytes)}</dd>
        <dt>适配</dt><dd>${esc(a.local.target ?? '—')}</dd>
        <dt>本地位置</dt><dd class="path">${esc(a.local.path ?? '—')}</dd>
      </dl>
      <div class="row" style="margin-top:8px">
        ${a.local.installed ? '' : `<button data-act="install" data-id="${esc(a.asset_id)}">下载</button>`}
        ${a.update_state === 'approved_update_available' ? `<button data-act="install" data-id="${esc(a.asset_id)}">更新</button>` : ''}
        ${a.local.installed ? `<button class="ghost" data-act="verify" data-id="${esc(a.asset_id)}">校验</button>` : ''}
        ${a.local.installed ? `<button class="ghost" data-act="remove" data-id="${esc(a.asset_id)}" ${canRemove ? '' : 'disabled'}>删除</button>` : ''}
        ${removeNote}
      </div>`;
    box.appendChild(el);
  }
  if (!(data.assets ?? []).length) box.innerHTML = '<p class="note">目录里没有可显示的模型。</p>';
};

/**
 * ⭐ **没有操作时整块不存在**（§15）。
 * ⚠ 一张常驻的「没有正在进行的操作」卡，占掉的是第一屏最贵的位置，
 *   而它传达的信息量是零。
 */
const renderOps = (ops) => {
  const box = $('ops');
  const card = $('ops-card');
  const list = (ops?.operations ?? []).filter((o) => o.state !== 'complete' || Date.now() - o.updated_at_ms < 20_000);
  if (!list.length) { card.hidden = true; box.innerHTML = ''; return; }
  card.hidden = false;
  box.innerHTML = list.map((o) => `
    <div class="item">
      <div class="row between">
        <h3>${esc(o.action)} · ${esc(o.asset_id)}</h3>
        <span class="badge ${o.state === 'failed' ? 'bad' : o.state === 'complete' ? 'ok' : 'warn'}">${esc(o.state)}</span>
      </div>
      ${progressBlock(o)}
      <p class="note tiny">${o.error ? esc(o.error) : ''}</p>
    </div>`).join('');
};


/**
 * Framework 下载用真实 bytes/total；App prepare 用真实 stage 映射出的百分比。
 * 两者都由服务端标记精度，页面不自行按时间推算。
 */
const stageText = (o) => {
  const stages = Array.isArray(o.stages) ? o.stages : [];
  const label = {
    resolving: '解析中', downloading: '下载中', verifying: '校验中', done: '完成',
    validate_input: '检查输入', release_runtime: '释放运行资源', load_prebuilt: '加载预编译模型',
    compile: '本机编译', load_generated: '加载生成产物', inference_verify: '真实推理验证',
    restore_runtime: '恢复运行资源',
  }[o.stage] ?? (o.stage ?? '—');
  const i = stages.indexOf(o.stage);
  return i >= 0 && stages.length ? `第 ${i + 1}/${stages.length} 步：${label}` : `阶段：${label}`;
};

/** 一层数据有多旧。⚠ 「不知道」与「旧」是两回事，必须分开说。 */
const ageText = (name, layer) => {
  if (!layer) return `${name} —`;
  if (!layer.known) return `${name} 不可用${layer.last_error ? '' : '（尚未读到）'}`;
  const ms = layer.age_ms ?? 0;
  const ago = ms < 1500 ? '刚刚' : ms < 60_000 ? `${Math.round(ms / 1000)} 秒前` : `${Math.round(ms / 60_000)} 分钟前`;
  return `${name} ${ago}${layer.stale ? ' ⚠已过期' : ''}`;
};

/**
 * ⭐ docs/094：**使用者管理的是「模型」，不是「文件」。**
 *
 * 主卡只回答五件事：在不在、能不能用、版本是什么、怎么下载、怎么删。
 * ⛔ CTX / EPContext / QNN / HTP v73 / asset id / 绝对路径 / sha256 / target
 *   一个都不出现在主卡上——它们全部在「高级信息」的 `<details>` 里，默认收起。
 */
const MODEL_STATE_TEXT = {
  not_downloaded: '未下载',
  downloading: '下载中',
  partial: '部分下载',
  downloaded: '已下载',
  preparing: '准备中',
  enabled: '已启用',
  failed: '启用失败',
};
const BADGE_CLASS = {
  enabled: 'good', failed: 'bad', downloaded: 'ok',
  preparing: 'warn', downloading: 'warn', partial: 'warn',
};
const KIND_TEXT = { prebuilt: '预编译', local: '本机编译', source: '源模型' };

/**
 * ⭐ **本地编译提示只在它就要发生时说**（§16）。
 * ⚠ 旧版把它复制到每一张卡上，于是三张卡说着同一句与当下无关的话——
 *   一句到处都在的提示，等于没有提示。
 */
const COMPILE_HINT = '首次使用可能需要在本机准备模型，期间部分 NPU 功能会暂时不可用。'
  + '失败后可以重新点「使用」，<strong>无需重新下载</strong>。';

const modelSummaryText = (sm) => {
  if (!sm) return '正在读取…';
  const bits = [`${sm.total} 个模型`];
  if (sm.enabled) bits.push(`${sm.enabled} 个已启用`);
  if (sm.downloaded) bits.push(`${sm.downloaded} 个已下载`);
  if (sm.partial) bits.push(`${sm.partial} 个部分下载`);
  if (sm.not_downloaded) bits.push(`${sm.not_downloaded} 个未下载`);
  if (sm.failed) bits.push(`${sm.failed} 个启用失败`);
  if (sm.busy) bits.push(`${sm.busy} 个进行中`);
  if (sm.updatable) bits.push(`${sm.updatable} 个可更新`);
  return bits.join(' · ');
};

/**
 * 「下载」是一个**动作**，「预编译还是本地编译」是这个动作的**参数**（§8）。
 * ⚠ 旧版把两个选项与「使用」并排放在主卡上，于是使用者第一眼要做的
 *   是一道关于编译方式的选择题——而他只是想要这个模型。
 * ⭐ 所以主卡只有一个「下载」，点开才展开方式；只有一个选项时不问，直接下。
 */
const choicesBlock = (m) => {
  const cs = m.choices ?? [];
  if (cs.length <= 1) return '';
  const willCompile = cs.some((c) => c.choice === 'source');
  return `<div class="choices" id="ch-${esc(m.model_id)}" hidden>
    <p class="note tiny">选择准备方式：</p>
    ${cs.map((c, i) => `<label class="choice">
      <input type="radio" name="ch-${esc(m.model_id)}" value="${esc(c.choice)}" data-choice-kind="${esc(c.choice)}" ${i === 0 ? 'checked' : ''}>
      <span>${esc(c.label)}</span>
      ${c.reasons?.length ? `<span class="note tiny">${esc(c.reasons.join('；'))}</span>` : ''}
    </label>`).join('')}
    ${willCompile ? `<p class="note tiny compile-hint" hidden>${COMPILE_HINT}</p>` : ''}
    <button data-model="${esc(m.model_id)}" data-go="download">开始下载</button>
  </div>`;
};

/**
 * ⭐ **「详情」与「高级信息」是两层**（§12）。
 * 详情说人话（名称/用途/版本/状态/方式/已下载了什么）；
 * 高级信息才是 logical model id / 可执行体 / target / 文件路径，且再套一层默认收起。
 */
const detailsBlock = (m) => {
  const parts = m.installed_parts ?? [];
  const missing = (m.missing ?? []).filter((x) => !x.optional);
  const missingOpt = (m.missing ?? []).filter((x) => x.optional);
  const installedBytes = parts.reduce((sum, x) => sum + (Number(x.bytes) || 0), 0);
  return `<details class="detail">
    <summary>详情</summary>
    <dl class="kv">
      <dt>名称</dt><dd>${esc(m.display_name)}</dd>
      ${m.user_description || m.description ? `<dt>用途</dt><dd>${esc(m.user_description || m.description)}</dd>` : ''}
      <dt>版本</dt><dd>${esc(m.version ?? '—')}</dd>
      <dt>状态</dt><dd>${esc(MODEL_STATE_TEXT[m.user_status] ?? m.user_status)}</dd>
      <dt>方式</dt><dd>${esc(m.executable ? (KIND_TEXT[m.executable.kind] ?? m.executable.kind) : '—')}</dd>
      <dt>已下载</dt><dd>${parts.length ? `${parts.length} 个部件${installedBytes ? ` · ${mb(installedBytes)}` : ''}` : '—'}</dd>
    </dl>
    ${missing.length ? `<p class="note tiny bad">还缺：${esc(missing.map((x) => assetLabel(x.asset_id)).join('、'))}</p>` : ''}
    ${missingOpt.length ? `<p class="note tiny">可选未下载：${esc(missingOpt.map((x) => assetLabel(x.asset_id)).join('、'))}</p>` : ''}
    <details class="detail">
      <summary>高级信息</summary>
      <dl class="kv">
        <dt>模型 ID</dt><dd class="path">${esc(m.model_id)}</dd>
        <dt>提供包</dt><dd class="path">${esc(m.provider_package ?? '—')}</dd>
        <dt>技术说明</dt><dd>${esc(m.technical_description ?? '—')}</dd>
        <dt>可执行体</dt><dd class="path">${esc(m.executable?.path ?? '—')}</dd>
        <dt>适配</dt><dd>${esc(parts.map((x) => x.target).filter(Boolean).join('、') || '—')}</dd>
      </dl>
      <ul class="tiny">${parts.map((x) => `<li class="path">${esc(x.asset_id)} · ${esc(x.path ?? '—')}</li>`).join('')}</ul>
    </details>
  </details>`;
};

/**
 * ⭐ **主动作只有一个**（§10）。
 *   未下载/部分下载 → 下载；已下载 → 使用；准备中 → 禁用；失败 → 重试使用；
 *   已启用 → **不显示普通的「使用」**（那个词在这里没有意义）。
 * ⚠ 「使用」在**文件齐了但本机验不了**时禁用并说出一句人话——
 *   一个只会失败的按钮会让人去找 force 开关。
 */
const actions = (m) => {
  const st = m.user_status;
  const id = esc(m.model_id);
  const one = (m.choices ?? []).length === 1;
  const out = [];
  if (st === 'preparing') out.push('<button disabled>准备中…</button>');
  else if (st === 'downloading') out.push('<button disabled>下载中…</button>');
  else if (st === 'enabled') { /* ⛔ 已启用不给「使用」：语义不清（§10） */ }
  else if (st === 'not_downloaded' || st === 'partial') {
    out.push(`<button data-model="${id}" data-go="${one ? 'download' : 'choices'}">下载</button>`);
  } else if (m.use_blocked_reason) {
    out.push('<button disabled>使用</button>');
  } else if (m.usable) {
    out.push(`<button data-model="${id}" data-go="use">${st === 'failed' ? '重试使用' : '使用'}</button>`);
  }
  if ((m.installed_parts ?? []).length) {
    out.push(`<button class="ghost" data-model="${id}" data-go="delete">删除</button>`);
  }
  return out.join(' ');
};

function renderModels(data) {
  const box = $('models');
  if (!box) return;
  const models = data?.models ?? [];
  const dev = data?.device ?? {};
  const t = dev.target ?? {};
  /**
   * ⚠ 本机画像读不到**只影响预制的推荐判断**（§7），
   *   它⛔ 不是一个该常驻在产品页顶部的红色异常——那句话对使用者不可执行。
   *   影响会出现在下载选项里（「预编译（兼容性未知）」），原因留在高级里。
   */
  $('device').textContent = dev.known
    ? `本机：${t.soc ?? '—'} · HTP ${t.htp ?? '未知'} · QNN ${t.qnn ?? '未知'}`
    : `本机执行画像读不到（${dev.app?.last_error ?? 'App 不可达'}）——预编译候选将标为「兼容性未知」`;
  $('summary').textContent = modelSummaryText(data?.model_summary);
  if (!models.length) { box.innerHTML = '<p class="note">没有已声明的模型。</p>'; return; }
  box.replaceChildren(...models.map((m) => {
    const el = document.createElement('article');
    el.className = 'model';
    const st = m.user_status;
    const line = [m.version ? `版本 ${m.version}` : null,
      m.executable ? (KIND_TEXT[m.executable.kind] ?? m.executable.kind) : null]
      .filter(Boolean).join(' · ');
    const hint = st === 'preparing'
      ? `<p class="note tiny">正在准备模型。${COMPILE_HINT}请勿关闭页面或重复点击。</p>`
      : (m.use_blocked_reason ? `<p class="note tiny">${esc(m.use_blocked_reason)}</p>` : '');
    const failure = st === 'failed' && m.diagnostics?.last_error
      ? `<p class="note tiny bad">上次失败（${esc(m.diagnostics.last_failure_stage ?? '—')}）：`
        + `${esc(m.diagnostics.last_error)}</p>` : '';
    const operation = m.operation && m.operation.state !== 'complete' && m.operation.state !== 'failed'
      ? progressBlock(m.operation, true) : '';
    el.innerHTML = `
      <div class="row between">
        <strong>${esc(m.display_name)}</strong>
        <span class="badge ${BADGE_CLASS[st] ?? ''}">${esc(MODEL_STATE_TEXT[st] ?? st)}</span>
      </div>
      <p class="note tiny">${esc(line || '—')}</p>
      ${hint}
      ${failure}
      ${operation}
      <div class="row" style="margin-top:8px">${actions(m)}</div>
      ${choicesBlock(m)}
      ${detailsBlock(m)}`;
    return el;
  }));
}

const refresh = async () => {
  try {
    const data = await (await api('/live')).json();
    if (!data.ok) throw new Error(data.error ?? 'unavailable');
    const s = data.sources ?? {};
    // ⭐ 首屏统计在 renderModels 里按 **logical model** 写（§6）；
    //    ⛔ 内部 artifact 的「8/12 已安装」只留在高级区。
    $('assets-sum').textContent =
      ` · ${data.counts.installed}/${data.counts.assets} 已安装 · ${data.counts.updates} 个可更新`;
    /**
     * ⚠ 每个远端的可用性都要说出来：少了一类信息与「一切正常」必须能分开。
     * ⭐ 而且要说**多旧**——这一页读的是快照，永不等远端；
     *   把陈旧数据不加标记地显示出来，会让人以为自己看到的是此刻。
     */
    $('sources').textContent = [
      ageText('本机账本', s.inventory),
      ageText('目录', s.catalog),
      ageText('依赖声明', s.declared),
      s.registry_available ? null : '目录不可用',
      s.framework_available ? null : '本机账本不可用',
    ].filter(Boolean).join(' · ');
    renderModels(data);
    renderAssets(data);
    renderOps(data.operations);
  } catch (error) {
    $('summary').textContent = `读取失败：${String(error?.message ?? error)}`;
  }
};

/**
 * ⭐ **删除按 logical model 解释**（§11）：使用者删的是「SenseVoice」，
 *   ⛔ 不是 `model.sensevoice.graph`。确认文案里也不出现内部 id。
 */
const confirmDelete = (m) => window.confirm(
  `删除 ${m} 后，对应功能会暂时不可用。\n重新下载并启用后即可恢复。\n\n确认删除这个模型吗？`);

document.addEventListener('click', async (event) => {
  // ── docs/094：logical model 的产品动作：下载 / 使用 / 删除 ──────────
  const mb = event.target.closest('button[data-model]');
  if (mb && !mb.disabled) {
    const id = mb.dataset.model;
    const go = mb.dataset.go;
    /**
     * ⭐ 「下载」先展开方式，⛔ 不直接开始（§8）。
     *   只有一个选项时 `actions()` 已经把 go 设成 download，这里不会走到。
     */
    if (go === 'choices') {
      const box = document.getElementById(`ch-${id}`);
      if (box) box.hidden = !box.hidden;
      return;
    }
    if (go === 'delete') {
      const name = mb.closest('.model')?.querySelector('strong')?.textContent ?? id;
      if (!confirmDelete(name)) return;
    }
    mb.disabled = true;
    try {
      const q = `?id=${encodeURIComponent(id)}`;
      let r;
      if (go === 'delete') r = await api(`/model${q}`, { method: 'DELETE' });
      else if (go === 'use') r = await api(`/model/use${q}`, { method: 'POST', body: '{}' });
      else {
        const picked = document.querySelector(`input[name="ch-${id}"]:checked`);
        r = await api(`/model/download${q}`, { method: 'POST',
          body: JSON.stringify(picked ? { choice: picked.value } : {}) });
      }
      const data = await r.json();
      if (!data.ok) {
        alert(data.error === 'deactivate_failed'
          ? `暂时不能删除：运行中的功能还没有释放。\n${data.detail ?? ''}`
          : data.error === 'model_delete_failed'
            ? `删除未完成：${(data.failed ?? []).map((x) => x.error).join('、') || '部分文件清理失败'}\n已保留状态，稍后可重试。`
            : `失败：${data.error ?? r.status}`);
      }
    } catch (error) {
      alert(`失败：${String(error?.message ?? error)}`);
    } finally {
      mb.disabled = false;
      void refresh();
    }
    return;
  }
  const b = event.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const { act, id } = b.dataset;
  if (busy.has(id)) return;
  if (act === 'remove' && !window.confirm(`删除 ${id} 的本地文件？`)) return;
  busy.add(id);
  b.disabled = true;
  try {
    const q = `?id=${encodeURIComponent(id)}`;
    const r = act === 'remove'
      ? await api(`/asset${q}`, { method: 'DELETE' })
      : await api(`/asset/${act === 'install' ? 'install' : 'verify'}${q}`, { method: 'POST', body: '{}' });
    const data = await r.json();
    if (!data.ok) {
      // ⭐ 被引用挡下时把「谁在用」直接说出来，而不是只报一个错误码。
      const who = (data.referenced_by ?? []).map((x) => x.consumer_package_id).join('、');
      alert(data.error === 'asset_in_use' ? `不能删除：${who} 正在依赖它。` : `失败：${data.error ?? r.status}`);
    }
  } catch (error) {
    alert(`失败：${String(error?.message ?? error)}`);
  } finally {
    busy.delete(id);
    b.disabled = false;
    void refresh();
  }
});

/** 本地编译是下载方式的一个选择；默认的预编译选项不应先显示它的警告。 */
document.addEventListener('change', (event) => {
  const input = event.target.closest('input[type="radio"][data-choice-kind]');
  if (!input) return;
  const hint = input.closest('.choices')?.querySelector('.compile-hint');
  if (hint) hint.hidden = input.dataset.choiceKind !== 'source';
});

/**
 * ⭐ 真的去打远端。⚠ 这可能要几十秒（Framework 的 `/api/assets` 在参考机上 12.5 秒），
 * 所以按钮必须当场变成「取回中…」并禁用——否则使用者会以为没反应而连点。
 */
$('hard-refresh').addEventListener('click', async (event) => {
  const b = event.currentTarget;
  const label = b.textContent;
  b.disabled = true; b.textContent = '取回中…';
  try { await api('/refresh', { method: 'POST', body: '{}' }); }
  catch (error) { $('summary').textContent = `取回失败：${String(error?.message ?? error)}`; }
  finally { b.disabled = false; b.textContent = label; void refresh(); }
});
$('scan').addEventListener('click', async () => {
  const box = $('unmanaged');
  box.innerHTML = '<p class="note">扫描中…</p>';
  try {
    const d = await (await api('/unmanaged')).json();
    $('unmanaged-sum').textContent = ` · ${mb(d.total_bytes)}`;
    box.innerHTML = (d.items ?? []).map((i) => `
      <div class="item">
        <div class="row between"><h3>${esc(i.name)}</h3><span class="badge">${mb(i.size_bytes)}</span></div>
        <p class="path">${esc(i.path)}</p>
        <p class="note tiny">修改于 ${when(i.modified_at)} · ${i.file_count ?? '?'} 个文件</p>
      </div>`).join('') || '<p class="note">没有未纳管的目录。</p>';
  } catch (error) { box.innerHTML = `<p class="note">扫描失败：${esc(String(error?.message ?? error))}</p>`; }
});

void refresh();
/**
 * ⭐ 3 秒，且**只在页面可见时**。`/live` 现在是纯快照（后台按 TTL 刷新，读接口永不等远端），
 * 参考机上毫秒级返回，所以可以轮得快。
 * ⚠ 这个数字曾经是 15 秒，因为那时 `/live` 要 6–9 秒——**改快它的前提是先把端点改成快照**，
 *   而不是反过来。在慢端点上缩短轮询间隔，只会把请求首尾相接地叠起来。
 */
setInterval(() => { if (!document.hidden) void refresh(); }, 3_000);
