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
    quota.mjs                    language server RPCs and summary-first quota pool parsing
    wake.mjs                     opt-in per-pool cycle auto-wake via local ConversationService
    calibration.mjs              Ridge WLS + LOOCV model/IO quota weight calibration & external filter
    catalog.mjs                  live model catalog (names, context windows, pools)
    pricing.mjs                  built-in price table and opt-in LiteLLM / OpenRouter sync
    share-assets.mjs             share profile persistence, pixel art reader, OS clipboard bridge
    updater.mjs                  cached GitHub Release update checker & SHA-256 self-updater
    web-bundle.mjs               bundles web/ ES modules into one classic script
  share-art/                     bundled pixel arenas, character sprites & idle animations
  web/
    index.html, styles.css
    app.js                       state, polling, tabs, language, in-panel self-update banner
    i18n.js                      en / zh strings, locale detection
    format.js                    pure formatting and quota math
    views/
      overview.js, quota.js, history.js
      share-card.js, share-styles.js, share-webgl.js, share-motion.js, share-gif.js
      share-game.js, share-pixel.js, share-frames.js, share-font.js, share-badges.js, share-vfx.js
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

Pools are discovered dynamically from the language server (such as Gemini, Claude / GPT-OSS, or separate Claude Opus / Sonnet groups when a plan splits them, plus Tab completion), preventing summary bucket collisions and persisting each pool in `model-catalog.json`. If the summary RPC doesn't return explicit buckets, the limit kind is inferred from the reset time and marked `≈`. Raw responses are redacted (emails, names, tokens) before being cached.

These RPCs are undocumented, so fields can change with app updates. Parsing is defensive and falls back to a built-in context window table when the catalog is missing.

## HTTP API (sidecar)

| Route | Returns |
| --- | --- |
| `GET /` | `index.html` with `?v=` stamps on `styles.css` and `app.js` |
| `GET /app.js` | all `web/` modules bundled into one classic script (see below) |
| `GET /api/report?conversationId=…` | context breakdown, speed and session totals for the open conversation |
| `GET /api/quota[?refresh=true]` | pools, weekly buckets, plan, tier |
| `GET /api/quota/wake` | per-pool opt-in auto-wake status, cheapest wake model, latch & in-flight state |
| `POST /api/quota/wake/config` | toggles per-pool `auto` wake state in `quota-wake.json` (default `false`) |
| `GET /api/history[?refresh=true]` | totals per window, `period_quota`, `by_model` (with per-window `periods`), `by_conversation` (with subagent `total`, `project_id`, `quota_pct_by_pool`), `daily`, `hourly_today`, `d7_by_pool`, `weekly_cycles`, `weekly_value_usd`, `quota_calibration` |
| `GET /api/pricing[?refresh=true]` | price table metadata; `refresh` downloads public prices |
| `GET /api/update[?refresh=true]` | current vs latest GitHub Release version (`update-cache.json`, cached 6h, `AGY_LENS_NO_UPDATE_CHECK=1` opt-out) |
| `POST /api/update/install` | SHA-256-verified in-place release ZIP upgrade with atomic rollback (`AGY_LENS_NO_SELF_UPDATE=1` opt-out) |
| `GET /api/share-asset` | lists or reads bundled pixel share-art assets as base64 |
| `GET / POST /api/share-profile` | reads/saves optional pixel role card nickname & novice gender (`share-profile.json`) |
| `POST /api/share-copy-file` / `/api/share-copy-gif` | writes exported Live Photo / MP4 / WebM / GIF to local export dir and copies file path to OS clipboard |

Static responses are sent with `Cache-Control: no-store` so the WebView never pairs a new HTML shell with stale scripts.

## Why `/app.js` is bundled

The source in `web/` is split into ES modules for readability and tests. Antigravity's sidecar WebView does not reliably load `<script type="module">` with relative sub-imports, which left the panel stuck on "Loading…". `lib/web-bundle.mjs` therefore turns the module graph into one self-contained classic script at request time (cached by a hash of every `web/**/*.js` mtime and size), and `index.html` loads it with a plain `<script src="app.js">`. A boot error handler shows any startup failure in the panel instead of hanging.

## Caching and refresh

