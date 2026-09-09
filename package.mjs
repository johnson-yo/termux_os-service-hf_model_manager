/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework Package context: service, port, action, capability, route, and auth registries.
 * [OUTPUT]: Registers the raw-only model package manager and its authenticated API surface.
 * [POS]: hf-model-manager/package.mjs.
 * [PROTOCOL]: Keep this thin registration layer synchronized with service/main.mjs and the package manifest.
 */

export async function register(context) {
  const port = context.ports.get('http')?.port;
  const serviceBase = `http://127.0.0.1:${port}`;
  const operationsFile = context.configFile('operations.v1.json');

  context.services.register({
    id: 'hf-model-manager',
    name: 'Raw Model Package Manager',
    command: context.nodeExecutable,
    args: ['service/main.mjs'],
    cwd: context.root,
    env: {
      STATUS_FILE: `${context.frameworkRoot}/.runtime/services/${context.services.id('hf-model-manager')}/status.json`,
      OPERATIONS_FILE: operationsFile,
    },
    health: { type: 'http', url: `${serviceBase}/health`, timeout_ms: 1500 },
    stop_timeout_ms: 5000,
  });

  const request = async (route, { method = 'GET', body, timeoutMs = 30_000 } = {}) => {
    const response = await fetch(`${serviceBase}${route}`, {
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

  const reply = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const readJson = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });

  const proxy = (method, route, timeoutMs = 30_000) => {
    context.routes.register(method, route, async (req, res) => {
      const query = new URL(req.url, 'http://framework.local').search;
      const body = method === 'GET' ? undefined : await readJson(req);
      const result = await request(`${route}${query}`, { method, body, timeoutMs })
        .catch((error) => ({ status: 502, data: { ok: false, error: 'manager_unreachable', detail: String(error?.message ?? error) } }));
      return reply(res, result.status, result.data);
    });
  };

  const streamProxy = (method, route) => {
    context.routes.register(method, route, async (req, res) => {
      const query = new URL(req.url, 'http://framework.local').search;
      const response = await fetch(`${serviceBase}${route}${query}`, {
        method,
        headers: {
          Authorization: `Bearer ${context.auth.systemKey()}`,
          'Content-Type': req.headers['content-type'] || 'application/gzip',
          ...(req.headers['content-length'] ? { 'Content-Length': req.headers['content-length'] } : {}),
        },
        body: req,
        duplex: 'half',
        signal: AbortSignal.timeout(3_600_000),
      }).catch((error) => null);
      if (!response) return reply(res, 502, { ok: false, error: 'manager_unreachable' });
      return reply(res, response.status, await response.json().catch(() => ({ ok: false, error: 'invalid_manager_response' })));
    });
  };

  for (const route of ['/overview', '/catalog', '/packages', '/models', '/assets', '/installed', '/declarations',
    '/payloads', '/live', '/events', '/operations']) proxy('GET', route);
  proxy('POST', '/refresh', 120_000);
  streamProxy('POST', '/package/import');
  streamProxy('POST', '/model/import');

  const byId = (method, proxyRoute, serviceRoute, timeoutMs = 30_000) => {
    context.routes.register(method, proxyRoute, async (req, res) => {
      const query = new URL(req.url, 'http://framework.local').searchParams;
      const id = (query.get('id') || '').trim();
      if (!id) return reply(res, 400, { ok: false, error: 'id query parameter is required' });
      const body = method === 'POST' || method === 'DELETE' ? await readJson(req) : undefined;
      const routeWithId = serviceRoute(encodeURIComponent(id), query);
      const result = await request(routeWithId, { method, body, timeoutMs })
        .catch((error) => ({ status: 502, data: { ok: false, error: 'manager_unreachable', detail: String(error?.message ?? error) } }));
      return reply(res, result.status, result.data);
    });
  };

  byId('GET', '/package', (id) => `/package?id=${id}`);
  byId('GET', '/model', (id) => `/package?id=${id}`);
  byId('GET', '/file', (id, query) => `/file?id=${id}&path=${encodeURIComponent(query.get('path') || '')}`);
  byId('POST', '/package/download', (id) => `/package/download?id=${id}`, 3_600_000);
  byId('POST', '/model/download', (id) => `/package/download?id=${id}`, 3_600_000);
  byId('POST', '/package/update', (id) => `/package/update?id=${id}`, 3_600_000);
  byId('POST', '/model/update', (id) => `/package/update?id=${id}`, 3_600_000);
  byId('POST', '/package/verify', (id) => `/package/verify?id=${id}`, 3_600_000);
  byId('POST', '/model/verify', (id) => `/package/verify?id=${id}`, 3_600_000);
  byId('POST', '/package/delete-plan', (id) => `/package/delete-plan?id=${id}`, 120_000);
  byId('POST', '/model/delete-plan', (id) => `/package/delete-plan?id=${id}`, 120_000);
  byId('DELETE', '/package/delete', (id) => `/package/delete?id=${id}`, 120_000);
  byId('DELETE', '/model/delete', (id) => `/package/delete?id=${id}`, 120_000);
  byId('POST', '/package/delete', (id) => `/package/delete?id=${id}`, 120_000);
  byId('POST', '/model/delete', (id) => `/package/delete?id=${id}`, 120_000);
  byId('POST', '/payload/delete-plan', (id) => `/payload/delete-plan?id=${id}`, 120_000);
  byId('DELETE', '/payload/delete', (id) => `/payload/delete?id=${id}`, 120_000);
  byId('POST', '/payload/delete', (id) => `/payload/delete?id=${id}`, 120_000);
  byId('GET', '/operation', (id) => `/operations/${id}`);

  context.actions.register({
    id: 'assets.manager.query',
    name: 'Query the raw model package manager',
    adapter: 'hf-model-manager',
    available: async () => {
      try { return (await request('/health', { timeoutMs: 2000 })).status === 200; } catch { return false; }
    },
    run: async (input = '') => {
      let command = {};
      if (typeof input === 'string' && input.trim()) {
        try { command = JSON.parse(input); } catch { return { ok: false, error: 'input must be JSON' }; }
      } else if (input && typeof input === 'object') command = input;
      const key = command.package_key || command.model_key || command.id || null;
      const id = key ? encodeURIComponent(key) : null;
      switch (command.op ?? 'summary') {
        case 'summary': return (await request('/overview')).data;
        case 'packages': case 'models': return (await request('/packages')).data;
        case 'catalog': return (await request('/catalog')).data;
        case 'installed': return (await request('/installed')).data;
        case 'declarations': return (await request('/declarations')).data;
        case 'payloads': return (await request('/payloads')).data;
        case 'package': case 'model': return id ? (await request(`/package?id=${id}`)).data : { ok: false, error: 'package_key required' };
        case 'file': {
          if (!id || !command.path) return { ok: false, error: 'package_key and path required' };
          return (await request(`/file?id=${id}&path=${encodeURIComponent(command.path)}`)).data;
        }
        case 'refresh': return (await request('/refresh', { method: 'POST', body: { force: true }, timeoutMs: 120_000 })).data;
        case 'resolve_transfer': {
          if (!Array.isArray(command.files) || !command.files.length) return { ok: false, error: 'transfer_files_required' };
          return (await request('/resolve-transfer', { method: 'POST', body: { files: command.files }, timeoutMs: 120_000 })).data;
        }
        case 'download': case 'update': case 'verify': {
          if (!id) return { ok: false, error: 'package_key required' };
          const route = command.op === 'download' || command.op === 'update' ? command.op : 'verify';
          return (await request(`/package/${route}?id=${id}`, { method: 'POST', body: {}, timeoutMs: 3_600_000 })).data;
        }
        case 'delete-plan': {
          if (!id) return { ok: false, error: 'package_key required' };
          return (await request(`/package/delete-plan?id=${id}`, { method: 'POST', body: {}, timeoutMs: 120_000 })).data;
        }
        case 'remove': {
          if (!id) return { ok: false, error: 'package_key required' };
          const result = await request(`/package/delete?id=${id}`, {
            method: command.confirmation_token ? 'POST' : 'DELETE',
            body: command.confirmation_token ? { confirmation_token: command.confirmation_token } : {},
            timeoutMs: 120_000,
          });
          return { ...result.data, http_status: result.status };
        }
        case 'payload-delete-plan': {
          if (!id) return { ok: false, error: 'payload_id required' };
          return (await request(`/payload/delete-plan?id=${id}`, { method: 'POST', body: {}, timeoutMs: 120_000 })).data;
        }
        case 'payload-remove': {
          if (!id) return { ok: false, error: 'payload_id required' };
          const result = await request(`/payload/delete?id=${id}`, {
            method: command.confirmation_token ? 'POST' : 'DELETE',
            body: command.confirmation_token ? { confirmation_token: command.confirmation_token } : {},
            timeoutMs: 120_000,
          });
          return { ...result.data, http_status: result.status };
        }
        case 'operation': {
          if (!command.operation_id) return { ok: false, error: 'operation_id required' };
          return (await request(`/operations/${encodeURIComponent(command.operation_id)}`)).data;
        }
        case 'operations': return (await request('/operations')).data;
        case 'events': return (await request(`/events?after=${Number(command.after) || 0}&limit=${Number(command.limit) || 100}`)).data;
        default: return { ok: false, error: 'unknown_op', supported: [
          'summary', 'packages', 'models', 'catalog', 'installed', 'declarations', 'payloads', 'package', 'model', 'file',
          'refresh', 'resolve_transfer', 'download', 'update', 'verify', 'delete-plan', 'remove',
          'payload-delete-plan', 'payload-remove', 'operation', 'operations', 'events',
        ] };
      }
    },
  });

  context.capabilities.provide({
    id: 'termux-os.assets.manager', provider: 'hf-model-manager', kind: 'action', action: 'assets.manager.query', service: 'hf-model-manager',
  });
  context.capabilities.provide({
    id: 'termux-os.assets.inventory', provider: 'hf-model-manager', kind: 'feed', service: 'hf-model-manager',
    endpoint: `/api/packages/${context.packageId}/events`, format: 'jsonl-cursor',
  });
}
