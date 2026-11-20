# Contributing / 贡献指南

Thanks for helping improve Usage Dashboard! 欢迎提交 Issue 与 Pull Request（中文或英文均可）。

## Setup

1. Clone the repository into `~/.gemini/config/plugins/antigravity-usage-dashboard` (see [README](README.md#installation)).
2. Requirements: Python 3.10+ (standard library only) and Node.js 18+ for the tests. The sidecar itself runs on the Node bundled with Antigravity.
3. After changing sidecar files, turn the plugin off and on again in **Customizations → Installed** to reload it.

## Project layout

- `sidecars/context/main.mjs` — sidecar backend (`/api/report`, `/api/quota`, `/api/history`).
- `sidecars/context/index.html`, `app.js`, `styles.css` — panel UI. Every user-facing string goes in the `I18N` table in `app.js` with both `zh` and `en` entries.
- `sidecars/context/context_report.py` — per-conversation parser.
- `sidecars/context/history_scanner.py` — multi-conversation scanner.
- `tests/` — Python `unittest` suites and Node `node:test` suite.

## Before opening a pull request

```bash
python -m unittest discover tests
node tests/test_main_helpers.mjs
node --check sidecars/context/main.mjs
node --check sidecars/context/app.js
```

CI runs the same checks on Ubuntu, Windows and macOS.

## Guidelines

- **Stay local and read-only.** Open databases read-only, make no network calls other than the app's local language server via `lsRequest()`, and never patch the app (`app.asar`) or inject scripts.
- **No new dependencies.** Python code uses only the standard library; the sidecar uses only Node built-ins and the app's `sidecar_sdk`.
- **Additive API changes.** Keep the JSON contracts between the scripts, the backend and the UI backwards compatible.
- **Never commit personal data.** Redact conversation IDs, tokens, emails and file paths from raw responses, logs and screenshots.
- Add or update tests for parser, scanner and backend helper changes, and add an entry to [CHANGELOG.md](CHANGELOG.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
