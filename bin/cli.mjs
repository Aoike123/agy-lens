#!/usr/bin/env node
/**
 * Agy Lens (`agy-lens`) — Zero-dependency terminal summary CLI for Antigravity 2.0.
 * Reuses sidecars/agy-lens/lib/*.mjs directly on Node.js 24+.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  catalogEntry,
  contextLimit,
  loadModelCatalog,
  modelId,
  modelLabel,
  modelName,
} from '../sidecars/agy-lens/lib/catalog.mjs';
import {
  buildReport,
  collectStats,
  defaultConversationsDir,
  detectSystemFiles,
  findLatestDb,
  fmtTok,
  load,
  render,
  workspacePath,
} from '../sidecars/agy-lens/lib/context.mjs';
import {
  defaultRoots,
  findLegacyHistoryCaches,
  findSubagentSources,
  scan,
} from '../sidecars/agy-lens/lib/history.mjs';
import {
  defaultDataDir,
  defaultGeminiDir,
  expandHome,
  hasNodeSqlite,
  roundN,
} from '../sidecars/agy-lens/lib/pb.mjs';
import { readPricingMeta } from '../sidecars/agy-lens/lib/pricing.mjs';
import { fetchQuota, loadQuotaCycles, mergeQuotaObservation } from '../sidecars/agy-lens/lib/quota.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export function readVersion() {
  for (const rel of ['package.json', 'plugin.json', join('sidecars', 'agy-lens', 'package.json')]) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data?.version) return String(data.version).replace(/^v/, '');
    } catch {
      // try next manifest
    }
  }
  return '0.0.0';
}

function helpText(version) {
  return [
    `Agy Lens (agy-lens) v${version}`,
    'Local context window, tok/s speed, quota, and token spend CLI for Antigravity 2.0.',
    '',
    'Usage:',
    '  agy-lens [options]',
    '',
    'Options:',
    '  --help, -h            Show this help message and exit',
    '  --version, -v         Show CLI version and exit',
    '  --json                Emit machine-readable JSON with zero ANSI codes',
    '  --days <N>            History aggregation window in days (default: 365)',
    '  --db <path>           Inspect a specific conversation SQLite database',
    '  --workspace <uri>     Workspace path or file:// URI for .agents/ detection',
    '  --no-color            Disable ANSI color output (also honors NO_COLOR)',
    '',
    'Environment:',
    '  ANTIGRAVITY_GEMINI_DIR           Override ~/.gemini directory',
    '  ANTIGRAVITY_EXECUTABLE_DATA_DIR  Override cache/catalog data directory',
    '  NO_COLOR                         Disable ANSI colors when non-empty',
  ].join('\n');
}

export function parseArgs(argv) {
  const args = {
    help: false,
    version: false,
    json: false,
    noColor: false,
    days: 365,
    db: null,
    workspace: null,
  };

  const readOptValue = (flag, inlineVal, index) => {
    if (inlineVal !== null) {
      if (!inlineVal.length) throw new Error(`Missing value for ${flag}`);
      return { value: inlineVal, nextIndex: index };
    }
    if (index + 1 >= argv.length) {
      throw new Error(`Missing value for ${flag}`);
    }
    const next = argv[index + 1];
    if (!String(next).length) throw new Error(`Missing value for ${flag}`);
    return { value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i]);
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    if (raw === '--version' || raw === '-v') {
      args.version = true;
      continue;
    }
    if (raw === '--json') {
      args.json = true;
      continue;
    }
    if (raw === '--no-color') {
      args.noColor = true;
      continue;
    }

    const eqIdx = raw.indexOf('=');
    const flag = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx >= 0 ? raw.slice(eqIdx + 1) : null;

    if (flag === '--days') {
      const { value, nextIndex } = readOptValue('--days', inlineVal, i);
      if (!/^[1-9]\d*$/.test(value)) {
        throw new Error(`Invalid value for --days: "${value}" (expected positive integer)`);
      }
      args.days = Number.parseInt(value, 10);
      i = nextIndex;
      continue;
    }
    if (flag === '--db') {
      const { value, nextIndex } = readOptValue('--db', inlineVal, i);
      args.db = value;
      i = nextIndex;
      continue;
    }
    if (flag === '--workspace') {
      const { value, nextIndex } = readOptValue('--workspace', inlineVal, i);
      args.workspace = value;
      i = nextIndex;
      continue;
    }
    if (raw.startsWith('-')) {
      throw new Error(`Unknown option: ${raw}`);
    }
    throw new Error(`Unexpected argument: ${raw}`);
  }

  return args;
}

function termWidth() {
  const cols = Number(process.stdout.columns);
  return Number.isFinite(cols) && cols >= 40 ? cols : 100;
}

function fmtUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${roundN(v, v < 0.01 && v > 0 ? 4 : 2).toFixed(v < 0.01 && v > 0 ? 4 : 2)}`;
}

function fmtPct(frac) {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return '—';
  return `${roundN(frac * 100, 1).toFixed(1)}%`;
}

function makeStyler(useColor) {
  if (!useColor) return (_code, text) => String(text);
  return (code, text) => `\x1b[${code}m${text}\x1b[0m`;
}

function formatDbText(report, colorText) {
  const lines = [colorText.trimEnd()];
  if (report.session) {
    const s = report.session;
    const totalTok = (s.input || 0) + (s.output || 0) + (s.cache_read || 0);
    lines.push(
      '',
      `Session: ${s.calls} call(s) · ${fmtTok(totalTok)} tok (in ${fmtTok(s.input || 0)}, out ${fmtTok(s.output || 0)}, cache ${fmtTok(s.cache_read || 0)}) · Cost ${fmtUsd(s.est_cost_usd)}${s.cost_estimated ? ' (est.)' : ''}`,
    );
  }
  if (report.speed && report.speed.calls > 0) {
    const sp = report.speed;
    const tps = sp.avg_streaming_tps !== null ? `${roundN(sp.avg_streaming_tps, 1)} tok/s` : '—';
    const ttft = sp.avg_ttft_sec !== null ? `${roundN(sp.avg_ttft_sec, 2)}s TTFT` : '—';
    lines.push(`Speed:   ${tps} avg · ${ttft} (${sp.calls} gen(s))`);
  }
  return `${lines.join('\n')}\n`;
}

function formatSummaryText({ version, geminiDir, pricingMeta, days, history, report, quota, useColor }) {
  const c = makeStyler(useColor);
  const out = [];
  out.push(c('1;36', `Agy Lens v${version}`) + c('90', ' — Antigravity Local Usage Summary'));
  out.push(`Gemini dir: ${geminiDir}`);
  out.push(`Pricing:    ${pricingMeta.source}${pricingMeta.stale ? ' (stale)' : ''}`);

  const all = history.totals?.all || { calls: 0, input: 0, output: 0, cache_read: 0, est_cost_usd: null };
  if (all.calls === 0 && !report) {
    out.push('');
    out.push(c('33', 'No Antigravity conversations found in this Gemini directory.'));
    out.push('Tip: pass --db <path> to inspect a conversation DB, or set ANTIGRAVITY_GEMINI_DIR.');
    out.push('');
    if (quota.pools?.length) {
      out.push(c('1', 'Quota'));
      for (const p of quota.pools) {
        out.push(`  ${p.label}: ${fmtPct(p.remaining_fraction)} remaining${p.reset_time ? ` (resets ${p.reset_time})` : ''}`);
      }
    } else {
      out.push(`Quota: ${c('90', quota.message || 'offline (language server not running)')}`);
    }
    return `${out.join('\n')}\n`;
  }

  out.push('');
  out.push(c('1', `Usage Totals (window: ${days}d)`));
  const periods = [
    ['Today', history.totals.today],
    ['7d', history.totals.d7],
    ['30d', history.totals.d30],
    ['All', history.totals.all],
  ];
  for (const [label, t] of periods) {
    if (!t) continue;
    const tok = (t.input || 0) + (t.output || 0) + (t.cache_read || 0);
    const est = t.cost_estimated ? ' (est.)' : '';
    out.push(
      `  ${label.padEnd(6)} ${String(t.calls).padStart(5)} calls  ${fmtTok(tok).padStart(7)} tok  (in ${fmtTok(t.input || 0)}, out ${fmtTok(t.output || 0)}, cache ${fmtTok(t.cache_read || 0)})  ${fmtUsd(t.est_cost_usd)}${est}`,
    );
  }
  out.push(
    `  Sources: desktop=${history.sources?.desktop || 0}, cli=${history.sources?.cli || 0}${history.errors ? `, errors=${history.errors}` : ''}`,
  );

  if (history.by_model?.length) {
    out.push('');
    out.push(c('1', 'Top Models'));
    for (const m of history.by_model.slice(0, 8)) {
      const label = m.display_name || modelLabel(m.model) || m.model;
      const tok = (m.input || 0) + (m.output || 0) + (m.cache_read || 0);
      out.push(
        `  ${label.padEnd(28)} ${String(m.calls).padStart(5)} calls  ${fmtTok(tok).padStart(7)} tok  ${fmtUsd(m.est_cost_usd)}`,
      );
    }
  }

  out.push('');
  if (quota.pools?.length) {
    out.push(c('1', `Quota${quota.plan ? ` (${quota.plan})` : ''}`));
    for (const p of quota.pools) {
      out.push(`  ${p.label.padEnd(24)} ${fmtPct(p.remaining_fraction).padStart(7)} remaining${p.reset_time ? ` · resets ${p.reset_time}` : ''}`);
    }
  } else {
    out.push(`Quota: ${c('90', quota.message || 'offline (language server not running)')}`);
  }

  if (report) {
    out.push('');
    out.push(c('1', 'Latest Conversation'));
    const pctStr = Number.isFinite(report.used_pct) ? `${report.used_pct.toFixed(1)}%` : '—';
    out.push(`  ${report.model} · ${fmtTok(report.used_tokens)}/${fmtTok(report.limit_tokens)} (${pctStr}) · id=${report.conversation_id}`);
    if (report.speed?.avg_streaming_tps !== null && report.speed?.avg_streaming_tps !== undefined) {
      out.push(`  Speed: ${roundN(report.speed.avg_streaming_tps, 1)} tok/s avg (${report.speed.calls} gen(s))`);
    }
  }

  return `${out.join('\n')}\n`;
}

export async function runCliMain(argv = process.argv.slice(2)) {
  const version = readVersion();
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err?.message || err}\nRun "agy-lens --help" for usage.\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(`${helpText(version)}\n`);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  if (!(await hasNodeSqlite())) {
    process.stderr.write('Error: Node.js built-in "node:sqlite" is required (Node.js 24+).\n');
    return 1;
  }

  const envNoColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';
  const useColor = !args.json && !args.noColor && !envNoColor && Boolean(process.stdout.isTTY);

  const geminiDir = defaultGeminiDir();
  const dataDir = defaultDataDir();
  const roots = defaultRoots(geminiDir);
  const catalogPath = join(dataDir, 'model-catalog.json');
  const quotaRawPath = join(dataDir, 'quota-raw.json');
  const quotaCyclesPath = join(dataDir, 'quota-cycles.json');
  const historyCachePath = join(dataDir, 'history-cache.json');
  const pricingPath = join(dataDir, 'pricing-cache.json');
  const pricingFile = existsSync(pricingPath) ? pricingPath : null;
  const modelCatalogPath = existsSync(catalogPath) ? catalogPath : null;
  const width = termWidth();

  if (args.db !== null) {
    const dbPath = resolve(expandHome(args.db));
    let isFile = false;
    try {
      isFile = existsSync(dbPath) && statSync(dbPath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      process.stderr.write(`Error: Conversation database not found: ${dbPath}\n`);
      return 1;
    }

    let subagentDbPaths = [];
    let archivedSubagents = [];
    let enumMap = null;
    try {
      const found = await findSubagentSources(roots, basename(dbPath, '.db'), historyCachePath);
      subagentDbPaths = found.dbPaths;
      archivedSubagents = found.archivedEntries;
      enumMap = found.enums;
    } catch { /* summaries unavailable */ }

    let report;
    try {
      report = await buildReport({
        dbPath,
        workspace: args.workspace,
        width,
        modelCatalogPath,
        pricingFile,
        subagentDbPaths,
        archivedSubagents,
        enumMap,
      });
    } catch (err) {
      process.stderr.write(`Error: Failed to inspect database: ${err?.message || err}\n`);
      return 1;
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }

    let textOut = report.text;
    if (useColor) {
      const [steps, gen] = await load(dbPath);
      const catalog = loadModelCatalog(modelCatalogPath);
      const cat = catalogEntry(modelId(gen), catalog) || {};
      const limit = (Number(cat.maxTokens) || 0) || contextLimit(gen);
      const st = collectStats(steps, gen, limit);
      const model = cat.displayName || modelName(gen);
      const ws = args.workspace && String(args.workspace).startsWith('file:')
        ? workspacePath(args.workspace)
        : (args.workspace || null);
      const systemFiles = detectSystemFiles(homedir(), ws, 'antigravity', geminiDir);
      textOut = render(st, model, systemFiles, width, true);
    }
    process.stdout.write(formatDbText(report, textOut));
    return 0;
  }

  const hasLsEnv = Boolean((process.env.ANTIGRAVITY_LS_ADDRESS || '').trim())
    && Boolean((process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim());
  let quota;
  if (hasLsEnv) {
    try {
      quota = await fetchQuota({ catalogPath, quotaRawPath, quotaCyclesPath });
    } catch (err) {
      quota = {
        pools: [],
        weekly: {},
        plan: null,
        tier: null,
        fetched_at: new Date().toISOString(),
        error: 'failed',
        message: err?.message || 'quota fetch failed',
      };
    }
  } else {
    quota = {
      pools: [],
      weekly: {},
      plan: null,
      tier: null,
      fetched_at: new Date().toISOString(),
      error: 'unavailable',
      message: 'Antigravity language server offline',
    };
  }

  let quotaCycles = loadQuotaCycles(quotaCyclesPath, quotaRawPath);
  if (quota && !quota.error) {
    quotaCycles = mergeQuotaObservation(quotaCycles, quota).ledger;
  }

  const history = await scan(roots, {
    cachePath: historyCachePath,
    days: args.days,
    pricingFile,
    modelCatalogPath,
    quotaCycles,
    legacyCachePaths: findLegacyHistoryCaches(geminiDir),
  });

  const latestDb = findLatestDb([
    defaultConversationsDir('antigravity', geminiDir),
    defaultConversationsDir('antigravity-cli', geminiDir),
  ]);
  let latestReport = null;
  if (latestDb) {
    let subagentDbPaths = [];
    let archivedSubagents = [];
    let enumMap = null;
    try {
      const found = await findSubagentSources(roots, basename(latestDb, '.db'), historyCachePath);
      subagentDbPaths = found.dbPaths;
      archivedSubagents = found.archivedEntries;
      enumMap = found.enums;
    } catch { /* summaries unavailable */ }
    try {
      latestReport = await buildReport({
        dbPath: latestDb,
        workspace: args.workspace,
        width,
        modelCatalogPath,
        pricingFile,
        subagentDbPaths,
        archivedSubagents,
        enumMap,
      });
    } catch {
      latestReport = null;
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ history, report: latestReport, quota }, null, 2)}\n`);
    return 0;
  }

  const pricingMeta = readPricingMeta(pricingPath);
  process.stdout.write(
    formatSummaryText({
      version,
      geminiDir,
      pricingMeta,
      days: args.days,
      history,
      report: latestReport,
      quota,
      useColor,
    }),
  );
  return 0;
}

function isMainEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isMainEntry()) {
  runCliMain().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Error: ${err?.message || err}\n`);
      process.exitCode = 1;
    },
  );
}
