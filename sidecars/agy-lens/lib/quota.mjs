// Antigravity Language Server RPC client, secret redactor, quota limit
// inference, and quota/summary parsers. Pure ESM, zero external dependencies.

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import {
  PROVIDER_ORDER,
  asList,
  isTabModel,
  modelConfigData,
  modelQuotaBucket,
  pick,
  providerName,
  rootOf,
  statusOf,
  writeModelCatalog,
} from './catalog.mjs';
import { defaultDataDir, roundN, writeJsonAtomic } from './pb.mjs';

export const LS_METADATA = { ideName: 'antigravity', extensionName: 'antigravity' };

export function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    const err = new Error('no language server address');
    err.code = 'NO_LS';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
    const data = JSON.stringify(body);
    const transport = base.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: base.hostname,
      port: base.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 5000,
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method}: HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

const SECRET_KEY = /token|secret|password|passwd|auth|cookie|session|credential|api_?key|email|csrf/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\bya29\.[A-Za-z0-9._~+/=-]+/gi;

// Deep copy with emails, token-like strings, secret-named string fields and
// personal profile fields replaced, for the debugging dump.
const PERSONAL_KEY = /picture|avatar|photo/i;
const PERSON_PARENT = /^(userStatus|user_status|user|users|profile|profiles|account|accounts|userInfo|user_info|person|identity|owner|member)$/i;
const NON_PERSON_KEY = /tier|plan|model|config|quota|group|sort|bucket|limit/i;
const PERSON_FIELD = /^(name|displayName|display_name|fullName|full_name|firstName|first_name|lastName|last_name|givenName|given_name|familyName|family_name|username|user_name)$/i;
export function redact(value, key = '', parent = '', inSecret = false, inPerson = false) {
  const secretHere = inSecret || SECRET_KEY.test(key) || PERSONAL_KEY.test(key);
  const personHere = !NON_PERSON_KEY.test(key) && (PERSON_PARENT.test(key) || PERSON_PARENT.test(parent) || inPerson);
  if (Array.isArray(value)) return value.map((v) => redact(v, key, parent, secretHere, personHere));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, key, secretHere, personHere);
    return out;
  }
  if (typeof value === 'string') {
    if (secretHere) return '[redacted]';
    if (PERSON_FIELD.test(key) && (PERSON_PARENT.test(parent) || inPerson)) return '[redacted]';
    return value.replace(EMAIL, '[email]').replace(BEARER, '[redacted]').replace(JWT_LIKE, '[redacted]');
  }
  return value;
}

function toFraction(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') {
    // protobuf Timestamp as an object {seconds, nanos}
    const s = Number(v.seconds);
    if (!Number.isFinite(s)) return null;
    return new Date(s * 1000 + Math.floor((Number(v.nanos) || 0) / 1e6)).toISOString();
  }
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n); // seconds or milliseconds
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Normalizes one model-like entry to {id, display_name, provider, quota} where
// quota is {remaining_fraction, reset_time} or null when it has no quota info.
// display_name is null when the server gives none (internal models).
function modelEntry(m, key) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const alias = pick(m, 'modelOrAlias', 'model_or_alias');
  const id = String(
    (typeof key === 'string' && key) ||
    pick(m, 'modelId', 'model_id') ||
    pick(alias, 'model', 'alias') ||
    (typeof m.model === 'string' ? m.model : undefined) ||
    pick(m, 'id', 'name', 'label') || ''
  );
  if (!id) return null;
  const display = pick(m, 'displayName', 'display_name', 'label');
  const q = pick(m, 'quotaInfo', 'quota_info', 'quota');
  let quota = null;
  if (q && typeof q === 'object') {
    const reset = toIso(pick(q, 'resetTime', 'reset_time', 'resetAt'));
    let frac = toFraction(pick(q, 'remainingFraction', 'remaining_fraction', 'fractionRemaining'));
    // proto3 JSON omits zero values: quota info with a reset time but no
    // fraction means the quota is used up.
    if (frac === null && reset) frac = 0;
    quota = { remaining_fraction: frac, reset_time: reset };
  }
  const provider = pick(m, 'modelProvider', 'model_provider');
  const hidden = Boolean(pick(m, 'hidden', 'isHidden', 'is_hidden', 'disabled', 'isDisabled', 'is_disabled', 'deprecated', 'isDeprecated', 'is_deprecated'));
  return { id, display_name: display ? String(display) : null, provider: provider ? String(provider) : '', quota, hidden };
}

function listModels(resp) {
  const out = [];
  const root = rootOf(resp);
  if (!root) return out;
  const add = (container) => {
    for (const [k, m] of asList(container)) { const e = modelEntry(m, k); if (e) out.push(e); }
  };
  add(root.models);
  add(pick(modelConfigData(resp), 'clientModelConfigs', 'client_model_configs'));
  add(pick(statusOf(resp), 'clientModelConfigs', 'client_model_configs'));
  return out;
}

// Model IDs the app's model picker shows, in picker order.
function visibleModelIds(statusResp, modelsResp) {
  const ids = new Set();
  for (const resp of [modelsResp, statusResp]) {
    const root = rootOf(resp);
    for (const sort of asList(pick(root, 'agentModelSorts', 'agent_model_sorts')).map(([, s]) => s)) {
      for (const g of asList(pick(sort, 'groups')).map(([, x]) => x)) {
        for (const [, id] of asList(pick(g, 'modelIds', 'model_ids'))) if (typeof id === 'string') ids.add(id);
      }
    }
  }
  if (!ids.size) {
    for (const resp of [statusResp, modelsResp]) {
      const cfgData = modelConfigData(resp);
      const cfgs = asList(pick(cfgData, 'clientModelConfigs', 'client_model_configs')).map(([, c]) => c);
      const byLabel = new Map();
      for (const c of cfgs) {
        if (!c || typeof c !== 'object') continue;
        const id = pick(c, 'modelId', 'model_id');
        const lbl = pick(c, 'label', 'displayName', 'display_name');
        if (typeof id === 'string' && id && typeof lbl === 'string' && lbl && !byLabel.has(lbl)) byLabel.set(lbl, id);
      }
      for (const sort of asList(pick(cfgData, 'clientModelSorts', 'client_model_sorts')).map(([, s]) => s)) {
        for (const g of asList(pick(sort, 'groups')).map(([, x]) => x)) {
          for (const [, id] of asList(pick(g, 'modelIds', 'model_ids'))) if (typeof id === 'string' && id) ids.add(id);
          for (const [, lbl] of asList(pick(g, 'modelLabels', 'model_labels'))) {
            const id = typeof lbl === 'string' ? byLabel.get(lbl) : undefined;
            if (id) ids.add(id);
          }
        }
      }
    }
  }
  if (!ids.size) {
    for (const resp of [statusResp, modelsResp]) {
      for (const [, c] of asList(pick(modelConfigData(resp), 'clientModelConfigs', 'client_model_configs'))) {
        if (!c || typeof c !== 'object') continue;
        if (pick(c, 'hidden', 'isHidden', 'is_hidden', 'disabled', 'isDisabled', 'is_disabled', 'deprecated', 'isDeprecated', 'is_deprecated')) continue;
        const id = pick(c, 'modelId', 'model_id');
        if (typeof id === 'string' && id) ids.add(id);
      }
    }
  }
  return ids;
}

