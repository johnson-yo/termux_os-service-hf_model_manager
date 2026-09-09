/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework Browser Session API and raw model-package JSON responses.
 * [OUTPUT]: The two-section 概览/模型 manager UI.
 * [POS]: hf-model-manager/web/app.js.
 * [PROTOCOL]: Cards are patched by stable data-key nodes; a 3-second live poll
 *             must not replace details, scroll, file selection, or operation state.
 */

const packageId = () => {
  const match = location.pathname.match(/^\/packages\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : 'github.termux-os.service.hf-model-manager';
};
const base = `/api/packages/${packageId()}`;
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};
const stateLabel = { complete: '完整', partial: '部分文件', none: '未下载', unknown: '未知', error: '校验异常' };
const stateClass = { complete: 'ok', partial: 'warn', none: '', unknown: 'warn', error: 'bad' };
const stageLabel = { resolving: '解析中', downloading: '下载中', verifying: '校验中', importing: '导入中', deleting: '删除中', done: '完成' };
const api = (route, options = {}) => {
  if (!window.TermuxOS?.api) throw new Error('Browser Session 未加载');
  return window.TermuxOS.api(`${base}${route}`, options);
};

const renderOverview = (overview, summary) => {
  const storage = overview?.storage ?? {};
  const registry = overview?.registry ?? {};
  const local = overview?.local ?? {};
  $('summary').textContent = `共 ${summary?.total ?? 0} 个模型包 · 完整 ${summary?.complete ?? 0} · 部分 ${summary?.partial ?? 0} · 未下载 ${summary?.none ?? 0}`;
  $('overview-grid').innerHTML = [
    ['设备', `${overview?.device?.os ?? '—'} · ${overview?.device?.device_arch ?? overview?.device?.arch ?? '—'}`],
    ['模型目录', storage.model_root],
    ['可用空间', bytes(storage.free_bytes)],
    ['原始模型占用', bytes(storage.raw_model_bytes)],
    ['Registry 模型包', registry.available ? `${registry.package_count ?? 0} 个` : '不可用'],
    ['本地状态', `完整 ${local.complete ?? 0} · 部分 ${local.partial ?? 0} · 未下载 ${local.none ?? 0}`],
  ].map(([key, value]) => `<dt>${esc(key)}</dt><dd class="path">${esc(value)}</dd>`).join('');
  const refresh = overview?.refresh ?? {};
  const age = Number.isFinite(Number(refresh.age_ms)) ? `${Math.round(Number(refresh.age_ms) / 1000)} 秒前` : '尚未完成';
  const updated = refresh.updated_at_ms ? new Date(Number(refresh.updated_at_ms)).toLocaleTimeString() : '—';
  $('refresh-status').textContent = `数据更新时间：${updated}（${age}）${refresh.refreshing ? ' · 正在刷新' : ''}${refresh.last_error ? ` · ${refresh.last_error}` : ''}`;
};

const fileRow = (file) => {
  const local = file.local ?? {};
  const pathText = local.path || local.part_path || '—';
  return `<div class="file-row">
    <div><strong>${esc(file.path)}</strong>${file.remote_path ? `<span class="note tiny"> · ${esc(file.remote_path)}</span>` : ''}</div>
    <div class="note tiny">${bytes(file.size)} · ${esc(stateLabel[local.state] ?? local.state ?? '未知')}</div>
    <div class="path">${esc(pathText)}</div>
  </div>`;
};

const operationPercent = (operation) => {
  if (operation?.progress_precision !== 'bytes') return null;
  const value = Number(operation.percent ?? operation.progress);
  return Number.isFinite(value) ? Math.round(value) : null;
};

const operationText = (operation) => {
  const percent = operationPercent(operation);
  const progress = percent === null ? '' : ` · ${percent}%`;
  const bytesText = Number.isFinite(Number(operation.bytes_total)) && Number(operation.bytes_total) > 0
    ? ` · ${bytes(operation.bytes_done)} / ${bytes(operation.bytes_total)}` : '';
  const speed = Number.isFinite(Number(operation.speed_bps)) && Number(operation.speed_bps) > 0
    ? ` · ${bytes(operation.speed_bps)}/s` : '';
  const retry = Number(operation.retry_count) > 0 ? ` · 重试 ${operation.retry_count}` : '';
  const resume = operation.resumed ? ' · 已续传' : '';
  return `${stageLabel[operation.stage] ?? operation.stage ?? operation.state}${progress}${bytesText}${speed}${retry}${resume}`;
};

