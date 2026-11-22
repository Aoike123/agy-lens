#!/usr/bin/env node
// Standalone 4-tier Opaque-Box E2E Test Runner for Agy Lens (agy-lens)
// Usage:
//   node tests/e2e/run.mjs [--tier 1|2|3|4|1,2] [--filter <substr>] [--json]
//   ELECTRON_RUN_AS_NODE=1 Antigravity.exe tests/e2e/run.mjs ...

import { SkipError } from './lib/harness.mjs';
import { TESTS as T1_A } from './tier1_f1_f6.mjs';
import { TESTS as T1_B } from './tier1_f7_f12.mjs';
import { TESTS as T2_A } from './tier2_f1_f6.mjs';
import { TESTS as T2_B } from './tier2_f7_f12.mjs';
import { TESTS as T3 } from './tier3_pairwise.mjs';
import { TESTS as T4 } from './tier4_scenarios.mjs';

const ALL_TESTS = [...T1_A, ...T1_B, ...T2_A, ...T2_B, ...T3, ...T4];

function parseArgs(argv) {
  const opts = { tiers: null, filter: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      opts.json = true;
    } else if (a === '--tier' && i + 1 < argv.length) {
      opts.tiers = new Set(argv[++i].split(',').map((s) => Number(s.trim())).filter(Boolean));
    } else if (a.startsWith('--tier=')) {
      opts.tiers = new Set(a.slice(7).split(',').map((s) => Number(s.trim())).filter(Boolean));
    } else if (a === '--filter' && i + 1 < argv.length) {
      opts.filter = argv[++i].toLowerCase();
    } else if (a.startsWith('--filter=')) {
      opts.filter = a.slice(9).toLowerCase();
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const selected = ALL_TESTS.filter((t) => {
  if (opts.tiers && !opts.tiers.has(t.tier)) return false;
  if (opts.filter) {
    const hay = `${t.id} ${t.feature} ${t.title}`.toLowerCase();
    if (!hay.includes(opts.filter)) return false;
  }
  return true;
});

const results = [];
const tiers = {
  1: { total: 0, passed: 0, failed: 0, skipped: 0 },
  2: { total: 0, passed: 0, failed: 0, skipped: 0 },
  3: { total: 0, passed: 0, failed: 0, skipped: 0 },
  4: { total: 0, passed: 0, failed: 0, skipped: 0 },
};

const suiteStart = Date.now();

for (const tc of selected) {
  const t0 = Date.now();
  let status = 'PASS';
  let error = null;
  try {
    await tc.run();
  } catch (err) {
    if (err instanceof SkipError || err?.name === 'SkipError') {
      status = 'SKIP';
      error = err.message;
    } else {
      status = 'FAIL';
      error = err?.message || String(err);
    }
  }
  const duration_ms = Date.now() - t0;
  tiers[tc.tier].total += 1;
  if (status === 'PASS') tiers[tc.tier].passed += 1;
  else if (status === 'SKIP') tiers[tc.tier].skipped += 1;
  else tiers[tc.tier].failed += 1;

  results.push({
    id: tc.id,
    tier: tc.tier,
    feature: tc.feature,
    title: tc.title,
    status,
    duration_ms,
    ...(error ? { error } : {}),
  });

  if (!opts.json) {
    const tag = status === 'PASS' ? '[PASS]' : status === 'SKIP' ? '[SKIP]' : '[FAIL]';
    console.log(`${tag} ${tc.id} (T${tc.tier}/${tc.feature}) ${tc.title} (${duration_ms}ms)`);
    if (error) {
      const firstLine = String(error).split(/\r?\n/)[0];
      console.log(`       ${firstLine}`);
    }
  }
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const total = results.length;
const duration_ms = Date.now() - suiteStart;

if (opts.json) {
  console.log(JSON.stringify({ total, passed, failed, skipped, duration_ms, tiers, results }, null, 2));
} else {
  console.log('\n--- Summary by Tier ---');
  for (const t of [1, 2, 3, 4]) {
    const s = tiers[t];
    if (s.total > 0) {
      console.log(`Tier ${t}: total=${s.total}, passed=${s.passed}, failed=${s.failed}, skipped=${s.skipped}`);
    }
  }
  console.log(`\nTOTAL: total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped}, duration_ms=${duration_ms}`);
}

process.exit(failed === 0 ? 0 : 1);
