# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **GitHub Release update checker & in-panel banner** (`sidecars/agy-lens/lib/updater.mjs`, `GET /api/update`, `web/app.js`, `bin/cli.mjs`): 6-hour cached anonymous check against GitHub Releases (falling back to raw `plugin.json`) with a dismissible top banner (one-click copy install command + release link), cached text-mode CLI notice, and `AGY_LENS_NO_UPDATE_CHECK=1` opt-out.
- **Period-adaptive Share Card activity charts** (`sidecars/agy-lens/web/views/share-card.js`): `Today` now plots 24-hour (`00:00`–`23:00`) activity from `hourly_today`, `7d` draws labeled weekday columns, `30d` renders a timeline with `MM-DD` ticks, and `All` renders a multi-week 7-row calendar heatmap; model sorting now strictly ranks by displayed `input + output` tokens.
- **Period weekly quota estimate in History Totals** (`sidecars/agy-lens/web/format.js`, `web/views/history.js`): Totals now estimates the active period's weekly quota usage (`≈ X%`, clickable to Quota, with an inline multi-pool breakdown row when multiple pools are used) alongside live/recorded sync status.
- **Empirical quota ratio calibration & external-usage filtering** (`sidecars/agy-lens/lib/calibration.mjs`, `lib/pricing.mjs`, `lib/history.mjs`, `web/views/quota.js`): partitions cycles into non-overlapping incremental segments, filters off-machine consumption drops (`delta >= 0.5%` with zero local calls) from weekly benchmarks, and fits internal quota multipliers across full model IDs, `(input, output, cache_read)` splits, or joint `(model, token_type)` ratios via Ridge WLS + Leave-One-Out CV anti-overfitting gates.

### Fixed

- **Dynamic quota cycle intervals instead of hardcoded 7-day / 100% assumptions** (`sidecars/agy-lens/lib/quota.mjs`, `lib/history.mjs`, `web/views/quota.js`): bumped `quota-cycles.json` to v2, deriving `cycle_start` and `cycle_duration_ms` dynamically from consecutive reset timestamps (`last_reset - prev_reset`, guarding against mid-cycle shifts and offline multi-cycle gaps) rather than `reset_time - 7d`, relaxing `inferLimit` `'weekly'` up to 31 days, using precision-aware in-cycle sample deltas (`valuation_method: 'delta'`, ≥0.2% fine / ≥1% coarse) before two resets exist, forcing live quota sync on manual History refresh, and presenting partial-usage / sampling states clearly across Quota and History Totals.
- **Tree-grouped subagent classification in History Session List** (`sidecars/agy-lens/web/views/history.js`): nested child subagents inside expandable parent conversation trees in the default `Session list` view, badged standalone/matched subagents with `.sub-badge` (plus parent links in search results), and kept `Hide subagents` filtering intact.

## [2.2.0] - 2026-11-22

Renamed to **Agy Lens** (`agy-lens`) and repositioned as an English-first, zero-dependency cockpit for Antigravity 2.0.

### Added

- **Terminal CLI** (`bin/cli.mjs`, `npx github:Aoike123/agy-lens`): latest-conversation and history summary in the terminal, with `--json`.
- **Share card**: copy a sanitized usage card (PNG image or SVG, dark or light) straight to your clipboard from History with graceful WebView fallback. It shows period totals, the model mix as a 100-dot grid and daily activity; conversation titles and paths are never included.
- `by_model[].periods` in `/api/history`: per-window (`today`, `d7`, `d30`, `all`) token counts per model, so the share card matches its period.
- Automatic UI language from `navigator.language` (Chinese locales get Chinese, everything else English); a saved choice still wins.
- `scripts/render-screenshots.mjs`: regenerates all README images (EN / ZH screenshots, hero composites, share cards, 1280×640 social preview) from synthetic fixtures in `tests/fixtures/`.
- `README.zh-CN.md`, `docs/architecture.md`, launch drafts in `docs/launch/`, and an end-to-end suite in `tests/e2e/`.

### Fixed

