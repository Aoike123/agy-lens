// Loopback HTTP/HTTPS (self-signed cert) Antigravity Language Server Connect-JSON mock
// with IPC-bridge request handler support when loopback TCP is sandbox-blocked.

import { createSign, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

function derInt(num) {
  let buf = Buffer.isBuffer(num) ? num : Buffer.from([num]);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return derWrap(0x02, buf);
}

function derOid(bytes) {
  return derWrap(0x06, Buffer.from(bytes));
}

function createSelfSignedCert() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
  const sha256RsaOid = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
  const algId = derWrap(0x30, sha256RsaOid, Buffer.from([0x05, 0x00]));
  // CN=127.0.0.1 (OID 2.5.4.3 = [0x55, 0x04, 0x03])
  const cnAttr = derWrap(0x30, derOid([0x55, 0x04, 0x03]), derWrap(0x0c, Buffer.from('127.0.0.1', 'utf8')));
  const name = derWrap(0x30, derWrap(0x31, cnAttr));
  const validity = derWrap(
    0x30,
    derWrap(0x17, Buffer.from('250101000000Z', 'ascii')),
    derWrap(0x17, Buffer.from('350101000000Z', 'ascii')),
  );

  const tbs = derWrap(
    0x30,
    derWrap(0xa0, derInt(2)), // v3
    derInt(1), // serialNumber
    algId,
    name,
    validity,
    name,
    spkiDer,
  );

  const sig = createSign('SHA256').update(tbs).sign(privateKey);
  const certDer = derWrap(0x30, tbs, algId, derWrap(0x03, Buffer.from([0x00]), sig));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  return { key: keyPem, cert: certPem };
}

export const DEFAULT_STATUS_RESP = {
  userStatus: {
    name: 'Test Operator',
    email: 'operator@example.com',
    profilePictureUrl: 'data:image/png;base64,AAAA',
    planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
    userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          label: 'Gemini 4 Neon (High)',
          modelId: 'gemini-4-neon-high',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
          quotaInfo: { remainingFraction: 0.72, resetTime: '2026-11-22T08:00:00Z' },
        },
        {
          label: 'Claude Opus 4.6',
          modelId: 'claude-opus-4-6',
          quotaInfo: { remainingFraction: 0.69, resetTime: '2026-11-22T08:30:00Z' },
        },
      ],
      clientModelSorts: [
        { name: 'Recommended', groups: [{ modelLabels: ['Gemini 4 Neon (High)', 'Claude Opus 4.6'] }] },
      ],
      groupedModels: {
        'gemini-4-neon': {
          displayName: 'Gemini 4 Neon',
          supportedThinkingLevels: [{ thinkingSuffix: 'high', thinkingDisplayName: 'High' }],
        },
      },
    },
  },
};

export const DEFAULT_MODELS_RESP = {
  response: {
    models: {
      'gemini-4-neon-high': {
        displayName: 'Gemini 4 Neon (High)',
        maxTokens: 1048576,
        quotaInfo: { remainingFraction: 0.72, resetTime: '2026-11-22T08:00:00Z' },
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
      },
      'claude-opus-4-6': {
        displayName: 'Claude Opus 4.6',
        maxTokens: 250000,
        quotaInfo: { remainingFraction: 0.69, resetTime: '2026-11-22T08:30:00Z' },
        modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
      },
      tab_flash_lite_preview: {
        quotaInfo: { remainingFraction: 1 },
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
      },
    },
    agentModelSorts: [
      { displayName: 'Recommended', groups: [{ modelIds: ['gemini-4-neon-high', 'claude-opus-4-6'] }] },
    ],
  },
};

export const DEFAULT_SUMMARY_RESP = {
  response: {
    groups: [
      {
        displayName: 'Gemini Limit Remaining',
        buckets: [
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.72, resetTime: '2026-11-22T08:00:00Z' },
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.833, resetTime: '2026-11-29T00:00:00Z' },
        ],
      },
      {
        displayName: 'Third Party Limit Remaining',
        buckets: [
          { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.41, resetTime: '2026-11-28T00:00:00Z' },
          { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.69, resetTime: '2026-11-22T08:30:00Z' },
        ],
      },
    ],
  },
};