- Overview polls `/api/report` every 3 s while visible; results are cached per conversation and invalidated by the database, WAL, descendant subagent database stamps, and archived subagent cache state.
- Quota and History refresh silently every 65 s while visible and on focus when older than 60 s; the sidecar also polls `/api/quota` in the background every 5 minutes so `quota-cycles.json` captures pre-saturation watermarks and clean incremental segments even while staying on Overview.
- The model catalog refreshes every 10 minutes. History parsing is cached per database file fingerprint in `history-cache.json` (v6), which also archives conversations deleted by Antigravity and preserves parent-child subagent links and model enum mappings.
- Official weekly quota snapshots are persisted per pool cycle in `quota-cycles.json` (up to 52 cycles per pool) so historical weeks remain available across resets.
- Public prices are cached for 24 hours in `pricing-cache.json`.

## Weekly quota valuation, UI division, and attribution

To avoid duplicate widgets across tabs, **Quota** owns live 5h/weekly meters, implied 100% cycle dollar values, and cycle shrinkage history, while **History** shows period totals, period-scoped model rankings, project trees, and share cards, and both **Overview** and **History** display per-project `≈ X% weekly` consumption.

`RetrieveUserQuotaSummary` returns per-pool remaining fractions and exact `reset_time` timestamps (e.g. `gemini`, `claude_gpt`, or plan-split pools such as `claude_opus` / `claude_sonnet`), consuming quota proportionally to token cost inside each reset cycle without assuming every cycle lasts 7 days or reaches 100% usage.

- **Dynamic cycle ledger & in-cycle delta alignment**: Every live `/api/quota` fetch (plus 5-minute background polling) records up to 300 `observations` checkpoints per cycle (preserving `≥ 2h` gaps and `≥ 2%` steps) and `reset_time` entries in `quota-cycles.json` (v2, migrating v1 entries). When two consecutive reset timestamps are recorded, `cycle_start = prev.reset_time` and `cycle_duration_ms = curr.reset_time - prev.reset_time` (`上次刷新时间 − 上上次刷新时间`), closing early-reset cycles (`ended_at`) immediately when a used pool returns to `100%` with `reset_time: null`. Before two consecutive resets exist (`cycle_start: null`), `scan()` never invents a 7-day window — it evaluates `valuation_method: 'delta'` from the largest monotonic in-cycle sample pair `[eval_start_at, eval_obs_at]` (requiring ≥0.2% delta on fine-precision fractions or ≥1% on coarse integer percentages, showing an explicit `Sampling…` state in Totals while awaiting the next delta). On saturated cycles (`0%` left), `observed_at` locks at first saturation and uses `peak_unsaturated` (when peak usage ≥ 20%) so subsequent AI-credit spend cannot inflate the baseline.
- **Multi-cycle utilization & opt-in cycle auto-wake (`lib/wake.mjs`)**: Beneath each pool's cycle bar chart, `cycleQuotaSummary` computes closed-loop `Used / Total`, live `Cycle left`, and expired `Past unused` percentages across the active range. Because Antigravity starts weekly and 5h countdowns lazily on first use (`remaining_fraction: 1, reset_time: null`), `lib/wake.mjs` provides an opt-in per-pool **Auto-wake** toggle persisted in `quota-wake.json` (`auto: false` by default). When enabled, `wakePoolCycle` dynamically ranks models in the pool by lowest unit cost and thinking effort (non-orchestrator first), writes a persistent `pending_latched` circuit breaker and `last_attempt_at` strictly before making any RPC, sends one minimal tool-disabled prompt via Antigravity's official local `product.v1.ConversationService`, waits for `RUN_STATE_IDLE`, and deletes (or archives as fallback) the temporary chat. The latch re-arms only when a real future `reset_time` is observed (or the user toggles OFF → ON), paired with a 12-hour minimum cooldown and HTTP 400/404-only candidate fallback to prevent any silent retry loop.
- **Empirical model/IO calibration & external-usage filtering (`lib/calibration.mjs`)**: Consecutive monotonic non-saturated observation intervals are partitioned without overlap. Any interval with `delta >= 0.5%` and zero local calls/spend is flagged external (`external_used_fraction`) and excluded from valuation and fitting. Across clean segments (up to the 6 newest cycles), a weighted Ridge WLS solver evaluates three hypotheses — per-model ID (`model`), pool-wide `[input, output, cache_read]` split (`io`), and joint per-model `[input, output, cache_read]` (`model_io`) — gated strictly by analytical Leave-One-Out Cross-Validation (≥15% in-sample SSE reduction, ≥10% LOOCV reduction, and ≥5% further LOOCV gain before upgrading to `model_io`). When active, calibrated weights adjust `weekly_value_usd` and all `≈ X% weekly` readouts (while keeping displayed public USD spend untouched) and surface transparently beneath the pool meter on **Quota**.
- **Implied 100% cycle value & partial-usage cycles**: Once full-cycle `eval_used_fraction >= 0.05` (or first-cycle `'delta'` meets the precision-aware floor), `weekly_value_usd = observed_cost_usd / eval_used_fraction` yields the pool's implied 100% cycle allowance, compared against prior cycles (`change_pct`). Partial-usage completed cycles scale by actual `%` used without assuming 100% exhaustion; cycles below the sample floor (or with only 1 sample) report `weekly_value_usd: null` and temporarily reference the most recent valid cycle.
- **Adaptive square-grid cycle chart & baseline diff UI (`web/views/quota.js`, `web/styles.css`)**: renders an always-open per-pool `<section class="wcycles">` between limited pools and bottom-placed unlimited pools (`isUnlimitedPool`), supporting `CYCLE_PERIODS = ['month', 'm3', 'all']` with `cycleBarRows(cols) = clamp(3..12, round(cols * 0.29))` and CSS `aspect-ratio: 1` squares so chart height stays steady across densities (`10×3`, `14×4`, `24–52 × 7–12`). Bars preserve `l1..l4` relative intensity while anchoring historical comparisons to the current cycle's quantized row height (`curRows`): surplus rows above `curRows` shift to `--crit` (`diff-shrink`), deficit gaps below `curRows` render borderless translucent `--ok` (`diff-grow`), and unvalued current or historical cycles degrade cleanly without false diff markers.
- **Per-project & per-model sizing**: Totals (`renderTotalsHeroHtml`, aggregating `periodWeeklySummary` across `by_model[].periods`), models (`by_model[].periods` matching the active period pill), and conversations (including live + archived subagent rollups) size against each pool's benchmark via `cost_by_pool[pool] / weekly_value_usd[pool]` (`≈ X% weekly`, unclamped so multi-cycle periods/projects remain comparable). When multiple pools are active in a period or conversation, `convWeeklyBreakdown` / `periodWeeklySummary` ranks pools by highest `%` quota impact (`sortActivePools`) so a heavy burn in a tighter pool (e.g. `Claude/GPT`) is never masked by a larger-USD spend in another pool (e.g. `Gemini`). There is no rolling 7-day token fallback or manual calibration when no official cycle has been recorded yet.