// groupedModels: family id -> {display_name, levels: [{suffix, display, modelId}]}
function modelFamilies(statusResp, modelsResp) {
  const fams = new Map();
  for (const resp of [modelsResp, statusResp]) {
    for (const src of [pick(rootOf(resp), 'groupedModels', 'grouped_models'), pick(modelConfigData(resp), 'groupedModels', 'grouped_models')]) {
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      for (const [fid, g] of Object.entries(src)) {
        if (fams.has(fid) || !g || typeof g !== 'object') continue;
        const levels = asList(pick(g, 'supportedThinkingLevels', 'supported_thinking_levels'))
          .map(([, l]) => ({
            suffix: String(pick(l, 'thinkingSuffix', 'thinking_suffix') || ''),
            display: String(pick(l, 'thinkingDisplayName', 'thinking_display_name') || ''),
            modelId: String(pick(l, 'modelId', 'model_id') || ''),
          }))
          .filter((l) => l.suffix || l.modelId);
        fams.set(fid, { display_name: String(pick(g, 'displayName', 'display_name') || fid), levels });
      }
    }
  }
  return fams;
}

function familyOf(fams, id) {
  for (const [fid, f] of fams) {
    if (id === fid) return { fid, f, level: null, levelOrder: -1 };
    for (let idx = 0; idx < f.levels.length; idx += 1) {
      const l = f.levels[idx];
      if ((l.modelId && id === l.modelId) || (l.suffix && id === `${fid}-${l.suffix}`)) {
        return { fid, f, level: l.display || l.suffix || id, levelOrder: idx };
      }
    }
  }
  return null;
}

const PAREN_VARIANT = /^(.+?)\s*\(([^()]+)\)\s*$/;
const EFFORT_RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, 'extra high': 4, max: 5 };

function splitParenVariant(name) {
  const m = String(name || '').trim().match(PAREN_VARIANT);
  if (!m) return null;
  const base = m[1].trim();
  const variant = m[2].trim();
  return base && variant ? { base, variant } : null;
}

function familySlug(name, fallbackId) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || fallbackId;
}

const HOUR = 3600 * 1000;
const SLACK = 2 * 60 * 1000;
const LIMIT_LABELS = {
  '5h': ['5-hour limit', '5 小时限额'],
  daily: ['Daily limit', '每日限额'],
  weekly: ['Weekly limit', '每周限额'],
  none: ['Unlimited · no reset', '不限 · 无重置'],
  unknown: ['Quota', '额度'],
};
const LIMIT_ORDER = { weekly: 0, '5h': 1, daily: 2, unknown: 3, none: 4 };
const SUMMARY_POOL_LABELS = {
  gemini: ['Gemini models', 'Gemini 模型'],
  claude_gpt: ['Claude / GPT-OSS models', 'Claude / GPT-OSS 模型'],
  claude_opus: ['Claude Opus models', 'Claude Opus 模型'],
  claude_sonnet: ['Claude Sonnet models', 'Claude Sonnet 模型'],
  other: ['Other models', '其他模型'],
};

// The LS reports no window length, so the limit kind is inferred from the
// time left until reset (a rolling 5-hour window never resets later than 5h
// from now; multi-day cycles up to 31 days classify as weekly).
export function inferLimit(remaining_fraction, reset_time, now = Date.now()) {
  let kind = 'unknown';
  if (!reset_time) {
    if (remaining_fraction === 1) kind = 'none';
  } else {
    const dt = Date.parse(reset_time) - now;
    if (dt >= 0 && dt <= 5 * HOUR + SLACK) kind = '5h';
    else if (dt > 0 && dt <= 24 * HOUR + SLACK) kind = 'daily';
    else if (dt > 0 && dt <= 31 * 24 * HOUR + SLACK) kind = 'weekly';
  }
  const [label, label_zh] = LIMIT_LABELS[kind];
  return { kind, inferred: kind !== 'unknown', label, label_zh, remaining_fraction, reset_time };
}

function summaryCategory(bucketId, groupName) {
  let generic3p = false;
  for (const raw of [bucketId, groupName]) {
    const text = String(raw || '').toLowerCase();
    if (!text) continue;
    if (/gemini|google/.test(text)) return 'gemini';
    const hasOpus = /(?:^|[^a-z0-9])opus(?:$|[^a-z0-9])/.test(text);
    const hasSonnet = /(?:^|[^a-z0-9])sonnet(?:$|[^a-z0-9])/.test(text);
    const hasGpt = /(?:^|[^a-z0-9])gpt(?:$|[^a-z0-9])/.test(text);
    if (hasOpus && !hasSonnet && !hasGpt) return 'claude_opus';
    if (hasSonnet && !hasOpus && !hasGpt) return 'claude_sonnet';
    if (/(?:^|[^a-z0-9])3p(?:$|[^a-z0-9])|claude|third/.test(text) || hasGpt || hasOpus || hasSonnet) {
      generic3p = true;
    }
  }
  return generic3p ? 'claude_gpt' : 'other';
}

function summaryLimitKind(bucketId, displayName, windowVal = '') {
  const text = `${windowVal || ''} ${bucketId || ''} ${displayName || ''}`.toLowerCase();
  if (/weekly|(?:^|[^a-z0-9])7[-_\s]?d(?:ay)?s?(?:$|[^a-z0-9])/.test(text)) return 'weekly';
  if (/(?:^|[^a-z0-9])(?:5[-_\s]?h(?:our)?s?|five)(?:$|[^a-z0-9])/.test(text)) return '5h';
  if (/daily|(?:^|[^a-z0-9])24[-_\s]?h(?:our)?s?(?:$|[^a-z0-9])/.test(text)) return 'daily';
  return null;
}

function sortLimits(limits) {
  return limits.slice().sort((a, b) => (LIMIT_ORDER[a.kind] ?? 9) - (LIMIT_ORDER[b.kind] ?? 9));
}

function mergeLimitLists(existing, incoming) {
  const byKind = new Map();
  const hasExplicitIncoming = incoming.some((l) => !l.inferred);
  for (const l of existing) {
    if (hasExplicitIncoming && l.inferred && (l.kind === 'none' || l.kind === 'unknown')) continue;
    byKind.set(l.kind, l);
  }
  for (const l of incoming) {
    const prev = byKind.get(l.kind);
    if (!prev) { byKind.set(l.kind, l); continue; }
    if (prev.inferred && !l.inferred) { byKind.set(l.kind, l); continue; }
    if (prev.inferred === l.inferred && prev.remaining_fraction === null && l.remaining_fraction !== null) {
      byKind.set(l.kind, l);
    }
  }
  return sortLimits([...byKind.values()]);
}

