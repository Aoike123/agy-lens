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
  other: ['Other models', '其他模型'],
};

// The LS reports no window length, so the limit kind is inferred from the
// time left until reset (a rolling 5-hour window never resets later than 5h
// from now).
export function inferLimit(remaining_fraction, reset_time, now = Date.now()) {
  let kind = 'unknown';
  if (!reset_time) {
    if (remaining_fraction === 1) kind = 'none';
  } else {
    const dt = Date.parse(reset_time) - now;
    if (dt >= 0 && dt <= 5 * HOUR + SLACK) kind = '5h';
    else if (dt > 0 && dt <= 24 * HOUR + SLACK) kind = 'daily';
    else if (dt > 0 && dt <= 7 * 24 * HOUR + SLACK) kind = 'weekly';
  }
  const [label, label_zh] = LIMIT_LABELS[kind];
  return { kind, inferred: kind !== 'unknown', label, label_zh, remaining_fraction, reset_time };
}

function summaryCategory(bucketId, groupName) {
  for (const raw of [bucketId, groupName]) {
    const text = String(raw || '').toLowerCase();
    if (!text) continue;
    if (/gemini|google/.test(text)) return 'gemini';
    if (/(?:^|[^a-z0-9])3p(?:$|[^a-z0-9])|claude|gpt|third/.test(text)) return 'claude_gpt';
  }
  return 'other';
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
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const gName = pick(g, 'displayName', 'display_name', 'name', 'groupId', 'group_id', 'id');
      const bs = pick(g, 'buckets', 'quotaBuckets', 'quota_buckets');
      if (Array.isArray(bs)) {
        for (const b of bs) bucketPairs.push([b, gName ? String(gName) : '']);
      }
    }
  }
  if (Array.isArray(topBuckets)) {
    for (const b of topBuckets) bucketPairs.push([b, '']);
  }

  for (const [b, groupName] of bucketPairs) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const bucketId = pick(b, 'bucketId', 'bucket_id', 'id');
    const displayName = pick(b, 'displayName', 'display_name', 'label', 'name');
    const windowVal = pick(b, 'window', 'windowType', 'window_type');
    const q = pick(b, 'quotaInfo', 'quota_info', 'quota') || b;
    const reset = toIso(pick(q, 'resetTime', 'reset_time', 'resetAt'));
    let frac = toFraction(pick(q, 'remainingFraction', 'remaining_fraction', 'fractionRemaining'));
    if (frac === null && reset) frac = 0;
    if (frac === null && !reset) continue;

    let category = summaryCategory(bucketId, groupName || displayName);
    if (category === 'other' && groupName) {
      const existingOther = byCategory.other;
      if (existingOther && existingOther.label.toLowerCase() !== String(groupName).toLowerCase()) {
        const customSlug = String(groupName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'group';
        category = `custom_${customSlug}`;
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
      const [defEn, defZh] = SUMMARY_POOL_LABELS[category] || SUMMARY_POOL_LABELS.other;
      const isCustom = category === 'other' || category.startsWith('custom_');
      const label = isCustom && groupName ? groupName : defEn;
      const label_zh = isCustom && groupName ? groupName : defZh;
      byCategory[category] = { category, label, label_zh, limits: [] };
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
      const provs = new Set((shown.length ? shown : members).map(providerName).filter(Boolean));
      const names = [...provs].sort((a, b) => provRank(a) - provRank(b) || a.localeCompare(b));
      if (names.length) {
        label = `${names.join(' / ')} models`;
        label_zh = `${names.join(' / ')} 模型`;
        if (names.length === 1 && names[0] === 'Gemini') slug = 'gemini';
        else if (names.every((x) => x === 'Claude' || x === 'GPT-OSS' || x === 'OpenAI')) slug = 'claude_gpt';
        else slug = names.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '');
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
  const summary = parseQuotaSummary(summaryResp, now);
  const matchedSummaryCats = new Set();
  const summaryTargets = new Map();
  for (const pool of pools) {
    const sumEntry = summary.byCategory[pool.category];
    if (!sumEntry || pool.kind === 'tab') continue;
    if (!pool.limits.some((l) => l.kind !== 'none')) continue;
    const prev = summaryTargets.get(pool.category);
    if (!prev) {
      summaryTargets.set(pool.category, pool);
    } else {
      const prevMatches = prev.limits.some((pl) => sumEntry.limits.some((sl) => sl.kind === pl.kind && sl.remaining_fraction === pl.remaining_fraction));
      const curMatches = pool.limits.some((pl) => sumEntry.limits.some((sl) => sl.kind === pl.kind && sl.remaining_fraction === pl.remaining_fraction));
      if (!prevMatches && curMatches) summaryTargets.set(pool.category, pool);
    }
  }
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

export const QUOTA_CYCLES_VERSION = 1;
export const WEEK_MS = 7 * 24 * 3600 * 1000;
const RESET_MATCH_TOLERANCE_MS = 120 * 1000;
const MAX_CYCLES_PER_POOL = 52;

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

function normalizeCycleEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const resetMs = Date.parse(raw.reset_time);
  const rawRem = raw.remaining_fraction;
  if (!Number.isFinite(resetMs) || typeof rawRem !== 'number' || !Number.isFinite(rawRem)) return null;
  const startParsed = Date.parse(raw.cycle_start);
  const startMs = Number.isFinite(startParsed) ? startParsed : resetMs - WEEK_MS;
  const rem = Math.min(1, Math.max(0, rawRem));
  const used = roundN(1 - rem, 8);
  const obsParsed = Date.parse(raw.observed_at);
  const obsMs = Number.isFinite(obsParsed) ? Math.min(obsParsed, resetMs) : resetMs;
  const firstParsed = Date.parse(raw.first_seen_at);
  const firstMs = Number.isFinite(firstParsed) ? Math.min(firstParsed, obsMs) : obsMs;
  const sat = Boolean(raw.saturated) || rem <= 0;
  const obsCount = Number.isInteger(raw.obs_count) && raw.obs_count > 0 ? raw.obs_count : 1;
  return {
    cycle_start: new Date(startMs).toISOString(),
    reset_time: new Date(resetMs).toISOString(),
    first_seen_at: new Date(firstMs).toISOString(),
    observed_at: new Date(obsMs).toISOString(),
    remaining_fraction: rem,
    used_fraction: used,
    saturated: sat,
    obs_count: obsCount,
    peak_unsaturated: normalizePeakUnsaturated(raw.peak_unsaturated, resetMs),
    plan: typeof raw.plan === 'string' && raw.plan ? raw.plan : null,
    tier: typeof raw.tier === 'string' && raw.tier ? raw.tier : null,
  };
}

function sortPoolCycles(list) {
  return list.slice().sort((a, b) => Date.parse(b.reset_time) - Date.parse(a.reset_time));
}

export function normalizeQuotaCycles(raw) {
  const out = { version: QUOTA_CYCLES_VERSION, pools: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const poolsSrc = raw.pools && typeof raw.pools === 'object' && !Array.isArray(raw.pools) ? raw.pools : null;
  if (!poolsSrc) return out;
  for (const [pool, list] of Object.entries(poolsSrc)) {
    if (!Array.isArray(list)) continue;
    const deduped = [];
    for (const item of list) {
      const e = normalizeCycleEntry(item);
      if (!e) continue;
      const rMs = Date.parse(e.reset_time);
      const dup = deduped.find((x) => Math.abs(Date.parse(x.reset_time) - rMs) <= RESET_MATCH_TOLERANCE_MS);
      if (!dup) deduped.push(e);
    }
    if (deduped.length) out.pools[pool] = sortPoolCycles(deduped).slice(0, MAX_CYCLES_PER_POOL);
  }
  return out;
}

/**
 * Merges a live /api/quota (or quota-raw bootstrap) snapshot into the persistent
 * per-cycle ledger. Locks `observed_at` when a pool first saturates (0% left)
 * and preserves `peak_unsaturated` so subsequent AI-credit spend after limit
 * saturation cannot inflate the implied 100% weekly quota dollar value.
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
    const startMs = resetMs - WEEK_MS;
    if (startMs > fetchedMs + 60_000 || resetMs < fetchedMs - 60_000) continue;

    const effObsMs = Math.min(fetchedMs, resetMs);
    const effObsIso = new Date(effObsMs).toISOString();
    const startIso = new Date(startMs).toISOString();
    const resetIso = new Date(resetMs).toISOString();
    const rem = Math.min(1, Math.max(0, w.remaining_fraction));
    const used = roundN(1 - rem, 8);
    const sat = rem <= 0;

    const list = next.pools[pool] ? next.pools[pool] : (next.pools[pool] = []);
    const ex = list.find((c) => Math.abs(Date.parse(c.reset_time) - resetMs) <= RESET_MATCH_TOLERANCE_MS);

    if (!ex) {
      list.push({
        cycle_start: startIso,
        reset_time: resetIso,
        first_seen_at: effObsIso,
        observed_at: effObsIso,
        remaining_fraction: rem,
        used_fraction: used,
        saturated: sat,
        obs_count: 1,
        peak_unsaturated: (!sat && used >= 0.01) ? { observed_at: effObsIso, remaining_fraction: rem, used_fraction: used } : null,
        plan,
        tier,
      });
      next.pools[pool] = sortPoolCycles(list).slice(0, MAX_CYCLES_PER_POOL);
      changed = true;
      continue;
    }

    if (effObsMs < Date.parse(ex.first_seen_at)) {
      ex.first_seen_at = effObsIso;
      changed = true;
    }

    const prevObsMs = Date.parse(ex.observed_at);
    if (!sat) {
      if (effObsMs >= prevObsMs) {
        const diff = ex.observed_at !== effObsIso
          || ex.remaining_fraction !== rem
          || ex.reset_time !== resetIso
          || ex.cycle_start !== startIso
          || ex.saturated !== false
          || (plan && ex.plan !== plan)
          || (tier && ex.tier !== tier);
        if (diff) {
          ex.cycle_start = startIso;
          ex.reset_time = resetIso;
          ex.observed_at = effObsIso;
          ex.remaining_fraction = rem;
          ex.used_fraction = used;
          ex.saturated = false;
          ex.obs_count += 1;
          if (used >= 0.01 && (!ex.peak_unsaturated || used > ex.peak_unsaturated.used_fraction)) {
            ex.peak_unsaturated = { observed_at: effObsIso, remaining_fraction: rem, used_fraction: used };
          }
          if (plan) ex.plan = plan;
          if (tier) ex.tier = tier;
          changed = true;
        }
      }
    } else if (!ex.saturated) {
      ex.cycle_start = startIso;
      ex.reset_time = resetIso;
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
  if ((modelsResp || statusResp) && catalogPath) {
    const written = writeModelCatalog(catalogPath, modelsResp, statusResp);
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
  const parsed = parseQuota(statusResp, modelsResp, Date.now(), summaryResp);
  const result = { ...parsed, fetched_at };
  if (!parsed.pools.length) {
    result.error = 'unavailable';
    result.message = 'The language server did not report any model quota.';
  } else if (quotaCyclesPath && result.weekly && Object.keys(result.weekly).length > 0) {
    recordQuotaCycles(quotaCyclesPath, result);
  }
  return result;
}
