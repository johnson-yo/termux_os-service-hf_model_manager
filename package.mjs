/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package context（services / ports / actions / capabilities / routes / auth）
 * [OUTPUT]: 注册 hf-model-manager 服务、代理它的路由、并提供模型/资产 capability
 * [POS]: 薄注册层。所有逻辑在 `service/`，这里只负责让 Framework 找得到它。
 *
 * ⚠ 新增一条 service 路由必须**同时**在这里注册，否则 Framework 直接回
 *   `unknown_package_route`，而一个把响应丢掉的调用方完全看不出来。
 * ⚠ 改完这个文件要 `framework.sh restart`——installed 包的 `package.mjs`
 *   走的是没有 cache-buster 的 import，reload 不会重新执行 `register()`。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import path from 'node:path';

export async function register(context) {
  const port = context.ports.get('http')?.port;
  const serviceBase = `http://127.0.0.1:${port}`;
  const managementPath = `/packages/${context.packageId}/`;

  context.services.register({
    id: 'hf-model-manager',
    name: 'HF Model Manager',
    command: context.nodeExecutable,
    args: ['service/main.mjs'],
    cwd: context.root,
    env: {
      STATUS_FILE: `${context.frameworkRoot}/.runtime/services/${context.services.id('hf-model-manager')}/status.json`,
      // ⚠ 显式落 persistRoot：dev runtime 每次 reload 换一个 gen/<timestamp>/ 目录，
      //   相对路径会跟着漂，于是引用表每次重载都从零开始——而「一直是空的」
      //   与「还没有人登记过」在界面上长得一模一样。
      MANAGER_DATA_ROOT: path.join(context.persistRoot, 'data', 'hf-model-manager'),
    },
    health: { type: 'http', url: `${serviceBase}/health`, timeout_ms: 1500 },
    stop_timeout_ms: 5000,
  });

  const request = async (p, { method = 'GET', body, timeoutMs = 30_000 } = {}) => {
    const response = await fetch(`${serviceBase}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.auth.systemKey()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  /** 透传一条路由。⚠ 状态码要原样带回：409 `asset_in_use` 与 200 是完全不同的答案。 */
  const proxy = (method, route, { timeoutMs = 30_000 } = {}) => {
    context.routes.register(method, route, async (req, res) => {
      let body;
      if (method !== 'GET' && method !== 'DELETE') {
        body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', (c) => { raw += c; });
          req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
          req.on('error', () => resolve({}));
        });
      } else if (method === 'DELETE') {
        body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', (c) => { raw += c; });
          req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : undefined); } catch { resolve(undefined); } });
          req.on('error', () => resolve(undefined));
        });
      }
      const query = new URL(req.url, 'http://framework.local').search;
      const r = await request(route + query, { method, body, timeoutMs })
        .catch((error) => ({ status: 502, data: { ok: false, error: 'manager_unreachable', detail: String(error?.message ?? error) } }));
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(r.data));
    });
  };

  for (const r of ['/catalog', '/assets', '/installed', '/references', '/operations',
    '/unmanaged', '/live', '/events']) {
    proxy('GET', r);
  }
  proxy('POST', '/refresh', { timeoutMs: 120_000 });
  proxy('POST', '/references');
  proxy('DELETE', '/references');

  /**
   * ⚠ Framework 的包路由是**精确路径匹配**（`x.path === subpath`，query 已被剥掉），
   *   没有通配符。所以带 asset id 的操作在**代理层用 query**、在 service 层用路径段——
   *   两层形状故意不同，这与既有 Package 的做法一致。
   * ⛔ 每一条都要显式注册：漏一条，Framework 直接回 `unknown_package_route`，
   *   而一个把响应丢掉的调用方完全看不出来。
   */
  const byId = (method, proxyRoute, toServicePath, timeoutMs = 30_000) => {
    context.routes.register(method, proxyRoute, async (req, res) => {
      const q = new URL(req.url, 'http://framework.local').searchParams;
      const id = (q.get('id') ?? '').trim();
      const reply = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      };
      if (!id) return reply(400, { ok: false, error: 'id query parameter is required' });
      let body;
      if (method === 'POST') {
        body = await new Promise((resolve) => {
          let raw = '';
          req.on('data', (c) => { raw += c; });
          req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
          req.on('error', () => resolve({}));
        });
      }
      const r = await request(toServicePath(encodeURIComponent(id)), { method, body, timeoutMs })
        .catch((error) => ({ status: 502, data: { ok: false, error: 'manager_unreachable', detail: String(error?.message ?? error) } }));
      reply(r.status, r.data);
    });
  };

  byId('GET', '/asset', (id) => `/assets/${id}`);
  byId('GET', '/asset/references', (id) => `/assets/${id}/references`);
  byId('POST', '/asset/resolve', (id) => `/assets/${id}/resolve`);
  byId('POST', '/asset/install', (id) => `/assets/${id}/install`, 120_000);
  byId('POST', '/asset/fetch', (id) => `/assets/${id}/fetch`, 120_000);
  byId('POST', '/asset/verify', (id) => `/assets/${id}/verify`, 120_000);
  byId('POST', '/asset/check-update', (id) => `/assets/${id}/check-update`, 60_000);
  byId('DELETE', '/asset', (id) => `/assets/${id}`);
  byId('GET', '/operation', (id) => `/operations/${id}`);

  /**
   * docs/093：logical model 的对外入口。
   * ⭐ **`/model/resolve` 是消费方（termux-speech）唯一需要的那一条**——
   *   它回答「现在能跑的是什么」，⛔ 不回答「为什么是这一份」。
   * ⚠ 同样走 query：Framework 的包路由是精确匹配，⛔ 没有通配符。
   */
  proxy('GET', '/models');
  byId('GET', '/model', (id) => `/models/${id}`);
  byId('GET', '/model/resolve', (id) => `/models/${id}/resolve`);
  byId('POST', '/model/download', (id) => `/models/${id}/download`, 120_000);
  byId('POST', '/model/use', (id) => `/models/${id}/use`, 30 * 60_000);
  // ⭐ 使用者删的是一个**模型**，⛔ 不是某个内部 artifact（docs/094 §11）。
  byId('DELETE', '/model', (id) => `/models/${id}`, 120_000);

  /**
   * ⭐ 给别的 package 的正式入口。consumer 只认 capability id，
   *   ⛔ 不写死本服务的端口，也不写死这个包的 id。
   * ⚠ Framework 的 action `run(input)` 收到的是**一个字符串**，
   *   所以约定：input 是一段 JSON，形如 `{"op":"resolve","asset_id":"model.campplus.ctx"}`。
   */
  context.actions.register({
    id: 'assets.manager.query',
    name: 'Query the shared model/asset manager',
    adapter: 'hf-model-manager',
    available: async () => {
      try { const r = await request('/health', { timeoutMs: 2000 }); return r.status === 200; }
      catch { return false; }
    },
    run: async (input = '') => {
      let command = {};
      if (typeof input === 'string' && input.trim()) {
        try { command = JSON.parse(input); } catch { return { ok: false, error: 'input must be JSON' }; }
      } else if (input && typeof input === 'object') command = input;
      const id = command.asset_id ? encodeURIComponent(command.asset_id) : null;
      switch (command.op ?? 'summary') {
        /**
         * ⭐ 空输入的答案必须便宜且有用。`summary` 走快照，不打远端——
         * 一个消费方启动时问一句「现在什么情况」，不该付十几秒。
         */
        case 'summary': {
          const r = await request('/live');
          const d = r.data ?? {};
          return { ok: d.ok === true, counts: d.counts ?? null, sources: d.sources ?? null,
            event_cursor: d.event_cursor ?? null, change_seq: d.change_seq ?? null };
        }
        case 'assets': return (await request('/assets')).data;
        case 'installed': return (await request('/installed')).data;
        case 'catalog': return (await request('/catalog')).data;
        case 'detail': return id ? (await request(`/assets/${id}`)).data
          : { ok: false, error: 'asset_id required' };
        case 'resolve': return id ? (await request(`/assets/${id}/resolve`, { method: 'POST', body: {} })).data
          : { ok: false, error: 'asset_id required' };
        case 'check-update': return id
          ? (await request(`/assets/${id}/check-update`, { method: 'POST', body: {} })).data
          : { ok: false, error: 'asset_id required' };
        case 'references': return id ? (await request(`/assets/${id}/references`)).data
          : (await request('/references')).data;

        /**
         * ⭐ 写操作也必须走能力面。
         *
         * 0.1.1 的 action 只有查询：install/fetch/verify/remove 只存在于 HTTP 路由上。
         * 于是一个**遵守规矩**的消费方——只用 capability discovery、不写死本包 URL——
         * 能看见资产状态，却一件事都做不了，只能去拼 `/api/packages/<本包 id>/...`，
         * 而那正是 capability 要消灭的东西。
         * ⚠ 这是第一个真实消费方（termux-speech）接进来才暴露的：
         *   自己写的 fixture 只验证了「查得到」。
         */
        case 'install': case 'fetch': case 'verify': {
          if (!id) return { ok: false, error: 'asset_id required' };
          const r = await request(`/assets/${id}/${command.op}`, { method: 'POST', body: {}, timeoutMs: 120_000 });
          return r.data;
        }
        case 'models': {
          const value = (await request('/models')).data;
          return value && typeof value === 'object'
            ? { ...value, management_path: managementPath }
            : value;
        }
        case 'model': case 'download': case 'use': {
          const modelId = command.model_id ? encodeURIComponent(command.model_id) : null;
          if (!modelId) return { ok: false, error: 'model_id required' };
          if (command.op === 'model') return (await request(`/models/${modelId}`)).data;
          const body = command.choice ? { choice: command.choice } : {};
          const r = await request(`/models/${modelId}/${command.op}`, {
            method: 'POST', body, timeoutMs: command.op === 'download' ? 120_000 : 30_000,
          });
          return r.data;
        }
        case 'remove': {
          if (!id) return { ok: false, error: 'asset_id required' };
          // ⚠ 状态码要带出去：409 asset_in_use 与「删掉了」是完全不同的答案，
          //   而 action 的返回值里没有 HTTP 状态码这一维。
          const r = await request(`/assets/${id}`, { method: 'DELETE', timeoutMs: 60_000 });
          return { ...r.data, http_status: r.status };
        }
        case 'operation': {
          const opId = String(command.operation_id ?? '').trim();
          if (!opId) return { ok: false, error: 'operation_id required' };
          return (await request(`/operations/${encodeURIComponent(opId)}`)).data;
        }
        case 'operations': return (await request('/operations')).data;
        case 'events': {
          const after = Number(command.after ?? 0) || 0;
          const limit = Number(command.limit ?? 50) || 50;
          return (await request(`/events?after=${after}&limit=${limit}`)).data;
        }
        default:
          return { ok: false, error: 'unknown_op',
            supported: ['summary', 'catalog', 'assets', 'installed', 'detail', 'resolve',
              'check-update', 'references', 'install', 'fetch', 'verify', 'remove',
              'operation', 'operations', 'events', 'models', 'model', 'download', 'use'] };
      }
    },
  });

  context.capabilities.provide({
    id: 'termux-os.assets.manager',
    provider: 'hf-model-manager',
    kind: 'action',
    action: 'assets.manager.query',
    service: 'hf-model-manager',
  });

  /**
   * ⭐ feed capability。Framework 的 feed 契约是**游标端点**——
   * `describeCapability` 只返回 `{endpoint, format}`，由消费方自己拉；
   * ⛔ 不发明第二套推送协议，也不为此上 WebSocket。
   * ⚠ endpoint 用 `context.packageId` 拼，⛔ 不写死本包 id：
   *   dev 实例的包名带后缀，写死会让派生实例指向正式实例的端点。
   */
  context.capabilities.provide({
    id: 'termux-os.assets.inventory',
    provider: 'hf-model-manager',
    kind: 'feed',
    service: 'hf-model-manager',
    endpoint: `/api/packages/${context.packageId}/events`,
    format: 'jsonl-cursor',
  });
}