// Parses RetrieveUserQuotaSummary defensively across response.groups,
// quotaSummary.groups, groups, or top-level buckets.
export function parseQuotaSummary(summaryResp, now = Date.now()) {
  const byCategory = {};
  const weekly = {};
  const root = rootOf(summaryResp);
  if (!root) return { byCategory, weekly };
  const container = pick(root, 'quotaSummary', 'quota_summary') || root;
  const groups = pick(container, 'groups', 'quotaGroups', 'quota_groups');
  const topBuckets = pick(container, 'buckets', 'quotaBuckets', 'quota_buckets');

  const bucketPairs = [];
  if (Array.isArray(groups)) {
    for (let groupIdx = 0; groupIdx < groups.length; groupIdx += 1) {
      const g = groups[groupIdx];
      if (!g || typeof g !== 'object') continue;
      const gId = pick(g, 'groupId', 'group_id', 'id');
      const gName = pick(g, 'displayName', 'display_name', 'name') || gId;
      const gDesc = pick(g, 'description');
      const bs = pick(g, 'buckets', 'quotaBuckets', 'quota_buckets');
      if (Array.isArray(bs)) {
        for (const b of bs) {
          bucketPairs.push({
            b,
            groupIdx,
            groupName: gName ? String(gName) : '',
            groupId: gId ? String(gId) : '',
            groupDesc: gDesc ? String(gDesc) : '',
          });
        }
      }
    }
  }
  if (Array.isArray(topBuckets)) {
    for (const b of topBuckets) {
      bucketPairs.push({ b, groupIdx: -1, groupName: '', groupId: '', groupDesc: '' });
    }
  }

  const groupCategory = new Map();
  const claimedByGroup = new Map();

  for (const { b, groupIdx, groupName, groupId, groupDesc } of bucketPairs) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const bucketId = pick(b, 'bucketId', 'bucket_id', 'id');
    const displayName = pick(b, 'displayName', 'display_name', 'label', 'name');
    const windowVal = pick(b, 'window', 'windowType', 'window_type');
    const q = pick(b, 'quotaInfo', 'quota_info', 'quota') || b;
    const reset = toIso(pick(q, 'resetTime', 'reset_time', 'resetAt'));
    let frac = toFraction(pick(q, 'remainingFraction', 'remaining_fraction', 'fractionRemaining'));
    if (frac === null && reset) frac = 0;
    if (frac === null && !reset) continue;

    let category;
    if (groupIdx >= 0 && groupCategory.has(groupIdx)) {
      category = groupCategory.get(groupIdx);
    } else {
      category = summaryCategory(bucketId, groupName || groupId || displayName);
      if (groupIdx >= 0) {
        if (claimedByGroup.has(category) && claimedByGroup.get(category) !== groupIdx) {
          const slugSrc = groupId || groupName || bucketId || `group_${groupIdx + 1}`;
          const baseSlug = String(slugSrc).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `group_${groupIdx + 1}`;
          let candidate = category === 'other' ? `custom_${baseSlug}` : baseSlug;
          let suffix = 2;
          while (claimedByGroup.has(candidate) || byCategory[candidate]) {
            candidate = `${category === 'other' ? `custom_${baseSlug}` : baseSlug}_${suffix++}`;
          }
          category = candidate;
        }
        groupCategory.set(groupIdx, category);
        claimedByGroup.set(category, groupIdx);
      } else if (category === 'other' && groupName) {
        const existingOther = byCategory.other;
        if (existingOther && existingOther.label.toLowerCase() !== String(groupName).toLowerCase()) {
          const customSlug = String(groupName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'group';
          category = `custom_${customSlug}`;
        }
      }
    }
    const explicitKind = summaryLimitKind(bucketId, displayName, windowVal);
    const limit = explicitKind
      ? {
          kind: explicitKind,
          inferred: false,
          label: LIMIT_LABELS[explicitKind][0],
          label_zh: LIMIT_LABELS[explicitKind][1],
          remaining_fraction: frac,
          reset_time: reset,
        }
      : { ...inferLimit(frac, reset, now), inferred: true };

    if (!byCategory[category]) {
      const known = SUMMARY_POOL_LABELS[category];
      const isCustom = category === 'other' || !known;
      const label = isCustom && groupName ? groupName : (known ? known[0] : SUMMARY_POOL_LABELS.other[0]);
      const label_zh = isCustom && groupName ? groupName : (known ? known[1] : SUMMARY_POOL_LABELS.other[1]);
      byCategory[category] = { category, label, label_zh, ...(groupDesc ? { description: groupDesc } : {}), limits: [] };
    }
    byCategory[category].limits = mergeLimitLists(byCategory[category].limits, [limit]);
  }

  for (const [cat, entry] of Object.entries(byCategory)) {
    const wk = entry.limits.find((l) => l.kind === 'weekly' && l.remaining_fraction !== null);
    if (wk) weekly[cat] = { remaining_fraction: wk.remaining_fraction, reset_time: wk.reset_time };
  }
  return { byCategory, weekly };
}

function findPlan(resp) {
  const status = statusOf(resp);
  if (!status) return null;
  const planStatus = pick(status, 'planStatus', 'plan_status');
  const planInfo = pick(planStatus, 'planInfo', 'plan_info') || pick(status, 'planInfo', 'plan_info');
  const name = pick(planInfo, 'planName', 'plan_name', 'teamsTier', 'teams_tier', 'name') ||
    pick(status, 'planName', 'plan_name');
  return name ? String(name) : null;
}

function findTier(resp) {
  const tier = pick(statusOf(resp), 'userTier', 'user_tier');
  const name = typeof tier === 'string' ? tier : pick(tier, 'name', 'id');
  return name ? String(name) : null;
}

function dedupeByName(models, exclude = new Set()) {
  const seen = new Set(exclude);
  const out = [];
  for (const m of models) {
    const name = m.display_name || m.id;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: m.id, display_name: name });
  }
  return out;
}

