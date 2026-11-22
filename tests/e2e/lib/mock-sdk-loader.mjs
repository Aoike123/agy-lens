// Node 24 --import loader hook intercepting import('sidecar_sdk') -> mock-sdk.mjs
// and optionally bridging mock LS HTTP/HTTPS requests over IPC when loopback TCP is blocked.

import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { register, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_SDK_URL = pathToFileURL(join(HERE, 'mock-sdk.mjs')).href;

const hookSource = `
const TARGET = ${JSON.stringify(MOCK_SDK_URL)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sidecar_sdk') {
    return { url: TARGET, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript;base64,${Buffer.from(hookSource, 'utf8').toString('base64')}`, import.meta.url);

if (process.env.E2E_LS_IPC_BRIDGE === '1' && typeof process.send === 'function') {
  const targetPort = String(process.env.E2E_LS_PORT || '');
  const pendingLs = new Map();
  let seq = 0;

  process.on('message', (msg) => {
    if (!msg || msg.type !== 'ls-response') return;
    const entry = pendingLs.get(msg.id);
    if (!entry) return;
    pendingLs.delete(msg.id);
    entry(msg);
  });

  const wrapRequest = (origFn, protocol) => function patchedRequest(options, cb) {
    let opts = options;
    let callback = cb;
    if (typeof options === 'string' || options instanceof URL) {
      const u = new URL(String(options));
      opts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? '443' : '80'),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: {},
      };
      if (typeof cb === 'object' && cb !== null) {
        opts = { ...opts, ...cb };
        callback = arguments[2];
      }
    }
    const host = String(opts?.hostname || opts?.host || '').split(':')[0];
    const port = String(opts?.port || '');
    if (host === '127.0.0.1' && targetPort && port === targetPort) {
      const req = new EventEmitter();
      const chunks = [];
      let ended = false;
      req.write = (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return true;
      };
      req.destroy = (err) => {
        if (err) req.emit('error', err);
      };
      req.setTimeout = () => req;
      req.end = (chunk) => {
        if (ended) return req;
        ended = true;
        if (chunk) req.write(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        const id = ++seq;
        const timer = setTimeout(() => {
          pendingLs.delete(id);
          req.emit('error', new Error('LS IPC bridge timeout'));
        }, opts?.timeout || 5000);
        pendingLs.set(id, (resp) => {
          clearTimeout(timer);
          if (resp.error) {
            const e = new Error(resp.error);
            if (resp.code) e.code = resp.code;
            req.emit('error', e);
            return;
          }
          const res = new EventEmitter();
          res.statusCode = resp.statusCode || 200;
          res.headers = resp.headers || {};
          if (typeof callback === 'function') callback(res);
          req.emit('response', res);
          if (resp.body) res.emit('data', Buffer.from(resp.body, 'utf8'));
          res.emit('end');
        });
        process.send({
          type: 'ls-request',
          id,
          protocol,
          hostname: host,
          port,
          path: opts?.path || '/',
          method: String(opts?.method || 'POST').toUpperCase(),
          headers: opts?.headers || {},
          body,
        });
        return req;
      };
      return req;
    }
    return origFn.apply(this, arguments);
  };

  http.request = wrapRequest(http.request, 'http:');
  https.request = wrapRequest(https.request, 'https:');
  syncBuiltinESMExports();
}
