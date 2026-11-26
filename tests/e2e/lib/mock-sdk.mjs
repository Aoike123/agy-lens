// Lightweight HTTP + IPC SidecarApp & Response adapter injected as 'sidecar_sdk'.
import http from 'node:http';

export class Response {
  constructor(body, { contentType = 'text/plain; charset=utf-8', status = 200, headers = {} } = {}) {
    this.body = body ?? '';
    this.contentType = contentType;
    this.status = status;
    this.headers = { ...headers };
  }
}

export class SidecarApp {
  constructor() {
    this._pages = new Map();
    this._apis = new Map();
    this._server = null;
  }

  page(path, handler) {
    this._pages.set(String(path), handler);
  }

  api(path, handler, method = 'GET') {
    this._apis.set(`${String(method).toUpperCase()} ${String(path)}`, handler);
  }

  async dispatch(method, rawUrl, body = null) {
    const u = new URL(rawUrl || '/', 'http://127.0.0.1');
    const pathname = u.pathname;

    if (pathname === '/preload.js') {
      let cfg = {};
      try {
        if (process.env.E2E_SIDECAR_PRELOAD_JSON) {
          cfg = JSON.parse(process.env.E2E_SIDECAR_PRELOAD_JSON);
        }
      } catch {
        cfg = {};
      }
      const js = `(function () {
  var cfg = ${JSON.stringify(cfg)};
  window.sidecar = {
    conversationId: cfg.conversationId || '',
    getWorkspaceUris: async function () { return Array.isArray(cfg.workspaceUris) ? cfg.workspaceUris : []; },
    onWorkspaceChange: function (cb) { window.__e2eWorkspaceCb = cb; },
    fetch: function (url, opts) { return window.fetch(url, opts); }
  };
})();\n`;
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        },
        body: js,
      };
    }

    const pageHandler = this._pages.get(pathname);
    if (pageHandler) {
      const res = await pageHandler(u);
      if (res instanceof Response || (res && typeof res === 'object' && 'body' in res)) {
        const headers = { ...(res.headers || {}) };
        if (res.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = res.contentType;
        }
        return {
          status: res.status || 200,
          headers,
          body: typeof res.body === 'string' || Buffer.isBuffer(res.body) ? res.body : String(res.body ?? ''),
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: String(res ?? ''),
      };
    }

    const apiHandler = this._apis.get(`${String(method || 'GET').toUpperCase()} ${pathname}`);
    if (apiHandler) {
      const data = Object.fromEntries(u.searchParams.entries());
      if (body && typeof body === 'object') Object.assign(data, body);
      const out = await apiHandler(data);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        },
        body: JSON.stringify(out),
      };
    }

    return {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      },
      body: 'Not found',
    };
  }

  run() {
    if (typeof process.on === 'function') {
      process.on('message', async (msg) => {
        if (!msg || msg.type !== 'http-request') return;
        try {
          const resp = await this.dispatch(msg.method || 'GET', msg.url || '/', msg.body && typeof msg.body === 'object' ? msg.body : null);
          if (typeof process.send === 'function') {
            process.send({
              type: 'http-response',
              id: msg.id,
              status: resp.status,
              headers: resp.headers,
              body: Buffer.isBuffer(resp.body) ? resp.body.toString('base64') : String(resp.body),
              isBase64: Buffer.isBuffer(resp.body),
            });
          }
        } catch (err) {
          if (typeof process.send === 'function') {
            process.send({
              type: 'http-response',
              id: msg.id,
              status: 500,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ error: 'failed', message: err.message }),
              isBase64: false,
            });
          }
        }
      });
    }

    this._server = http.createServer(async (req, res) => {
      try {
        let body = null;
        if (req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = null; }
        }
        const resp = await this.dispatch(req.method || 'GET', req.url || '/', body);
        res.writeHead(resp.status, resp.headers);
        res.end(resp.body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'failed', message: err.message }));
      }
    });

    this._server.listen(0, '127.0.0.1', () => {
      const addr = this._server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      if (typeof process.send === 'function') {
        process.send({ type: 'sidecar-ready', port });
      } else {
        process.stdout.write(`E2E_SIDECAR_READY:${port}\n`);
      }
    });

    const shutdown = () => {
      try { this._server?.close(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('disconnect', shutdown);
  }
}
