// Live model catalog builder/reader, pool classifier, native context window
// defaults, and model display formatting. Pure ESM, zero external dependencies.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir, expandHome, writeJsonAtomic } from './pb.mjs';

export const POOLS = ['gemini', 'claude_gpt', 'other'];

export const NATIVE_CONTEXT_WINDOWS = [
  ['claude-opus-4-6', 250_000],
  ['claude-sonnet-4-6', 250_000],
  ['claude-', 1_000_000],
  ['gpt-oss-', 131_072],
  ['gemini-', 1_048_576],
];

export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const WORD_LABELS = { gpt: 'GPT', oss: 'OSS' };

export const PROVIDER_ORDER = ['Gemini', 'Claude', 'GPT-OSS', 'OpenAI'];
export const PROVIDER_LABELS = {
  ANTHROPIC: 'Claude',
  GOOGLE: 'Gemini',
  OPENAI: 'OpenAI',
  DEEPSEEK: 'DeepSeek',
  MISTRAL: 'Mistral',
  META: 'Meta',
  XAI: 'xAI',
  COHERE: 'Cohere',
};

// --- LS payload field accessors --------------------------------------------

export function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

export function asList(container) {
  if (Array.isArray(container)) return container.map((m) => [undefined, m]);
  if (container && typeof container === 'object') return Object.entries(container);
  return [];
}

export function rootOf(resp) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return null;
  return resp.response && typeof resp.response === 'object' ? resp.response : resp;
}

export function statusOf(resp) {
  const root = rootOf(resp);
  return root ? (pick(root, 'userStatus', 'user_status') || root) : null;
}

export function modelConfigData(resp) {
  return pick(statusOf(resp), 'cascadeModelConfigData', 'cascade_model_config_data');
}

// --- provider & pool classification -----------------------------------------

