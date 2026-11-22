# Architecture

How Agy Lens gets its numbers, and where each piece lives. For install and usage see the [README](../README.md).

## Layout

```
plugin.json                      plugin manifest (name, displayName, author, repository)
package.json                     zero dependencies; "bin" exposes the terminal CLI
bin/cli.mjs                      terminal summary (reuses sidecars/agy-lens/lib/)
sidecars/agy-lens/
  sidecar.json                   registers the aux-pane panel; Antigravity runs `node main.mjs`
  main.mjs                       HTTP routes, caches, static assets
  lib/
    pb.mjs                       protobuf wire decoder, read-only node:sqlite opener, date helpers
    context.mjs                  one conversation: context breakdown, speed, session totals
    history.mjs                  all conversations: totals, per-model, per-day, per-conversation
    quota.mjs                    language server RPCs and quota pool parsing
    catalog.mjs                  live model catalog (names, context windows, pools)
    pricing.mjs                  built-in price table and opt-in LiteLLM / OpenRouter sync
    web-bundle.mjs               bundles web/ ES modules into one classic script
  web/
    index.html, styles.css
    app.js                       state, polling, tabs, language
    i18n.js                      en / zh strings, locale detection
    format.js                    pure formatting and quota math
    views/overview.js, quota.js, history.js, share-card.js
scripts/
  build-release.mjs              builds dist/agy-lens.zip with only runtime files
  install.sh, install.ps1        one-line installers
  render-screenshots.mjs         regenerates docs/img from synthetic fixtures
tests/                           node:test unit suites, tests/e2e/ end-to-end suite, tests/fixtures/
```

Everything runs on the Node.js 24 that ships inside Antigravity 2.0. There are no npm dependencies and no Python.

## Data sources

### Conversation databases (SQLite)

Each conversation is a SQLite file:

- Desktop: `~/.gemini/antigravity/conversations/<id>.db`
- CLI: `~/.gemini/antigravity-cli/conversations/<id>.db`

They are opened with `node:sqlite` in read-only mode. Two tables matter:

| Table | Content | Used for |
| --- | --- | --- |
| `steps` | one row per trajectory step (`step_type`, `status`, `metadata`, `step_payload`, all protobuf blobs) | step categories, timestamps, checkpoints, the first user message |
| `gen_metadata` | one row per model call (`data`, a protobuf blob) | token usage, model id, timing, context window breakdown |

`lib/pb.mjs` decodes the protobuf wire format directly (varints, length-delimited fields, 64-bit values, signed ints); no `.proto` files are needed. Important fields:

- **Usage** (`gen_metadata` → chat → usage): input, output, cache read, thinking and response tokens.
- **Timing**: time to first token and streaming duration, which give TTFT, streaming tok/s and end-to-end tok/s. Short or buffered replies are filtered out of the streaming median.
- **Context window message**: a list of top-level token groups (system prompt, tools, rules, MCP tools, skills, subagents, chat messages, workflows, plugins). Chat message children are named `N: STEP_TYPE`, so they can be mapped back to user / agent / tool categories. This is the same accounting as the agy CLI's `/context`.
- **Planner & step usage timestamps**: `gen_metadata` calls bind directly to `steps.metadata` (`created_at`) via `usage.response_id` / `message_id`, falling back to `PLANNER_RESPONSE` step order only when an ID is absent so retries or cancelled calls never skew day/cycle boundaries.
- **Cross-DB enum resolution**: compaction/checkpoint calls recorded only in `steps.metadata` resolve their model enum across all local conversations and cached `enums` (leaving unseen non-zero enums as `unknown` rather than misbilling under the main model).

Conversation titles come from the app's own summaries database and are only shown in the History list, never in the share card.

### Language server RPCs

The app passes the local language server address and a CSRF token to the sidecar in its environment. `lib/quota.mjs` calls three Connect-JSON RPCs on `exa.language_server_pb.LanguageServerService`:

| RPC | Gives |
| --- | --- |
| `GetUserStatus` | plan and tier, per-model quota fraction and reset time |
| `GetAvailableModels` | model catalog: display names, context windows, providers, model ordering |
| `RetrieveUserQuotaSummary` | official 5-hour and weekly buckets per pool |

Pools are grouped by provider bucket (Claude / GPT-OSS, Gemini, Tab completion). If the summary RPC doesn't return explicit buckets, the limit kind is inferred from the reset time and marked `≈`. Raw responses are redacted (emails, names, tokens) before being cached.

These RPCs are undocumented, so fields can change with app updates. Parsing is defensive and falls back to a built-in context window table when the catalog is missing.

## HTTP API (sidecar)