// Builds the /api/quota payload (without fetched_at) from the raw responses of
// GetUserStatus, GetAvailableModels and RetrieveUserQuotaSummary (any may be null).
export function parseQuota(statusResp, modelsResp, now = Date.now(), summaryResp = null) {
  const byId = new Map();
  for (const e of [...listModels(modelsResp), ...listModels(statusResp)]) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    if (!prev.quota && e.quota) prev.quota = e.quota;
    if (!prev.display_name && e.display_name) prev.display_name = e.display_name;
    if (!prev.provider && e.provider) prev.provider = e.provider;
    if (e.hidden) prev.hidden = true;
  }
  const visible = visibleModelIds(statusResp, modelsResp);
  const hasPicker = visible.size > 0;
  const isVisible = (m) => !m.hidden && (hasPicker ? visible.has(m.id) : !!m.display_name && !isTabModel(m));
  const order = [...visible];
  const rank = (m) => { const i = order.indexOf(m.id); return i < 0 ? Infinity : i; };
  const fams = modelFamilies(statusResp, modelsResp);

  const groups = new Map();
  const unassigned = [];
  for (const m of byId.values()) {
    if (!m.quota) continue;
    const bucket = modelQuotaBucket(m);
    if (bucket === 'other') {
      unassigned.push(m);
      continue;
    }
    const key = `${bucket}|${m.quota.remaining_fraction}|${m.quota.reset_time}`;
    if (!groups.has(key)) groups.set(key, { tab: bucket === 'tab', bucket, ...m.quota, members: [] });
    groups.get(key).members.push(m);
  }
  for (const m of unassigned) {
    let target = null;
    if (m.quota.reset_time !== null) {
      const matches = [...groups.values()].filter(
        (g) => !g.tab && g.remaining_fraction === m.quota.remaining_fraction && g.reset_time === m.quota.reset_time,
      );
      if (matches.length === 1) target = matches[0];
    }
    if (target) {
      target.members.push(m);
    } else {
      const key = `other|${m.quota.remaining_fraction}|${m.quota.reset_time}`;
      if (!groups.has(key)) groups.set(key, { tab: false, bucket: 'other', ...m.quota, members: [] });
      groups.get(key).members.push(m);
    }
  }

  const summary = parseQuotaSummary(summaryResp, now);
  const claudeGroupCount = [...groups.values()].filter((g) => g.bucket === 'claude_gpt').length;
  const usedIds = new Map();
  const provRank = (x) => { const i = PROVIDER_ORDER.indexOf(x); return i < 0 ? 999 : i; };
  const pools = [...groups.values()].map((g) => {
    const members = g.members.slice().sort((a, b) => rank(a) - rank(b) || (a.display_name || a.id).localeCompare(b.display_name || b.id));
    const shown = members.filter(isVisible);
    const models = dedupeByName(shown);
    const hidden_models = dedupeByName(members.filter((m) => !isVisible(m)), new Set(models.map((m) => m.display_name)));

    const families = [];
    const famIndex = new Map();
    const famLevelOrder = [];
    const parenVariants = new Map();
    for (const m of shown) {
      if (familyOf(fams, m.id)) continue;
      const pv = splitParenVariant(m.display_name);
      if (!pv) continue;
      const bk = pv.base.toLowerCase();
      if (!parenVariants.has(bk)) parenVariants.set(bk, new Set());
      parenVariants.get(bk).add(pv.variant.toLowerCase());
    }
    for (const m of shown) {
      const fam = familyOf(fams, m.id);
      const pv = !fam ? splitParenVariant(m.display_name) : null;
      const isParenFamily = Boolean(pv && (parenVariants.get(pv.base.toLowerCase())?.size || 0) >= 2);
      const fkey = fam ? `f:${fam.fid}` : (isParenFamily ? `p:${pv.base.toLowerCase()}` : `n:${m.display_name || m.id}`);
      if (!famIndex.has(fkey)) {
        famIndex.set(fkey, families.length);
        families.push(fam
          ? { id: fam.fid, display_name: fam.f.display_name, levels: [] }
          : (isParenFamily
            ? { id: familySlug(pv.base, m.id), display_name: pv.base, levels: [] }
            : { id: m.id, display_name: m.display_name || m.id, levels: [] }));
        famLevelOrder.push(new Map());
      }
      const idx = famIndex.get(fkey);
      const entry = families[idx];
      if (fam?.level && !entry.levels.includes(fam.level)) {
        entry.levels.push(fam.level);
        famLevelOrder[idx].set(fam.level, fam.levelOrder);
      } else if (isParenFamily) {
        const vLow = pv.variant.toLowerCase();
        if (!entry.levels.some((x) => x.toLowerCase() === vLow)) {
          entry.levels.push(pv.variant);
        }
      }
    }
    for (let i = 0; i < families.length; i += 1) {
      const ord = famLevelOrder[i];
      if (families[i].levels.length > 1) {
        if (ord.size > 0) {
          families[i].levels.sort((a, b) => (ord.get(a) ?? 999) - (ord.get(b) ?? 999));
        } else if (families[i].levels.every((lv) => Object.prototype.hasOwnProperty.call(EFFORT_RANK, lv.toLowerCase()))) {
          families[i].levels.sort((a, b) => EFFORT_RANK[a.toLowerCase()] - EFFORT_RANK[b.toLowerCase()]);
        }
      }
    }

    let kind = 'models';
    let label;
    let label_zh;
    let slug;
    if (g.tab) {
      kind = 'tab';
      label = 'Tab completion';
      label_zh = 'Tab 补全';
      slug = 'tab';
    } else {
      const activeMembers = shown.length ? shown : members;
      const provs = new Set(activeMembers.map(providerName).filter(Boolean));
      const names = [...provs].sort((a, b) => provRank(a) - provRank(b) || a.localeCompare(b));
      if (names.length) {
        if (names.length === 1 && names[0] === 'Gemini') {
          slug = 'gemini';
          label = `${names.join(' / ')} models`;
          label_zh = `${names.join(' / ')} 模型`;
        } else if (names.every((x) => x === 'Claude' || x === 'GPT-OSS' || x === 'OpenAI')) {
          const allOpus = activeMembers.length > 0
            && activeMembers.every((m) => /(?:^|[^a-z0-9])opus(?:$|[^a-z0-9])/i.test(`${m.id} ${m.display_name || ''}`));
          const allSonnet = activeMembers.length > 0
            && activeMembers.every((m) => /(?:^|[^a-z0-9])sonnet(?:$|[^a-z0-9])/i.test(`${m.id} ${m.display_name || ''}`));
          if (allOpus && (claudeGroupCount > 1 || Boolean(summary.byCategory.claude_opus))) {
            slug = 'claude_opus';
            label = SUMMARY_POOL_LABELS.claude_opus[0];
            label_zh = SUMMARY_POOL_LABELS.claude_opus[1];
          } else if (allSonnet && (Boolean(summary.byCategory.claude_sonnet) || (claudeGroupCount > 1 && !summary.byCategory.claude_gpt))) {
            slug = 'claude_sonnet';
            label = SUMMARY_POOL_LABELS.claude_sonnet[0];
            label_zh = SUMMARY_POOL_LABELS.claude_sonnet[1];
          } else {
            slug = 'claude_gpt';
            label = `${names.join(' / ')} models`;
            label_zh = `${names.join(' / ')} 模型`;
          }
        } else {
          label = `${names.join(' / ')} models`;
          label_zh = `${names.join(' / ')} 模型`;
          slug = names.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '');
        }
      } else {
        const list = models.length ? models : hidden_models;
        label = list.length <= 2 ? list.map((m) => m.display_name).join(' / ') : `${list[0].display_name} +${list.length - 1}`;
        label_zh = label;
        slug = 'other';
      }
    }
    const n = (usedIds.get(slug) || 0) + 1;
    usedIds.set(slug, n);

    return {
      id: n > 1 ? `${slug}-${n}` : slug,
      category: slug,
      kind,
      label,
      label_zh,
      remaining_fraction: g.remaining_fraction,
      reset_time: g.reset_time,
      limits: [inferLimit(g.remaining_fraction, g.reset_time, now)],
      models,
      families,
      hidden_models,
    };
  });
  const matchedSummaryCats = new Set();
  const summaryTargets = new Map();
  const limitMatches = (pl, sl) => sl.kind === pl.kind
    && sl.remaining_fraction === pl.remaining_fraction
    && (!pl.reset_time || !sl.reset_time || sl.reset_time === pl.reset_time);
  for (const pool of pools) {
    const sumEntry = summary.byCategory[pool.category];
    if (!sumEntry || pool.kind === 'tab') continue;
    if (!pool.limits.some((l) => l.kind !== 'none')) continue;
    const prev = summaryTargets.get(pool.category);
    if (!prev) {
      summaryTargets.set(pool.category, pool);
    } else {
      const prevMatches = prev.limits.some((pl) => sumEntry.limits.some((sl) => limitMatches(pl, sl)));
      const curMatches = pool.limits.some((pl) => sumEntry.limits.some((sl) => limitMatches(pl, sl)));
      if (!prevMatches && curMatches) summaryTargets.set(pool.category, pool);
    }
  }
  const matchedPools = new Set(summaryTargets.values());
  for (const [cat, pool] of summaryTargets) {
    const sumEntry = summary.byCategory[cat];
    matchedSummaryCats.add(cat);
    pool.limits = mergeLimitLists(pool.limits, sumEntry.limits);
    const primary = pool.limits.find((l) => l.kind === '5h') || pool.limits[0];
    if (primary) {
      pool.remaining_fraction = primary.remaining_fraction;
      pool.reset_time = primary.reset_time;
    }
  }
  for (const [cat, sumEntry] of Object.entries(summary.byCategory)) {
    if (matchedSummaryCats.has(cat) || !sumEntry.limits.length) continue;
    const candidates = pools.filter((p) => !matchedPools.has(p) && p.kind !== 'tab' && p.limits.some((l) => l.kind !== 'none'));
    const byLimit = candidates.find((p) => p.limits.some((pl) => sumEntry.limits.some((sl) => limitMatches(pl, sl))));
    const descLow = String(sumEntry.description || '').toLowerCase();
    const byDesc = !byLimit && descLow
      ? candidates.find((p) => [...p.families, ...p.models].some((m) => m.display_name && descLow.includes(m.display_name.toLowerCase())))
      : null;
    const target = byLimit || byDesc;
    if (target) {
      matchedPools.add(target);
      matchedSummaryCats.add(cat);
      target.category = cat;
      const n = (usedIds.get(cat) || 0) + 1;
      usedIds.set(cat, n);
      target.id = n > 1 ? `${cat}-${n}` : cat;
      if (sumEntry.label) target.label = sumEntry.label;
      if (sumEntry.label_zh) target.label_zh = sumEntry.label_zh;
      target.limits = mergeLimitLists(target.limits, sumEntry.limits);
      const primary = target.limits.find((l) => l.kind === '5h') || target.limits[0];
      if (primary) {
        target.remaining_fraction = primary.remaining_fraction;
        target.reset_time = primary.reset_time;
      }
      continue;
    }
    const n = (usedIds.get(cat) || 0) + 1;
    usedIds.set(cat, n);
    const primary = sumEntry.limits.find((l) => l.kind === '5h') || sumEntry.limits[0];
    pools.push({
      id: n > 1 ? `${cat}-${n}` : cat,
      category: cat,
      kind: 'models',
      label: sumEntry.label,
      label_zh: sumEntry.label_zh,
      remaining_fraction: primary ? primary.remaining_fraction : null,
      reset_time: primary ? primary.reset_time : null,
      limits: sumEntry.limits,
      models: [],
      families: [],
      hidden_models: [],
    });
  }

  const last = (p) => (p.kind === 'tab' || (p.limits.length === 1 && p.limits[0].kind === 'none') ? 1 : 0);
  const minFrac = (p) => {
    const fracs = p.limits.map((l) => l.remaining_fraction).filter((f) => typeof f === 'number');
    return fracs.length ? Math.min(...fracs) : (p.remaining_fraction ?? Infinity);
  };
  pools.sort((a, b) => last(a) - last(b) || minFrac(a) - minFrac(b) || a.label.localeCompare(b.label));
  return {
    pools,
    weekly: summary.weekly,
    plan: findPlan(statusResp) ?? findPlan(modelsResp),
    tier: findTier(statusResp) ?? findTier(modelsResp),
  };
}

