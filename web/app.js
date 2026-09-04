/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework Browser Session API and raw model-package JSON responses.
 * [OUTPUT]: The two-section Overview/Models manager UI.
 * [POS]: hf-model-manager/web/app.js.
 * [PROTOCOL]: Show package metadata, usage, raw files, and real operations only.
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
  $('refresh-status').textContent = `最近刷新：${age}${refresh.refreshing ? ' · 正在刷新' : ''}${refresh.last_error ? ` · ${refresh.last_error}` : ''}`;
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

const operationText = (operation) => {
  const progress = Number.isFinite(Number(operation.progress)) ? ` · ${Math.round(Number(operation.progress))}%` : '';
  const bytesText = Number.isFinite(Number(operation.bytes_total)) && Number(operation.bytes_total) > 0
    ? ` · ${bytes(operation.bytes_done)} / ${bytes(operation.bytes_total)}` : '';
  return `${stageLabel[operation.stage] ?? operation.stage ?? operation.state}${progress}${bytesText}`;
};

const renderOperations = (data) => {
  const active = (data?.operations?.operations ?? []).filter((item) => item.state !== 'complete' && item.state !== 'failed');
  const box = $('operations');
  if (!active.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="operation-list">${active.map((item) => `<div class="operation item">
    <div class="row between"><strong>${esc(item.action)}</strong><span class="badge warn">${esc(item.state)}</span></div>
    <p class="note tiny">${esc(operationText(item))}${item.current_file ? ` · ${esc(item.current_file)}` : ''}</p>
  </div>`).join('')}</div>`;
};

const renderPackages = (data) => {
  const box = $('package-list');
  const packages = data?.packages ?? [];
  if (!packages.length) { box.innerHTML = '<p class="note">没有可显示的模型包。</p>'; return; }
  box.innerHTML = packages.map((item) => {
    const badge = stateLabel[item.status] ?? item.status ?? '未知';
    const assets = item.assets ?? [];
    const canDownload = item.actions?.download && item.status !== 'complete';
    const canDelete = item.actions?.delete;
    const usage = item.usage?.consumers ?? [];
    return `<article class="package-card" data-key="${esc(item.key)}">
      <div class="row between"><h3>${esc(item.display_name || item.repository)}</h3><span class="badge ${stateClass[item.status] ?? ''}">${esc(badge)}</span></div>
      <p class="note tiny">${esc(item.source)} · ${esc(item.repository)}</p>
      <div class="row actions">
        ${canDownload ? `<button data-action="download" data-key="${esc(item.key)}">${item.status === 'partial' ? '继续' : '下载'}</button>` : ''}
        ${item.status === 'error' ? `<button data-action="download" data-key="${esc(item.key)}">重试</button>` : ''}
        ${canDelete ? `<button class="ghost" data-action="delete" data-key="${esc(item.key)}">删除本地文件</button>` : ''}
      </div>
      <details><summary>Meta</summary><dl class="facts">
        <dt>来源</dt><dd>${esc(item.source)}</dd><dt>仓库</dt><dd>${esc(item.repository)}</dd>
        <dt>Registry package_id</dt><dd class="path">${esc(item.package_id ?? '—')}</dd>
        <dt>包版本</dt><dd>${esc(item.package_version ?? '—')}</dd><dt>上游 revision</dt><dd class="path">${esc(item.upstream_revision ?? '—')}</dd>
      </dl></details>
      <details><summary>Usage <span class="note tiny">(${usage.length})</span></summary>
        ${usage.length ? `<ul>${usage.map((entry) => `<li class="path">${esc(entry.package_id)} · ${esc(entry.path)}</li>`).join('')}</ul>` : '<p class="note tiny">没有当前声明的使用者。</p>'}
      </details>
      <details><summary>Files <span class="note tiny">(${item.files?.length ?? 0} · ${bytes(item.registry?.raw_bytes)})</span></summary>
        ${(item.files ?? []).map(fileRow).join('') || '<p class="note tiny">没有已批准的原始文件。</p>'}
      </details>
    </article>`;
  }).join('');
};

const refresh = async () => {
  try {
    const response = await api('/live');
    const data = await response.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    renderOverview(data.overview, data.summary);
    renderPackages(data);
    renderOperations(data);
  } catch (error) {
    $('summary').textContent = `读取失败：${String(error?.message ?? error)}`;
  }
};

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const key = button.dataset.key;
  if (action === 'delete' && !window.confirm('删除这个模型包的本地原始文件？当前声明的使用者会阻止删除。')) return;
  button.disabled = true;
  try {
    const route = action === 'delete' ? `/package/delete?id=${encodeURIComponent(key)}` : `/package/${action}?id=${encodeURIComponent(key)}`;
    const response = await api(route, { method: action === 'delete' ? 'DELETE' : 'POST', body: '{}' });
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