| Route | Returns |
| --- | --- |
| `GET /` | `index.html` with `?v=` stamps on `styles.css` and `app.js` |
| `GET /app.js` | all `web/` modules bundled into one classic script (see below) |
| `GET /api/report?conversationId=…` | context breakdown, speed and session totals for the open conversation |
| `GET /api/quota[?refresh=true]` | pools, weekly buckets, plan, tier |
| `GET /api/history[?refresh=true]` | totals per window, `by_model` (with per-window `periods`), `by_conversation` (with subagent `total` and `cost_by_pool`), `daily`, `hourly_today`, `d7_by_pool`, `weekly_cycles`, `weekly_value_usd` |
| `GET /api/pricing[?refresh=true]` | price table metadata; `refresh` downloads public prices |

Static responses are sent with `Cache-Control: no-store` so the WebView never pairs a new HTML shell with stale scripts.

## Why `/app.js` is bundled

The source in `web/` is split into ES modules for readability and tests. Antigravity's sidecar WebView does not reliably load `<script type="module">` with relative sub-imports, which left the panel stuck on "Loading…". `lib/web-bundle.mjs` therefore turns the module graph into one self-contained classic script at request time (cached by a hash of every `web/**/*.js` mtime and size), and `index.html` loads it with a plain `<script src="app.js">`. A boot error handler shows any startup failure in the panel instead of hanging.

## Caching and refresh

- Overview polls `/api/report` every 3 s while visible; results are cached per conversation and invalidated by the database, WAL, descendant subagent database stamps, and archived subagent cache state.
- Quota and History refresh silently every 65 s while visible and on focus when older than 60 s; the sidecar also polls `/api/quota` in the background every 10 minutes so `quota-cycles.json` captures pre-saturation watermarks even while staying on Overview.
- The model catalog refreshes every 10 minutes. History parsing is cached per database file fingerprint in `history-cache.json` (v6), which also archives conversations deleted by Antigravity and preserves parent-child subagent links and model enum mappings.
- Official weekly quota snapshots are persisted per pool cycle in `quota-cycles.json` (up to 52 cycles per pool) so historical weeks remain available across resets.
- Public prices are cached for 24 hours in `pricing-cache.json`.

## Weekly quota valuation, UI division, and attribution

To avoid duplicate widgets across tabs, **Quota** owns live 5h/weekly meters, implied 100% weekly dollar values, and weekly cycle shrinkage history, while **History** shows period totals, period-scoped model rankings, project trees, and share cards, and both **Overview** and **History** display per-project `≈ X% weekly` consumption.

`RetrieveUserQuotaSummary` returns per-pool (`gemini`, `claude_gpt`) remaining fractions and exact `reset_time` timestamps, explicitly consuming quota proportionally to token cost inside each fixed 7-day cycle `[reset_time - 7d, reset_time)`.

- **Cycle ledger & time alignment**: Every live `/api/quota` fetch (plus 10-minute background polling) records/updates `(cycle_start, reset_time, observed_at, remaining_fraction)` in `quota-cycles.json`, keeping `peak_unsaturated` strictly monotonic. During `scan()`, each cycle sums local spend strictly over `[cycle_start, min(eval_obs_at, reset_time)]`. When a cycle hits `0%` remaining, `observed_at` locks at first saturation and uses `peak_unsaturated` (when peak usage >= 20%) so subsequent paid AI-credit spend after exhaustion does not inflate the baseline.
- **Implied 100% weekly value & shrinkage detection**: Whenever at least 5% of a cycle has been consumed (`eval_used_fraction >= 0.05`), `weekly_value_usd = observed_cost_usd / eval_used_fraction` yields the pool's implied 100% weekly dollar allowance, compared against prior cycles (`change_pct`) to surface week-over-week quota changes. After a fresh reset (<5% used), sizing temporarily references the most recent completed cycle's `weekly_value_usd`.
- **Per-project & per-model sizing**: Models (`by_model[].periods` matching the active period pill) and conversations (including live + archived subagent rollups) size against the pool's benchmark via `cost_by_pool[pool] / weekly_value_usd[pool]` (`≈ X% weekly`, unclamped so multi-week items remain comparable). There is no rolling 7-day token fallback or manual calibration when no official cycle has been recorded yet.

## Share card

`web/views/share-card.js` builds the card from an allowlist: period totals, per-model token counts for that period, and daily totals. Model names are scrubbed for paths and emails, all text is XML-escaped, and conversation titles are never read. PNG export draws the SVG onto a canvas locally.

## Privacy boundaries

- Databases are read-only; the app binary is never modified.
- The only default network traffic is to the local language server.
- The only external request is the opt-in price sync (anonymous `GET`, no local data).