export const QUOTA_CYCLES_VERSION = 2;
export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const MAX_CYCLE_HORIZON_MS = 90 * 24 * 3600 * 1000;
export const MAX_CONSECUTIVE_CYCLE_MS = 35 * 24 * 3600 * 1000;
const RESET_MATCH_TOLERANCE_MS = 120 * 1000;
const MAX_CYCLES_PER_POOL = 52;
const MAX_OBS_PER_CYCLE = 128;
const CYCLE_START_SOURCES = new Set(['prev_reset', 'explicit', 'weekly_7d', 'unknown']);

function normalizePeakUnsaturated(peak, resetMs) {
  if (!peak || typeof peak !== 'object' || Array.isArray(peak)) return null;
  const pObsMs = Date.parse(peak.observed_at);
  const rawRem = Number(peak.remaining_fraction);
  if (!Number.isFinite(pObsMs) || !Number.isFinite(rawRem)) return null;
  const rem = Math.min(1, Math.max(0, rawRem));
  const used = roundN(1 - rem, 8);
  if (rem <= 0 || used < 0.01) return null;
  return {
    observed_at: new Date(Math.min(pObsMs, resetMs)).toISOString(),
    remaining_fraction: rem,
    used_fraction: used,
  };
}

export function normalizeObservations(rawObs, resetMs) {
  if (!Array.isArray(rawObs) || !Number.isFinite(resetMs)) return [];
  const valid = [];
  for (const item of rawObs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obsMs = Date.parse(item.observed_at);
    if (!Number.isFinite(obsMs)) continue;
    let rawRem = Number(item.remaining_fraction);
    if (!Number.isFinite(rawRem)) {
      const rawUsed = Number(item.used_fraction);
      if (!Number.isFinite(rawUsed)) continue;
      rawRem = 1 - rawUsed;
    }
    const effMs = Math.min(obsMs, resetMs);
    const rem = Math.min(1, Math.max(0, rawRem));
    const used = roundN(1 - rem, 8);
    valid.push({
      _ms: effMs,
      observed_at: new Date(effMs).toISOString(),
      remaining_fraction: rem,
      used_fraction: used,
    });
  }
  valid.sort((a, b) => a._ms - b._ms || a.used_fraction - b.used_fraction);
  const collapsed = [];
  for (const pt of valid) {
    const prev = collapsed[collapsed.length - 1];
    // Keep the earliest timestamp of each equal-remaining plateau so unreflected
    // trailing calls cannot leak into a delta evaluation window.
    if (prev && Math.abs(prev.remaining_fraction - pt.remaining_fraction) <= 1e-6) continue;
    collapsed.push(pt);
  }
  if (collapsed.length <= MAX_OBS_PER_CYCLE) {
    return collapsed.map(({ observed_at, remaining_fraction, used_fraction }) => ({
      observed_at, remaining_fraction, used_fraction,
    }));
  }
  const keep = new Set([0, collapsed.length - 1]);
  let minIdx = 0;
  let peakUnsatIdx = -1;
  let firstSatIdx = -1;
  for (let i = 0; i < collapsed.length; i += 1) {
    const pt = collapsed[i];
    if (pt.used_fraction < collapsed[minIdx].used_fraction) minIdx = i;
    if (pt.remaining_fraction > 0 && (peakUnsatIdx < 0 || pt.used_fraction > collapsed[peakUnsatIdx].used_fraction)) {
      peakUnsatIdx = i;
    }
    if (pt.remaining_fraction <= 0 && firstSatIdx < 0) firstSatIdx = i;
  }
  keep.add(minIdx);
  if (peakUnsatIdx >= 0) keep.add(peakUnsatIdx);
  if (firstSatIdx >= 0) keep.add(firstSatIdx);
  if (keep.size < MAX_OBS_PER_CYCLE) {
    const step = (collapsed.length - 1) / (MAX_OBS_PER_CYCLE - 1);
    for (let k = 0; k < MAX_OBS_PER_CYCLE && keep.size < MAX_OBS_PER_CYCLE; k += 1) {
      keep.add(Math.min(collapsed.length - 1, Math.round(k * step)));
    }
    for (let i = 0; i < collapsed.length && keep.size < MAX_OBS_PER_CYCLE; i += 1) keep.add(i);
  }
  return [...keep]
    .sort((a, b) => a - b)
    .map((idx) => {
      const { observed_at, remaining_fraction, used_fraction } = collapsed[idx];
      return { observed_at, remaining_fraction, used_fraction };
    });
}