- **Usage disappeared when Antigravity pruned old conversations.** Antigravity keeps only its newest conversation databases; once one was deleted, its tokens and cost vanished from the Today / 7d / 30d / All totals. The history cache now keeps the usage of deleted conversations (merged into 15-minute buckets per model, with long-context calls kept apart so tiered prices stay exact), and they show up in History marked `archived`. A database that is briefly locked keeps its last result instead of dropping out. Cache version 6; v4/v5 caches are upgraded in place.
- **Generation timestamp drift & compaction model attribution.** `parseDb()` now binds `gen_metadata` timestamps directly via `steps.metadata` response/message IDs (`stepUsageTimestamps`), avoiding day/cycle boundary shifts on retries or cancelled turns. Step-only compaction/checkpoint calls resolve model enums across all scanned/cached conversations (`enums` in v6 cache) instead of misbilling unknown enums as the main model.
- **Subagent usage was not counted toward the conversation that started it.** Subagent conversations (linked through `parent_conversation_id` in Antigravity's conversation summaries, any number of levels deep) are now arranged as a tree, combining both live subagent DBs and deleted/archived subagent cache entries seamlessly in Overview, History, and the CLI (`findSubagentSources`), while `totals.*.conversations` counts top-level conversation trees consistently.
- **Weekly-quota valuation, cycle history & non-overlapping tab layout.** Agy Lens persists official fixed 7-day reset cycles (`quota-cycles.json`) with 10-minute background sidecar polling, monotonic `peak_unsaturated` (≥20% prior to saturation), and a 5% cycle valuation floor (`MIN_CYCLE_USED_FRACTION = 0.05`) to prevent low-usage noise and post-limit AI-credit overshoot. Implied 100% weekly dollar values and cycle shrinkage history (`weekly_cycles`) live cleanly on the **Quota** tab (removing duplicate bars from History Totals), while **History** (`By model` sliced per active period, `By session`, `Session list`) and **Overview** (`This conversation`) keep per-project and per-model `≈ X% weekly` sizing via `cost_by_pool / weekly_value_usd`.
- **CLI & Share Card parity.** Fixed `reset_time` display, cycle/legacy cache loading, and subagent tree rollups in `bin/cli.mjs`; fixed `History → By model` and the Share Card to slice both tokens and `est_cost_usd` strictly to the active period (`Today / 7d / 30d / All`).
- **Dynamic multi-pool quota attribution & quota-% project ranking.** Server-driven pool discovery now handles shared (`3p`) or plan-split (`claude_opus`, `claude_sonnet`, custom groups) summary buckets without collisions or `NaN` in `d7_by_pool`, persists pool overrides into `model-catalog.json`, shows all limits (`weekly` + `5h`) in `bin/cli.mjs`, and ranks mixed-pool conversations in `convWeeklyLabel` / `sortActivePools` by highest weekly quota `%` impact rather than raw USD so a heavy third-party quota burn is never hidden by a higher-USD Gemini pool.
- **Usage already lost to pruning can be recovered.** On first run, history caches left by earlier builds or backups under `~/.gemini/antigravity/sidecar_data` are read once, and their deleted conversations are imported (de-duplicated, keeping the most complete copy).
- **Context-compaction calls were not counted.** Checkpoint / compaction summary calls are recorded only in step metadata, not in `gen_metadata`, so their tokens and cost were missing from both History and the current conversation. They are now included, de-duplicated by response id, with the model resolved from the conversation's own model ids.
- **Offline cost estimates were far from synced prices.** The built-in price table was stale: it had no Gemini 4, Gemini 3.6–3.8 Flash or Claude Opus 5.5 entries (so they fell back to older families and showed `≈`), still listed Claude Opus 4.5 / 4.6 at $15 / $75, and used outdated cache-read prices. The table now mirrors the public LiteLLM list (2026-11-22), so prices before and after **Sync prices** match.
- Unreleased Gemini 4 tier ids (e.g. `gemini-pro-orchestrator-neon`) are estimated from their own tier (Gemini 4 Neon) instead of Gemini 2.5 Pro; unknown Flash / Pro ids use Gemini 3.8 Flash / 3.1 Pro.
- **Long-context pricing.** Models with an above-200k tier (Gemini 2.5 Pro, 3 Pro, 3.1 Pro) are billed at the higher rate for calls whose prompt (input + cache read) exceeds 200k tokens; synced LiteLLM tiers are kept.

### Changed

- **Pure Node.js 24+.** Removed the Python fallback scripts, Python tests and Python CI jobs.
- Backend split into `sidecars/agy-lens/lib/{pb,context,history,quota,pricing,catalog}.mjs`; frontend split into `sidecars/agy-lens/web/` modules.
- `/app.js` is now served as one bundled classic script (`lib/web-bundle.mjs`), fixing the panel staying on "Loading…" in Antigravity's sidecar WebView. Startup errors are shown in the panel.
- `plugin.json` gained `displayName`, `author`, `homepage`, `repository` and `license`.
- Installers install to `~/.gemini/config/plugins/agy-lens` and clean up folders left by older versions.

### Removed

- The previous project name and the `sidecars/` single-folder layout.

## [2.1.1] - 2026-11-21

### Changed

- **Dynamic Quota model picker, thinking levels & pool grouping** (`sidecars/context/main.mjs`): `visibleModelIds()` now follows `agentModelSorts` strictly (with `clientModelSorts` and non-hidden `clientModelConfigs` fallbacks), respects `hidden` / `disabled` / `deprecated` flags, orders `groupedModels` thinking levels strictly by server `supportedThinkingLevels`, dynamically groups multi-variant parenthetical models (e.g. `Orchestrator` → `Neon · Carbon · Argon`, while keeping single variants like `GPT-OSS 120B (Medium)` intact), separates quota pools by provider bucket to prevent collisions at 100%, preserves dynamic provider and custom `RetrieveUserQuotaSummary` group labels, and refreshes `quota-raw.json` & `model-catalog.json` on startup and manual refresh.
- **Live model-catalog attribution across engines** (`sidecars/context/history_scanner.mjs`, `history_scanner.py`, `context_report.mjs`, `context_report.py`, `app.js`): `scan()` and `collectSession()` / `collect_session()` now accept `--model-catalog` (`modelCatalogPath`) for dynamic pool attribution and display-name fallback; generalized family pricing fallbacks (`previewTarget`); fixed `inferPool` and `modelPool` so Claude/OpenAI models (including Claude Orchestrators) are always classified into `claude_gpt` before generic `orchestrator`.

### Removed

- Removed the in-panel onboarding welcome card, top-bar `?` help button, and glossary drawer (`sidecars/context/index.html`, `styles.css`, `app.js`, `README.md`) for a cleaner top bar, keeping actionable empty / error states and pricing sync feedback.

## [2.1.0] - 2026-11-21

### Added

- **Zero-Python pure Node.js engine** (`sidecars/context/pb.mjs`, `context_report.mjs`, `history_scanner.mjs`): runs in-process on Antigravity 2.0's bundled Node 24 (`node:sqlite`), removing the Python installation requirement and subprocess overhead (optional Python scripts kept as CLI / fallback).
- **Direct-install ZIP & one-line installers**: `scripts/build-release.mjs` builds `antigravity-pulse.zip` (only the 13 runtime files, zero Python), `scripts/install.ps1` (Windows) and `scripts/install.sh` (macOS / Linux) install with one command and no Git/Python needed, and `.github/workflows/release.yml` attaches release archives automatically on tag push.
- **Beginner onboarding & friendly UX**: first-run welcome card (`ctx.onboarded`), toggleable `?` quick guide & glossary drawer in the top bar, actionable empty / error / troubleshooting states with tab shortcuts and retry buttons, and a clear status toast after syncing public model prices.
- **Overview weekly quota consumption**: Overview → *This conversation* now displays this conversation's estimated weekly quota consumption (`≈ X% weekly` / `% of 7d usage`, plus multi-pool breakdown when needed), backed by `pool`, `d7_tokens`, and `d7_by_pool` on `session` in both Node and Python engines.
- **Native engine & cross-engine parity tests** (`tests/test_native_engine.mjs`).

### Changed

- Updated CI to run Node 24 tests, native engine parity tests, and direct-install ZIP smoke builds.
- Rewrote `README.md` to put 30-second installation, 3-step onboarding, and FAQ first.

## [2.0.0] - 2026-11-20

Released as its own project, **antigravity-pulse** ("Pulse").

### Added

- Tabbed panel (**Overview**, **Quota**, **History**) with a unified top-bar inline SVG refresh icon, segmented `中 | EN` toggle (Chinese by default), custom SVG chevron disclosures, and hybrid auto-refresh (Overview 3s; Quota & History 65s silent auto-refresh + visibility/focus refresh; Quota one-shot post-reset refresh).
- **Output Speed** on Overview: streaming speed (with short/buffered-burst outlier filtering, `median_streaming_tps`, `buffered` flag), end-to-end speed, time to first token (TTFT), cache hit rate, recent-call bars, and this reply's output tokens (thinking / response split), plus a per-model breakdown when multiple models appear in a conversation.
- **This conversation** block on Overview: input, output, cache-read and thinking tokens, calls, cache hit rate, time span, public-price USD cost estimate (`≈` when same-family estimated), and per-model breakdown (`session` in `context_report.py --json`).
- **Quota** tab: per-category pools (Claude / GPT-OSS models, Gemini models, Tab completion) from the app's local language server (`RetrieveUserQuotaSummary`, `GetUserStatus`, `GetAvailableModels`), displaying both official **Weekly** and **5-hour** limits (with inferred fallback if summary buckets are unavailable), 20-dot meter, used / remaining percentage, live reset countdown, deduplicated model families with thinking levels, collapsible hidden models, and current tier / plan (`/api/quota`).
- **History** tab with three categorized sub-views across desktop and CLI conversations (`history_scanner.py`, `/api/history`, incremental cache, up to 500 recent conversations):
  - **Totals**: period pills (Today / 7d / 30d / All), stat grid, period-adaptive activity heatmap (`hourly_today` for Today, 7d, 30d, multi-month All), and merged Top 5 models (expandable).
  - **By session**: conversations ranked by usage with period and hide-subagents filters, proportional bars, pagination, and expandable details.
  - **Session list**: chronological list with live search, sort switch, Desktop / CLI filter, hide-subagents toggle, and expandable details.
- **Per-pool weekly quota attribution**: automatically reads official per-pool weekly limits from `RetrieveUserQuotaSummary` (`weekly` on `/api/quota`, paired with `d7_by_pool`) to estimate per-model and per-conversation weekly quota consumption (`≈ 周额度 X%` / `≈ X% weekly`), falling back to optional manual calibration (`ctx.weeklyLeft`) or unambiguous 7-day share (`占近7天已用 X%` / `X% of 7d usage`) if weekly buckets are unavailable.
- **Opt-in public pricing sync** (`/api/pricing`, `--pricing-file`): fetches public model prices from LiteLLM (primary) or OpenRouter (fallback) only when requested, caches locally for 24h (`pricing-cache.json`), falls back to built-in offline list prices, and marks same-family preview estimates with `≈` (`cost_estimated`).
- Request budget indicator on Overview.
- WebView cache busting: `Cache-Control: no-store, no-cache, must-revalidate` on static panel assets plus dynamic mtime/size query stamping (`?v=...`) for `styles.css` and `app.js`.
- Node tests for backend helpers (`tests/test_main_helpers.mjs`) and GitHub Actions CI on Ubuntu, Windows and macOS.

### Changed

- Plugin renamed from `desktop-context` ("Context Usage") to `antigravity-pulse` ("Pulse"); install folder is now `~/.gemini/config/plugins/antigravity-pulse`.
- Panel front end split into `index.html`, `app.js` and `styles.css`.

## [1.0.0]

Original **Context Usage** panel by Dimitrios Ioannidis
([dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context)).

- The agy CLI's `/context` report as a live side panel: usage grid, token usage by category, checkpoints and files in context.
- Context window and model name from the app's live model catalog, with a built-in fallback table.
- Zero tokens per refresh; conversation databases opened read-only.

[2.2.0]: https://github.com/Aoike123/agy-lens/releases/tag/v2.2.0
[2.1.1]: https://github.com/Aoike123/agy-lens/releases/tag/v2.1.1
[2.1.0]: https://github.com/Aoike123/agy-lens/releases/tag/v2.1.0
[2.0.0]: https://github.com/Aoike123/agy-lens/releases/tag/v2.0.0
[1.0.0]: https://github.com/dimitr-io/antigravity-desktop-context
