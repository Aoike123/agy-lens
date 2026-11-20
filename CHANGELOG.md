# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-20

Released as its own project, **antigravity-usage-dashboard** ("Usage Dashboard").

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

- Plugin renamed from `desktop-context` ("Context Usage") to `antigravity-usage-dashboard` ("Usage Dashboard"); install folder is now `~/.gemini/config/plugins/antigravity-usage-dashboard`.
- Panel front end split into `index.html`, `app.js` and `styles.css`.

## [1.0.0]

Original **Context Usage** panel by Dimitrios Ioannidis
([dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context)).

- The agy CLI's `/context` report as a live side panel: usage grid, token usage by category, checkpoints and files in context.
- Context window and model name from the app's live model catalog, with a built-in fallback table.
- Zero tokens per refresh; conversation databases opened read-only.

[2.0.0]: https://github.com/Aoike123/antigravity-usage-dashboard/releases/tag/v2.0.0
[1.0.0]: https://github.com/dimitr-io/antigravity-desktop-context