export async function startMockLs({
  useHttps = false,
  csrfToken = 'e2e-csrf-token',
  statusResp = DEFAULT_STATUS_RESP,
  modelsResp = DEFAULT_MODELS_RESP,
  summaryResp = DEFAULT_SUMMARY_RESP,
  failMode = null,
} = {}) {
  const state = {
    csrfToken,
    statusResp,
    modelsResp,
    summaryResp,
    failMode,
  };
  const requests = [];
  const validationErrors = [];

  const handleRpc = (method, path, headers, rawBody) => {
    const normHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      normHeaders[String(k).toLowerCase()] = String(v);
    }
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody || '{}');
    } catch {
      parsedBody = null;
    }

    const prefix = '/exa.language_server_pb.LanguageServerService/';
    const rpcMethod = String(path || '').startsWith(prefix) ? String(path).slice(prefix.length) : '';
    requests.push({ method, path, rpcMethod, headers: normHeaders, body: parsedBody });

    if (String(method).toUpperCase() !== 'POST') {
      validationErrors.push(`Expected POST, got ${method}`);
      return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!rpcMethod) {
      validationErrors.push(`Unexpected path: ${path}`);
      return { statusCode: 404, body: JSON.stringify({ error: 'Unknown service path' }) };
    }
    if (normHeaders['connect-protocol-version'] !== '1') {
      validationErrors.push(`Missing/invalid Connect-Protocol-Version: ${normHeaders['connect-protocol-version']}`);
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing Connect-Protocol-Version: 1' }) };
    }
    if (normHeaders['x-codeium-csrf-token'] !== state.csrfToken) {
      validationErrors.push(`Invalid x-codeium-csrf-token: ${normHeaders['x-codeium-csrf-token']}`);
      return { statusCode: 403, body: JSON.stringify({ error: 'Invalid CSRF token' }) };
    }
    if (!parsedBody?.metadata || parsedBody.metadata.ideName !== 'antigravity' || parsedBody.metadata.extensionName !== 'antigravity') {
      validationErrors.push(`Invalid LS metadata body: ${rawBody}`);
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid metadata' }) };
    }

    if (state.failMode === 'http500') {
      return { statusCode: 500, body: JSON.stringify({ code: 'internal', message: 'Simulated LS failure' }) };
    }

    if (rpcMethod === 'GetUserStatus') {
      return { statusCode: 200, body: JSON.stringify(state.statusResp ?? {}) };
    }
    if (rpcMethod === 'GetAvailableModels') {
      return { statusCode: 200, body: JSON.stringify(state.modelsResp ?? {}) };
    }
    if (rpcMethod === 'RetrieveUserQuotaSummary') {
      return { statusCode: 200, body: JSON.stringify(state.summaryResp ?? {}) };
    }
    validationErrors.push(`Unknown RPC method: ${rpcMethod}`);
    return { statusCode: 404, body: JSON.stringify({ error: `Unknown RPC: ${rpcMethod}` }) };
  };

  const listener = (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const out = handleRpc(req.method, req.url, req.headers, raw);
      res.writeHead(out.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(out.body);
    });
  };

  const server = useHttps
    ? https.createServer(createSelfSignedCert(), listener)
    : http.createServer(listener);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  const protocol = useHttps ? 'https' : 'http';
  const url = `${protocol}://127.0.0.1:${port}`;

  return {
    url,
    port,
    protocol,
    csrfToken: state.csrfToken,
    requests,
    validationErrors,
    setResponses(next = {}) {
      if ('statusResp' in next) state.statusResp = next.statusResp;
      if ('modelsResp' in next) state.modelsResp = next.modelsResp;
      if ('summaryResp' in next) state.summaryResp = next.summaryResp;
      if ('failMode' in next) state.failMode = next.failMode;
    },
    handleIpcRequest(msg) {
      if (state.failMode === 'connectError') {
        return { error: 'connect ECONNREFUSED', code: 'ECONNREFUSED' };
      }
      const out = handleRpc(msg.method, msg.path, msg.headers, msg.body);
      return {
        statusCode: out.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: out.body,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
