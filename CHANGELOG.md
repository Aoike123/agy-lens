# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-20

Released as its own project, **antigravity-usage-dashboard** ("Usage Dashboard").

### Added

- Tabbed panel: **Overview**, **Quota**, **History**, with a 中文 / English language toggle (Chinese by default).
- **Output Speed** on Overview: streaming speed, end-to-end speed, time to first token, cache hit rate over the last calls, and this reply's output tokens (thinking / response split), with a per-model breakdown when a conversation uses several models.
- **This conversation** block on Overview: input, output, cache-read and thinking tokens, calls, cache hit rate, reference cost and per-model breakdown over every model call of the open conversation (`session` in `context_report.py --json`).
- **Quota** tab: per-category pools (Claude / GPT-OSS models, Gemini models, Tab completion) from the app's language server, with limit kind (5-hour, daily, weekly…), used / remaining percentage, reset countdown, deduplicated model list and current plan (`/api/quota`).
- **History** tab: totals for Today / Last 7 days / Last 30 days / All time, by model, by conversation (with official titles), daily activity heatmap and reference cost, across desktop and CLI conversations (`history_scanner.py`, `/api/history`) with an incremental cache.
- Request budget indicator on Overview.
- Node tests for backend helpers (`tests/test_main_helpers.mjs`), CI on Linux, Windows and macOS.

### Changed

- Plugin renamed from `desktop-context` ("Context Usage") to `antigravity-usage-dashboard` ("Usage Dashboard"); install folder is now `~/.gemini/config/plugins/antigravity-usage-dashboard`.
- Panel front end split into `index.html`, `app.js` and `styles.css`.

## [1.0.0]

Original **Context Usage** panel by Dimitrios Ioannidis
([dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context)).

- The agy CLI's `/context` report as a live side panel: usage grid, token usage by category, checkpoints and files in context.
- Context window and model name from the app's live model catalog, with a built-in fallback table.
- Zero tokens per refresh; conversation databases opened read-only.

[2.0.0]: https://github.com/<OWNER>/antigravity-usage-dashboard/releases/tag/v2.0.0
[1.0.0]: https://github.com/dimitr-io/antigravity-desktop-context