export function providerName(m) {
  const p = String(m?.provider || '').toUpperCase();
  const text = `${m?.id || ''} ${m?.display_name || ''}`.toLowerCase();
  if (p.includes('ANTHROPIC') || /claude/.test(text)) return 'Claude';
  if (/gpt-oss|gpt_oss/.test(text)) return 'GPT-OSS';
  if (p.includes('OPENAI') || /\bgpt/.test(text)) return 'OpenAI';
  if (p.includes('GOOGLE') || /gemini/.test(text)) return 'Gemini';
  const pm = p.match(/^MODEL_PROVIDER_([A-Z0-9_]+)$/);
  if (pm && !/^(UNSPECIFIED|UNKNOWN|CUSTOM|INTERNAL)$/.test(pm[1])) {
    return PROVIDER_LABELS[pm[1]] || pm[1].split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

export function isTabModel(m) {
  return /^tab[_-]/i.test(m.id);
}

export function modelQuotaBucket(m) {
  if (isTabModel(m)) return 'tab';
  const prov = providerName(m);
  if (prov === 'Gemini') return 'gemini';
  if (prov === 'Claude' || prov === 'GPT-OSS' || prov === 'OpenAI') return 'claude_gpt';
  if (prov) return `p:${prov.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  return 'other';
}

export function modelCatalogPool(m) {
  const b = modelQuotaBucket(m);
  return b === 'gemini' || b === 'claude_gpt' ? b : 'other';
}

// --- live model catalog -----------------------------------------------------

export function buildModelCatalog(modelsResp, statusResp = null) {
  const catalog = {};
  const root = rootOf(modelsResp);
  for (const [id, m] of asList(root?.models)) {
    if (!id || !m || typeof m !== 'object') continue;
    const displayName = String(pick(m, 'displayName', 'display_name') || '');
    const provider = String(pick(m, 'modelProvider', 'model_provider') || '');
    const maxTokens = Number(pick(m, 'maxTokens', 'max_tokens')) || 0;
    const pool = modelCatalogPool({ id, display_name: displayName, provider });
    catalog[id] = { maxTokens, displayName, provider, pool };
  }
  for (const [, c] of asList(pick(modelConfigData(statusResp), 'clientModelConfigs', 'client_model_configs'))) {
    if (!c || typeof c !== 'object') continue;
    const id = pick(c, 'modelId', 'model_id');
    if (typeof id !== 'string' || !id) continue;
    const displayName = String(pick(c, 'label', 'displayName', 'display_name') || '');
    const prev = catalog[id];
    if (!prev) {
      const pool = modelCatalogPool({ id, display_name: displayName, provider: '' });
      catalog[id] = { maxTokens: 0, displayName, provider: '', pool };
    } else if (!prev.displayName && displayName) {
      prev.displayName = displayName;
      prev.pool = modelCatalogPool({ id, display_name: prev.displayName, provider: prev.provider });
    }
  }
  return catalog;
}

export function writeModelCatalog(catalogPathOrModelsResp, modelsRespOrStatusResp = null, statusRespMaybe = null) {
  let catalogPath;
  let modelsResp;
  let statusResp;
  if (typeof catalogPathOrModelsResp === 'string') {
    catalogPath = catalogPathOrModelsResp;
    modelsResp = modelsRespOrStatusResp;
    statusResp = statusRespMaybe;
  } else {
    catalogPath = join(defaultDataDir(), 'model-catalog.json');
    modelsResp = catalogPathOrModelsResp;
    statusResp = modelsRespOrStatusResp;
  }
  try {
    const catalog = buildModelCatalog(modelsResp, statusResp);
    if (Object.keys(catalog).length) {
      writeJsonAtomic(catalogPath, catalog);
      return catalog;
    }
  } catch (err) {
    console.error('[agy-lens] could not write model-catalog.json:', err.message);
  }
  return null;
}

export function loadModelCatalog(filePath) {
  if (!filePath) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(expandHome(filePath), 'utf8'));
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = Object.create(null);
  for (const [k, v] of Object.entries(data)) {
    if (typeof k === 'string' && k && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v;
    }
  }
  return out;
}

export function catalogEntry(id, catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  const raw = String(id || '').trim();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(catalog, raw)) return catalog[raw];
  const low = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(catalog, low)) return catalog[low];
  for (const [k, v] of Object.entries(catalog)) {
    if (k.toLowerCase() === low) return v;
  }
  return null;
}

export function catalogDisplay(id, catalog) {
  const e = catalogEntry(id, catalog);
  const d = e && typeof e.displayName === 'string' ? e.displayName.trim() : '';
  return d || null;
}

export function modelPool(id, catalog = null) {
  const entry = catalogEntry(id, catalog);
  if (entry && typeof entry === 'object') {
    if (typeof entry.pool === 'string' && POOLS.includes(entry.pool) && (entry.pool !== 'other' || entry.provider)) {
      return entry.pool;
    }
    if (typeof entry.provider === 'string' && entry.provider) {
      const p = entry.provider.toUpperCase();
      if (p.includes('ANTHROPIC') || p.includes('OPENAI')) return 'claude_gpt';
      if (p.includes('GOOGLE')) return 'gemini';
    }
  }
  const s = String(id || '').trim().toLowerCase();
  if (!s || s === 'unknown' || s.startsWith('tab_')) return 'other';
  if (s.includes('claude') || s.includes('anthropic') || s.includes('gpt') || s.includes('openai')) return 'claude_gpt';
  if (s.includes('gemini') || s.includes('orchestrator')) return 'gemini';
  return 'other';
}

// --- generation protobuf model/limit helpers --------------------------------

export function modelId(gen) {
  const planner = gen !== null ? gen.msg(3) : null;
  return planner !== null ? planner.str(28) : '';
}

export function modelLabel(slug) {
  const parts = String(slug || '').split('-');
  let effort = '';
  if (parts.length > 1 && EFFORT_LEVELS.includes(parts[parts.length - 1])) {
    const last = parts.pop();
    effort = last.charAt(0).toUpperCase() + last.slice(1);
  }
  const words = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && words.length && /\d$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${p}`;
    } else if (Object.prototype.hasOwnProperty.call(WORD_LABELS, p)) {
      words.push(WORD_LABELS[p]);
    } else if (p.length > 0 && p[0] >= '0' && p[0] <= '9') {
      words.push(p.toUpperCase());
    } else {
      words.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  const label = words.join(' ').replace('GPT OSS', 'GPT-OSS');
  return effort ? `${label} (${effort})` : label;
}

export function modelName(gen) {
  const chat = gen !== null ? gen.msg(1) : null;
  if (chat !== null && chat.str(21)) return chat.str(21);
  const mid = modelId(gen);
  if (mid) return modelLabel(mid);
  if (chat !== null && chat.str(19)) return chat.str(19);
  return 'Unknown Model';
}

export function requestBudget(gen) {
  const chat = gen !== null ? gen.msg(1) : null;
  const start = chat !== null ? chat.msg(9) : null;
  const cwm = start !== null ? start.msg(10) : null;
  return cwm !== null ? cwm.int(4, true) : 0;
}

export function contextLimit(gen) {
  const slug = modelId(gen);
  for (const [prefix, tokens] of NATIVE_CONTEXT_WINDOWS) {
    if (slug.startsWith(prefix)) return tokens;
  }
  return requestBudget(gen);
}