function normalizeCycleEntry(raw, ledgerVersion = QUOTA_CYCLES_VERSION) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const resetMs = Date.parse(raw.reset_time);
  const rawRem = raw.remaining_fraction;
  if (!Number.isFinite(resetMs) || typeof rawRem !== 'number' || !Number.isFinite(rawRem)) return null;
  const rem = Math.min(1, Math.max(0, rawRem));
  const used = roundN(1 - rem, 8);
  const obsParsed = Date.parse(raw.observed_at);
  const obsMs = Number.isFinite(obsParsed) ? Math.min(obsParsed, resetMs) : resetMs;
  const firstParsed = Date.parse(raw.first_seen_at);
  const firstMs = Number.isFinite(firstParsed) ? Math.min(firstParsed, obsMs) : obsMs;
  const sat = Boolean(raw.saturated) || rem <= 0;
  const obsCount = Number.isInteger(raw.obs_count) && raw.obs_count > 0 ? raw.obs_count : 1;
  const peak = normalizePeakUnsaturated(raw.peak_unsaturated, resetMs);

  const startParsed = raw.cycle_start ? Date.parse(raw.cycle_start) : NaN;
  const rawSrc = typeof raw.cycle_start_source === 'string' && CYCLE_START_SOURCES.has(raw.cycle_start_source)
    ? raw.cycle_start_source
    : null;
  let cycleStart = null;
  let cycleStartSource = 'unknown';
  if ((rawSrc === 'prev_reset' || rawSrc === 'explicit' || rawSrc === 'weekly_7d') && Number.isFinite(startParsed) && startParsed < resetMs) {
    cycleStart = new Date(startParsed).toISOString();
    cycleStartSource = rawSrc;
  } else if (rawSrc === 'unknown' || !Number.isFinite(startParsed) || startParsed >= resetMs) {
    cycleStart = null;
    cycleStartSource = 'unknown';
  } else if (ledgerVersion === 1 && Math.abs((resetMs - startParsed) - WEEK_MS) <= 1000) {
    // Discard hardcoded v1 `reset_time - 7d` guesses; relinkPoolCycles recovers
    // exact boundaries whenever two consecutive resets exist.
    cycleStart = null;
    cycleStartSource = 'unknown';
  } else {
    cycleStart = new Date(startParsed).toISOString();
    cycleStartSource = 'explicit';
  }
  const endParsed = raw.ended_at ? Date.parse(raw.ended_at) : NaN;
  const endedAt = Number.isFinite(endParsed) && endParsed < resetMs && (!cycleStart || endParsed > Date.parse(cycleStart))
    ? new Date(endParsed).toISOString()
    : null;
  const cycleDurationMs = cycleStart
    ? Math.max(0, (endedAt ? Date.parse(endedAt) : resetMs) - Date.parse(cycleStart))
    : null;

  const obsSeed = Array.isArray(raw.observations) && raw.observations.length
    ? raw.observations
    : [
        ...(peak ? [{ observed_at: peak.observed_at, remaining_fraction: peak.remaining_fraction, used_fraction: peak.used_fraction }] : []),
        { observed_at: new Date(obsMs).toISOString(), remaining_fraction: rem, used_fraction: used },
      ];
  const observations = normalizeObservations(obsSeed, resetMs);

  return {
    cycle_start: cycleStart,
    cycle_start_source: cycleStartSource,
    cycle_duration_ms: cycleDurationMs,
    reset_time: new Date(resetMs).toISOString(),
    ended_at: endedAt,
    first_seen_at: new Date(firstMs).toISOString(),
    observed_at: new Date(obsMs).toISOString(),
    remaining_fraction: rem,
    used_fraction: used,
    saturated: sat,
    obs_count: obsCount,
    peak_unsaturated: peak,
    observations,
    plan: typeof raw.plan === 'string' && raw.plan ? raw.plan : null,
    tier: typeof raw.tier === 'string' && raw.tier ? raw.tier : null,
  };
}

function sortPoolCycles(list) {
  return list.slice().sort((a, b) => Date.parse(b.reset_time) - Date.parse(a.reset_time));
}

export function relinkPoolCycles(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const asc = list
    .map((c) => ({ ...c }))
    .sort((a, b) => Date.parse(a.reset_time) - Date.parse(b.reset_time));
  let refDurMs = null;
  for (let i = 1; i < asc.length; i += 1) {
    const prev = asc[i - 1];
    const cur = asc[i];
    const prevResetMs = Date.parse(prev.reset_time);
    const curResetMs = Date.parse(cur.reset_time);
    const curFirstMs = Date.parse(cur.first_seen_at);
    const durMs = curResetMs - prevResetMs;
    const gapSincePrevReset = curFirstMs - prevResetMs;
    const plausible = durMs > RESET_MATCH_TOLERANCE_MS
      && prevResetMs <= curFirstMs + RESET_MATCH_TOLERANCE_MS
      && durMs <= MAX_CONSECUTIVE_CYCLE_MS
      && (refDurMs === null || gapSincePrevReset <= Math.max(refDurMs * 1.5, 2 * 24 * 3600 * 1000));
    if (plausible) {
      if (cur.cycle_start_source !== 'explicit') {
        cur.cycle_start = prev.reset_time;
        cur.cycle_start_source = 'prev_reset';
        cur.cycle_duration_ms = durMs;
      }
      refDurMs = durMs;
    }
  }
  const hasNonWeeklyCadence = refDurMs !== null && Math.abs(refDurMs - WEEK_MS) > 3600_000;
  for (const cur of asc) {
    if (cur.cycle_start_source !== 'unknown' && cur.cycle_start_source !== 'weekly_7d') continue;
    const rMs = Date.parse(cur.reset_time);
    const fMs = Date.parse(cur.first_seen_at);
    if (!hasNonWeeklyCadence && rMs - WEEK_MS <= fMs + RESET_MATCH_TOLERANCE_MS) {
      cur.cycle_start = new Date(rMs - WEEK_MS).toISOString();
      cur.cycle_start_source = 'weekly_7d';
      cur.cycle_duration_ms = WEEK_MS;
    } else if (cur.cycle_start_source === 'weekly_7d') {
      cur.cycle_start = null;
      cur.cycle_start_source = 'unknown';
      cur.cycle_duration_ms = null;
    }
  }
  // Pass 3: truncate early-superseded cycles at the start of the replacement cycle.
  for (let i = 0; i < asc.length; i += 1) {
    const cur = asc[i];
    const curResetMs = Date.parse(cur.reset_time);
    const curStartMs = cur.cycle_start ? Date.parse(cur.cycle_start) : NaN;
    const curObsMs = Date.parse(cur.observed_at);
    if (i < asc.length - 1) {
      const next = asc[i + 1];
      const nextBoundaryMs = next.cycle_start ? Date.parse(next.cycle_start) : Date.parse(next.first_seen_at);
      if (
        Number.isFinite(nextBoundaryMs)
        && nextBoundaryMs < curResetMs - RESET_MATCH_TOLERANCE_MS
        && (!Number.isFinite(curStartMs) || nextBoundaryMs > curStartMs)
        && nextBoundaryMs >= curObsMs - RESET_MATCH_TOLERANCE_MS
      ) {
        cur.ended_at = new Date(nextBoundaryMs).toISOString();
        if (Number.isFinite(curStartMs)) cur.cycle_duration_ms = Math.max(0, nextBoundaryMs - curStartMs);
        continue;
      }
    }
    cur.ended_at = null;
    if (Number.isFinite(curStartMs)) cur.cycle_duration_ms = Math.max(0, curResetMs - curStartMs);
  }
  return sortPoolCycles(asc).slice(0, MAX_CYCLES_PER_POOL);
}