## Share card gallery & update checks

- `web/views/share-{card,styles,webgl,motion,gif,game,pixel,frames,font,badges,vfx}.js` render 6 sanitized styles — five `760×950` editorial posters (**Mountain · Almanac**, **Abyssal · Trench**, **Eclipse · Astrolabe**, **Bauhaus · Overprint**, **Phosphor · Ribbon**) and one `1200×630` **Pixel · Hero** RPG character card (native `400×210` @ 3×) — each supporting Night (Dark) and Day (Light) themes inside a full-bleed `ResizeObserver`-fitted modal. All input passes through an allowlist sanitizer scrubbing paths and emails; conversation titles are never read. Live previews run 60fps WebGL1 fragment shaders (posters) or 2D ambient pixel VFX (role card), and exports support pure-Node H.264 MP4 muxing, `GCamera:MotionPhoto` Live Photo (`.jpg`), WebM, Floyd-Steinberg GIF89a, 2× PNG, and SVG with OS file-clipboard copy (`/api/share-copy-file`).
- `lib/updater.mjs` (`GET /api/update`, `POST /api/update/install`) checks GitHub Releases (`releases/latest`, falling back to raw `plugin.json`) with a 6-hour local cache in `update-cache.json`. It sends only anonymous `GET` requests (`AGY_LENS_NO_UPDATE_CHECK=1` to disable) and supports one-click SHA-256-verified release ZIP upgrades with automatic rollback (`AGY_LENS_NO_SELF_UPDATE=1` to disable).

## Privacy boundaries

- Databases are read-only; the app binary is never modified.
- Default traffic goes only to the local language server, plus an optional cached anonymous `GET` to GitHub Releases for version update checks (disable with `AGY_LENS_NO_UPDATE_CHECK=1`).
- Price sync and in-panel updates are explicit opt-in anonymous `GET` requests with no local data sent.
- Per-pool **Auto-wake** is strictly opt-in (`auto: false` by default) and calls only the local `product.v1.ConversationService` when enabled for a pool.
