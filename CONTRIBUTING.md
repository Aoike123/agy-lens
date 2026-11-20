# Contributing / 贡献指南

Thanks for helping improve Pulse (antigravity-pulse)! 欢迎提交 Issue 与 Pull Request（中文或英文均可）。

## Setup

1. Clone the repository into `~/.gemini/config/plugins/antigravity-pulse` (see [README](README.md#installation)).
2. Requirements: Node.js 24+ (for built-in `node:sqlite`, matching Antigravity's bundled runtime) and optionally Python 3.10+ (standard library only, for the parity test / fallback scripts).
3. After changing sidecar files, turn the plugin off and on again in **Customizations → Installed** to reload it.

## Project layout

- `sidecars/context/main.mjs` — sidecar backend (`/api/report`, `/api/quota`, `/api/history`, `/api/pricing`).
- `sidecars/context/pb.mjs` — shared protobuf wire decoder, read-only `node:sqlite` loader and date/number helpers.
- `sidecars/context/context_report.mjs` (and `.py`) — per-conversation parser.
- `sidecars/context/history_scanner.mjs` (and `.py`) — multi-conversation scanner.
- `sidecars/context/index.html`, `app.js`, `styles.css` — panel UI. Every user-facing string goes in the `I18N` table in `app.js` with matching `zh` and `en` entries.
- `scripts/build-release.mjs`, `install.ps1`, `install.sh` — zero-Python direct-install ZIP builder and one-line installers.
- `tests/` — Node `node:test` suites (`test_main_helpers.mjs`, `test_native_engine.mjs`) and Python `unittest` suites.

## Before opening a pull request

```bash
node --check sidecars/context/main.mjs
node --check sidecars/context/app.js
node --check scripts/build-release.mjs
node --test tests/test_main_helpers.mjs tests/test_native_engine.mjs
node scripts/build-release.mjs
python -m unittest discover tests
```

CI runs the same checks on Ubuntu, Windows and macOS.

## Guidelines

- **Stay local-first and read-only.** Open databases read-only, make no default network calls other than the app's local language server via `lsRequest()` (external requests must be explicit opt-in read-only fetches like `/api/pricing`, with zero user data sent), and never patch the app (`app.asar`) or inject scripts.
- **No new dependencies.** The sidecar uses only Node built-ins (`node:sqlite`, `node:zlib`, etc.) and the app's `sidecar_sdk`; Python fallbacks use only the standard library.
- **Additive API changes.** Keep the JSON contracts between the scripts, the backend and the UI backwards compatible.
- **Never commit personal data.** Redact conversation IDs, tokens, emails and file paths from raw responses, logs and screenshots.
- Add or update tests for parser, scanner and backend helper changes, and add an entry to [CHANGELOG.md](CHANGELOG.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