export function normalizeQuotaCycles(raw) {
  const out = { version: QUOTA_CYCLES_VERSION, pools: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const ledgerVersion = Number.isFinite(raw.version) ? raw.version : QUOTA_CYCLES_VERSION;
  const poolsSrc = raw.pools && typeof raw.pools === 'object' && !Array.isArray(raw.pools) ? raw.pools : null;
  if (!poolsSrc) return out;
  for (const [pool, list] of Object.entries(poolsSrc)) {
    if (!Array.isArray(list)) continue;
    const deduped = [];
    for (const item of list) {
      const e = normalizeCycleEntry(item, ledgerVersion);
      if (!e) continue;
      const rMs = Date.parse(e.reset_time);
      const dup = deduped.find((x) => Math.abs(Date.parse(x.reset_time) - rMs) <= RESET_MATCH_TOLERANCE_MS);
      if (!dup) deduped.push(e);
    }
    if (deduped.length) out.pools[pool] = relinkPoolCycles(deduped);
  }
  return out;
}

/**
 * Merges a live /api/quota (or quota-raw bootstrap) snapshot into the persistent
 * per-cycle ledger. Cycle boundaries are derived dynamically from consecutive
 * reset timestamps (`reset_time_curr - reset_time_prev`) rather than assuming
 * a fixed 7-day window, while recording monotonic observation checkpoints inside
 * each cycle so in-cycle delta valuation works before two resets are observed.
 */
export function mergeQuotaObservation(ledger, quotaResult) {
  const next = normalizeQuotaCycles(ledger);
  if (!quotaResult || typeof quotaResult !== 'object' || quotaResult.error || !quotaResult.weekly || typeof quotaResult.weekly !== 'object') {
    return { ledger: next, changed: false };
  }
  const fetchedParsed = Date.parse(quotaResult.fetched_at);
  const fetchedMs = Number.isFinite(fetchedParsed) ? fetchedParsed : Date.now();
  const plan = typeof quotaResult.plan === 'string' && quotaResult.plan ? quotaResult.plan : null;
  const tier = typeof quotaResult.tier === 'string' && quotaResult.tier ? quotaResult.tier : null;
  let changed = false;

  for (const [pool, w] of Object.entries(quotaResult.weekly)) {
    if (!w || typeof w !== 'object') continue;
    if (typeof w.remaining_fraction !== 'number' || !Number.isFinite(w.remaining_fraction)) continue;
    const resetMs = typeof w.reset_time === 'string' ? Date.parse(w.reset_time) : NaN;
    if (!Number.isFinite(resetMs)) continue;
    if (resetMs < fetchedMs - 60_000 || resetMs > fetchedMs + MAX_CYCLE_HORIZON_MS) continue;

    const effObsMs = Math.min(fetchedMs, resetMs);
    const effObsIso = new Date(effObsMs).toISOString();
    const resetIso = new Date(resetMs).toISOString();
    const rem = Math.min(1, Math.max(0, w.remaining_fraction));
    const used = roundN(1 - rem, 8);
    const sat = rem <= 0;

    const list = next.pools[pool] ? next.pools[pool] : (next.pools[pool] = []);
    const ex = list.find((c) => Math.abs(Date.parse(c.reset_time) - resetMs) <= RESET_MATCH_TOLERANCE_MS);

    if (!ex) {
      list.push({
        cycle_start: null,
        cycle_start_source: 'unknown',
        cycle_duration_ms: null,
        reset_time: resetIso,
        ended_at: null,
        first_seen_at: effObsIso,
        observed_at: effObsIso,
        remaining_fraction: rem,
        used_fraction: used,
        saturated: sat,
        obs_count: 1,
        peak_unsaturated: (!sat && used >= 0.01) ? { observed_at: effObsIso, remaining_fraction: rem, used_fraction: used } : null,
        observations: [{ observed_at: effObsIso, remaining_fraction: rem, used_fraction: used }],
        plan,
        tier,
      });
      next.pools[pool] = relinkPoolCycles(list);
      changed = true;
      continue;
    }

    let needRelink = false;
    if (effObsMs < Date.parse(ex.first_seen_at)) {
      ex.first_seen_at = effObsIso;
      needRelink = true;
      changed = true;
    }

    const prevObsList = JSON.stringify(ex.observations || []);
    ex.observations = normalizeObservations([
      ...(ex.observations || []),
      { observed_at: effObsIso, remaining_fraction: rem, used_fraction: used },
    ], resetMs);
    if (JSON.stringify(ex.observations) !== prevObsList) {
      changed = true;
    }

    const prevObsMs = Date.parse(ex.observed_at);
    if (!sat) {
      if (effObsMs >= prevObsMs) {
        const fracChanged = Math.abs(ex.remaining_fraction - rem) > 1e-8;
        const resetChanged = ex.reset_time !== resetIso;
        const metaChanged = ex.saturated !== false || (plan && ex.plan !== plan) || (tier && ex.tier !== tier);
        if (fracChanged || resetChanged || metaChanged) {
          if (resetChanged) {
            ex.reset_time = resetIso;
            if (ex.cycle_start && ex.cycle_start_source !== 'unknown') {
              ex.cycle_duration_ms = Math.max(0, resetMs - Date.parse(ex.cycle_start));
            }
            needRelink = true;
          }
          if (fracChanged) {
            ex.observed_at = effObsIso;
            ex.remaining_fraction = rem;
            ex.used_fraction = used;
            ex.obs_count += 1;
          }
          ex.saturated = false;
          if (used >= 0.01 && (!ex.peak_unsaturated || used > ex.peak_unsaturated.used_fraction)) {
            ex.peak_unsaturated = { observed_at: effObsIso, remaining_fraction: rem, used_fraction: used };
          }
          if (plan) ex.plan = plan;
          if (tier) ex.tier = tier;
          changed = true;
        }
      }
    } else if (!ex.saturated) {
      if (ex.reset_time !== resetIso) {
        ex.reset_time = resetIso;
        if (ex.cycle_start && ex.cycle_start_source !== 'unknown') {
          ex.cycle_duration_ms = Math.max(0, resetMs - Date.parse(ex.cycle_start));
        }
        needRelink = true;
      }
      ex.observed_at = effObsIso;
      ex.remaining_fraction = 0;
      ex.used_fraction = 1;
      ex.saturated = true;
      ex.obs_count += 1;
      if (plan) ex.plan = plan;
      if (tier) ex.tier = tier;
      changed = true;
    } else if (effObsMs < prevObsMs) {
      // Tighten saturation lock if an earlier zero-remaining observation arrives.
      ex.observed_at = effObsIso;
      changed = true;
    }

    if (needRelink) {
      next.pools[pool] = relinkPoolCycles(list);
    }
  }

  return { ledger: next, changed };
}

function quotaObservationFromRawFile(quotaRawPath) {
  if (!quotaRawPath || !existsSync(quotaRawPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(quotaRawPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.RetrieveUserQuotaSummary) return null;
    const fetchedMs = Date.parse(raw.written_at);
    const now = Number.isFinite(fetchedMs) ? fetchedMs : Date.now();
    const { weekly } = parseQuotaSummary(raw.RetrieveUserQuotaSummary, now);
    if (!weekly || !Object.keys(weekly).length) return null;
    return {
      weekly,
      fetched_at: new Date(now).toISOString(),
      plan: findPlan(raw.GetUserStatus) ?? findPlan(raw.GetAvailableModels),
      tier: findTier(raw.GetUserStatus) ?? findTier(raw.GetAvailableModels),
    };
  } catch {
    return null;
  }
}

export function loadQuotaCycles(quotaCyclesPath, quotaRawPath = null) {
  let ledger = normalizeQuotaCycles(null);
  let loadedFromFile = false;
  if (quotaCyclesPath && existsSync(quotaCyclesPath)) {
    try {
      ledger = normalizeQuotaCycles(JSON.parse(readFileSync(quotaCyclesPath, 'utf8')));
      loadedFromFile = true;
    } catch {
      ledger = normalizeQuotaCycles(null);
    }
  }
  const hasAny = Object.values(ledger.pools).some((arr) => Array.isArray(arr) && arr.length > 0);
  if (!hasAny && !loadedFromFile && quotaRawPath) {
    const seeded = quotaObservationFromRawFile(quotaRawPath);
    if (seeded) {
      const merged = mergeQuotaObservation(ledger, seeded);
      ledger = merged.ledger;
      if (merged.changed && quotaCyclesPath) {
        try {
          writeJsonAtomic(quotaCyclesPath, ledger);
        } catch { /* ignore */ }
      }
    }
  }
  return ledger;
}

export function recordQuotaCycles(quotaCyclesPath, quotaResult) {
  const current = loadQuotaCycles(quotaCyclesPath, null);
  const { ledger, changed } = mergeQuotaObservation(current, quotaResult);
  if (changed && quotaCyclesPath) {
    try {
      writeJsonAtomic(quotaCyclesPath, ledger);
    } catch (err) {
      console.error('[agy-lens] could not write quota-cycles.json:', err.message);
    }
  }
  return ledger;
}

const quotaRawState = new Map(); // quotaRawPath -> { written, hasSummary }

function shouldWriteQuotaRaw(quotaRawPath, hasSummary, forceRaw = false) {
  const st = quotaRawState.get(quotaRawPath);
  if (!st || !st.written || forceRaw || !existsSync(quotaRawPath)) return true;
  if (hasSummary && !st.hasSummary) return true;
  return false;
}

export async function fetchQuota(optsOrForceRaw = {}) {
  const opts = typeof optsOrForceRaw === 'boolean' ? { forceRaw: optsOrForceRaw } : (optsOrForceRaw || {});
  const forceRaw = Boolean(opts.forceRaw);
  const catalogPath = opts.catalogPath === undefined ? join(defaultDataDir(), 'model-catalog.json') : opts.catalogPath;
  const quotaRawPath = opts.quotaRawPath === undefined ? join(defaultDataDir(), 'quota-raw.json') : opts.quotaRawPath;
  const quotaCyclesPath = opts.quotaCyclesPath === undefined ? join(defaultDataDir(), 'quota-cycles.json') : opts.quotaCyclesPath;
  const onCatalogWritten = typeof opts.onCatalogWritten === 'function' ? opts.onCatalogWritten : null;

  const fetched_at = new Date().toISOString();
  const body = { metadata: LS_METADATA };
  const [status, models, summary] = await Promise.allSettled([
    lsRequest('GetUserStatus', body),
    lsRequest('GetAvailableModels', body),
    lsRequest('RetrieveUserQuotaSummary', body),
  ]);
  const statusResp = status.status === 'fulfilled' ? status.value : null;
  const modelsResp = models.status === 'fulfilled' ? models.value : null;
  const summaryResp = summary.status === 'fulfilled' ? summary.value : null;
  if (!statusResp && !modelsResp && !summaryResp) {
    const reason = status.reason || models.reason || summary.reason;
    const noLs = status.reason?.code === 'NO_LS';
    return { pools: [], weekly: {}, plan: null, tier: null, fetched_at, error: noLs ? 'unavailable' : 'failed', message: reason?.message || 'request failed' };
  }
  const parsed = parseQuota(statusResp, modelsResp, Date.now(), summaryResp);
  const poolOverrides = new Map();
  for (const pool of parsed.pools) {
    if (!pool || pool.kind === 'tab' || !pool.category || pool.category === 'tab') continue;
    for (const m of [...(pool.models || []), ...(pool.hidden_models || [])]) {
      if (m && m.id && !poolOverrides.has(m.id)) {
        poolOverrides.set(m.id, pool.category);
      }
    }
  }
  if ((modelsResp || statusResp) && catalogPath) {
    const written = writeModelCatalog(catalogPath, modelsResp, statusResp, poolOverrides);
    if (written && onCatalogWritten) onCatalogWritten();
  }
  if (quotaRawPath && shouldWriteQuotaRaw(quotaRawPath, !!summaryResp, forceRaw)) {
    const st = quotaRawState.get(quotaRawPath) || { written: false, hasSummary: false };
    st.written = true;
    if (summaryResp) st.hasSummary = true;
    quotaRawState.set(quotaRawPath, st);
    try {
      writeJsonAtomic(quotaRawPath, redact({
        written_at: fetched_at,
        GetUserStatus: statusResp ?? { error: status.reason?.message },
        GetAvailableModels: modelsResp ?? { error: models.reason?.message },
        RetrieveUserQuotaSummary: summaryResp ?? { error: summary.reason?.message },
      }));
    } catch (err) {
      console.error('[agy-lens] could not write quota-raw.json:', err.message);
    }
  }
  const result = { ...parsed, fetched_at };
  if (!parsed.pools.length) {
    result.error = 'unavailable';
    result.message = 'The language server did not report any model quota.';
  } else if (quotaCyclesPath && result.weekly && Object.keys(result.weekly).length > 0) {
    recordQuotaCycles(quotaCyclesPath, result);
  }
  return result;
}