const operationFor = (data, key) => (data?.operations?.operations ?? [])
  .find((item) => (item.package_key ?? item.asset_id) === key && item.state !== 'complete') ?? null;

const renderOperations = (data) => {
  const active = (data?.operations?.operations ?? []).filter((item) => item.state !== 'complete' && item.state !== 'failed');
  const box = $('operations');
  if (!active.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="operation-list">${active.map((item) => `<div class="operation item">
    <div class="row between"><strong>${esc(item.action)} · ${esc(item.package_key ?? item.asset_id)}</strong><span class="badge warn">${esc(item.state)}</span></div>
    <p class="note tiny">${esc(operationText(item))}${item.current_provider ? ` · provider ${esc(item.current_provider)}` : ''}${item.current_file ? ` · ${esc(item.current_file)}` : ''}${item.route ? ` · ${esc(item.route)}` : ''}</p>
  </div>`).join('')}</div>`;
};

const actionSignature = (item) => JSON.stringify({
  status: item.status,
  actions: item.actions,
  active: item.active_operation ?? null,
});

const actionsMarkup = (item) => {
  const actions = item.actions ?? {};
  const result = [];
  if (actions.verify) result.push(`<button data-action="verify" data-key="${esc(item.key)}">验证</button>`);
  if (actions.update) result.push(`<button data-action="update" data-key="${esc(item.key)}">更新</button>`);
  if (actions.download && item.status === 'error') result.push(`<button data-action="download" data-key="${esc(item.key)}">重试</button>`);
  else if (actions.download) result.push(`<button data-action="download" data-key="${esc(item.key)}">${actions.continue ? '继续下载' : '下载'}</button>`);
  else if (!actions.verify && actions.download_reason) {
    result.push(`<button disabled title="${esc(actions.download_reason)}">下载</button><span class="note tiny action-reason">${esc(actions.download_reason)}</span>`);
  }
  if (actions.delete) result.push(`<button class="ghost" data-action="delete" data-key="${esc(item.key)}">删除</button>`);
  return result.join('') || '<span class="note tiny">暂无可执行操作</span>';
};

const deleteImpactText = (plan) => (plan?.impacts ?? []).map((impact) => {
  const files = Array.isArray(impact.files) ? impact.files : [];
  const bytesTotal = Number(impact.bytes) || files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const selected = (impact.selected_by ?? []).map((item) => item.key ?? `${item.asset_id ?? 'asset'}:${item.variant_id ?? 'generic'}`);
  const consumers = (impact.consumers ?? []).map((item) => typeof item === 'string' ? item : `${item.package_id ?? 'package'} ${item.path ?? ''}`.trim());
  return [
    `Payload: ${impact.payload_id ?? 'legacy payload'}`,
    `大小: ${bytes(bytesTotal)} · 来源: ${impact.provenance ?? impact.layout ?? 'unknown'}`,
    `Package: ${impact.package_id ?? '—'} · version: ${impact.version ?? '—'}`,
    `当前 Selection: ${selected.length ? selected.join(', ') : '无'}`,
    `声明使用者: ${consumers.length ? consumers.join(', ') : '无'}`,
    `runtime: ${impact.runtime?.loaded ? '当前有运行时观察到 loaded' : '未观察到 loaded'}`,
  ].join('\n');
}).join('\n\n') || '没有可删除的 Payload。';

const confirmDelete = async (plan) => {
  const text = `删除后原始 Payload 字节将被移除，Declaration 会保留。\n\n${deleteImpactText(plan)}`;
  const dialog = $('delete-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return window.confirm(text);
  $('delete-impact').textContent = deleteImpactText(plan);
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.querySelector('[data-delete-cancel]')?.removeEventListener('click', cancel);
      dialog.querySelector('[data-delete-confirm]')?.removeEventListener('click', accept);
      dialog.removeEventListener('cancel', cancelEvent);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const cancel = () => finish(false);
    const accept = () => finish(true);
    const cancelEvent = (event) => { event.preventDefault(); finish(false); };
    dialog.querySelector('[data-delete-cancel]')?.addEventListener('click', cancel);
    dialog.querySelector('[data-delete-confirm]')?.addEventListener('click', accept);
    dialog.addEventListener('cancel', cancelEvent);
    dialog.showModal();
  });
};

const createCardNode = (item) => {
  const article = document.createElement('article');
  article.className = 'package-card';
  article.dataset.key = item.key;
  article.innerHTML = `<div class="row between"><h3 data-field="title"></h3><span class="badge" data-field="badge"></span></div>
    <p class="note tiny" data-field="source"></p>
    <dl class="facts package-facts">
      <dt>包版本</dt><dd data-field="package-version"></dd>
      <dt>状态</dt><dd data-field="status"></dd>
      <dt>总大小</dt><dd data-field="total-bytes"></dd>
      <dt>已下载</dt><dd data-field="downloaded-bytes"></dd>
    </dl>
    <div class="row actions" data-role="actions"></div>
    <div class="card-progress" data-role="progress" hidden></div>
    <details data-detail="basic"><summary>基本信息</summary><dl class="facts" data-role="basic-body"></dl></details>
    <details data-detail="usage"><summary>占用情况 <span class="note tiny" data-field="usage-count"></span></summary><div data-role="usage-body"></div></details>
    <details data-detail="files"><summary>文件 <span class="note tiny" data-field="files-count"></span></summary><div data-role="files-body"></div></details>`;
  return article;
};

const patchProgress = (node, operation) => {
  const box = node.querySelector('[data-role="progress"]');
  if (!operation || operation.state === 'complete') { box.hidden = true; return; }
  if (!box.querySelector('[data-role="progress-text"]')) {
    box.innerHTML = '<div class="progress-head"><strong data-role="progress-text"></strong><span data-role="progress-meta"></span></div><progress data-role="progress-bar" max="100"></progress>';
  }
  const percent = operationPercent(operation);
  const bar = box.querySelector('[data-role="progress-bar"]');
  box.hidden = false;
  box.querySelector('[data-role="progress-text"]').textContent = operationText(operation);
  box.querySelector('[data-role="progress-meta"]').textContent = [
    operation.current_provider ? `provider: ${operation.current_provider}` : '',
    operation.current_file || '',
    operation.route || '',
  ].filter(Boolean).join(' · ');
  bar.hidden = percent === null;
  if (percent !== null) bar.value = percent;
};

const patchCardNode = (node, item, data) => {
  const badge = stateLabel[item.status] ?? item.status ?? '未知';
  const totalBytes = item.total_bytes ?? item.registry?.raw_bytes;
  const downloadedBytes = item.downloaded_bytes ?? 0;
  const usage = item.usage?.consumers ?? [];
  node.dataset.key = item.key;
  node.querySelector('[data-field="title"]').textContent = item.display_name || item.repository || item.key;
  const badgeNode = node.querySelector('[data-field="badge"]');
  badgeNode.textContent = badge;
  badgeNode.className = `badge ${stateClass[item.status] ?? ''}`;
  node.querySelector('[data-field="source"]').textContent = `${item.source ?? '—'} · ${item.repository ?? '—'}`;
  node.querySelector('[data-field="package-version"]').textContent = item.package_version ?? '—';
  node.querySelector('[data-field="status"]').textContent = badge;
  node.querySelector('[data-field="total-bytes"]').textContent = bytes(totalBytes);
  node.querySelector('[data-field="downloaded-bytes"]').textContent = bytes(downloadedBytes);
  const actions = node.querySelector('[data-role="actions"]');
  const signature = actionSignature({ ...item, active_operation: operationFor(data, item.key)?.state ?? null });
  if (actions.dataset.signature !== signature) {
    actions.innerHTML = actionsMarkup(item);
    actions.dataset.signature = signature;
  }
  node.querySelector('[data-role="basic-body"]').innerHTML = `<dt>来源</dt><dd>${esc(item.source)}</dd><dt>仓库</dt><dd>${esc(item.repository)}</dd>
    <dt>Registry package_id</dt><dd class="path">${esc(item.package_id ?? '—')}</dd><dt>包版本</dt><dd>${esc(item.package_version ?? '—')}</dd>
    <dt>上游 revision</dt><dd class="path">${esc(item.upstream_revision ?? '—')}</dd>`;
  node.querySelector('[data-field="usage-count"]').textContent = `(${usage.length})`;
  node.querySelector('[data-role="usage-body"]').innerHTML = usage.length
    ? `<ul>${usage.map((entry) => `<li class="path">${esc(entry.package_id)} · ${esc(entry.path)}</li>`).join('')}</ul>`
    : '<p class="note tiny">没有当前声明的使用者。</p>';
  node.querySelector('[data-field="files-count"]').textContent = `(${item.files?.length ?? 0} · ${bytes(item.registry?.raw_bytes)})`;
  node.querySelector('[data-role="files-body"]').innerHTML = (item.files ?? []).map(fileRow).join('') || '<p class="note tiny">没有已批准的原始文件。</p>';
  patchProgress(node, operationFor(data, item.key));
};

const renderPackages = (data) => {
  const box = $('package-list');
  const packages = data?.packages ?? [];
  if (!packages.length) {
    for (const child of [...box.children]) child.remove();
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = '没有可显示的模型包。';
    box.append(empty);
    return;
  }
  const existing = new Map([...box.children]
    .filter((child) => child.matches?.('article.package-card[data-key]'))
    .map((child) => [child.dataset.key, child]));
  const ordered = [];
  for (const item of packages) {
    const node = existing.get(item.key) ?? createCardNode(item);
    patchCardNode(node, item, data);
    ordered.push(node);
    existing.delete(item.key);
  }
  for (const stale of existing.values()) stale.remove();
  for (const child of [...box.children]) if (!child.matches?.('article.package-card[data-key]')) child.remove();
  // appendChild moves the existing article instead of replacing it, so open
  // <details>, focus, scroll position, and any operation-local DOM state live.
  for (const node of ordered) box.appendChild(node);
};

let refreshInFlight = null;
const refresh = () => {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    try {
      const response = await api('/live');
      const data = await response.json();
      if (!data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      renderOverview(data.overview, data.summary);
      renderPackages(data);
      renderOperations(data);
      // Updating the overview grid and moving existing card nodes can trigger
      // browser scroll anchoring differently on a formal Package page than in
      // the small headless fixture. Restore the user's viewport explicitly;
      // this is independent of preserving the stable card/details nodes.
      window.scrollTo(scrollX, scrollY);
    } catch (error) {
      $('summary').textContent = `读取失败：${String(error?.message ?? error)}`;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
};

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const key = button.dataset.key;
  button.disabled = true;
  try {
    let route = `/package/${action}?id=${encodeURIComponent(key)}`;
    let options = { method: 'POST', body: '{}' };
    if (action === 'delete') {
      const planResponse = await api(`/package/delete-plan?id=${encodeURIComponent(key)}`, { method: 'POST', body: '{}' });
      const planBody = await planResponse.json();
      if (!planResponse.ok || !planBody.ok) throw new Error(planBody.error ?? `HTTP ${planResponse.status}`);
      const plan = planBody.plan ?? planBody;
      if (!await confirmDelete(plan)) return;
      options = { method: 'POST', body: JSON.stringify({ confirmation_token: plan.confirmation_token }) };
    }
    const response = await api(route, options);
    const data = await response.json();
    if (!data.ok) alert(`操作失败：${data.error ?? response.status}`);
  } catch (error) { alert(`操作失败：${String(error?.message ?? error)}`); }
  finally { button.disabled = false; void refresh(); }
});

$('refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await api('/refresh', { method: 'POST', body: JSON.stringify({ force: true }) }); }
  finally { button.disabled = false; void refresh(); }
});

$('import').addEventListener('click', async (event) => {
  const input = $('archive');
  const file = input.files?.[0];
  if (!file) return alert('请选择 tar.gz 原始模型包归档。');
  event.currentTarget.disabled = true;
  try {
    const response = await api('/package/import', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/gzip' } });
    const data = await response.json();
    if (!data.ok) alert(`导入失败：${data.error ?? response.status}`);
  } catch (error) { alert(`导入失败：${String(error?.message ?? error)}`); }
  finally { event.currentTarget.disabled = false; void refresh(); }
});

void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
