# Contributing / 贡献指南

Thanks for helping improve Agy Lens (`agy-lens`). Issues and pull requests are welcome in English or Chinese. 欢迎用中文或英文提交 Issue 与 Pull Request。

## Setup

1. Clone the repository into `~/.gemini/config/plugins/agy-lens`:

   ```bash
   git clone https://github.com/Aoike123/agy-lens.git ~/.gemini/config/plugins/agy-lens
   ```

2. Requirements: Node.js 24+ (for built-in `node:sqlite`, the same runtime Antigravity 2.0 ships). There are no npm dependencies and no Python.
3. After changing sidecar files, turn the plugin off and on again under **Customizations → Installed** to reload it.

No global Node? On Windows you can use the runtime inside Antigravity:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe" --test tests/*.mjs
```

## Project layout

See [docs/architecture.md](docs/architecture.md) for the full picture. In short:

- `sidecars/agy-lens/main.mjs`: sidecar backend (`/api/report`, `/api/quota`, `/api/history`, `/api/pricing`) and the bundled `/app.js`.
- `sidecars/agy-lens/lib/`: engines shared by the panel and the CLI (`pb`, `context`, `history`, `quota`, `catalog`, `pricing`, `web-bundle`).
- `sidecars/agy-lens/web/`: panel UI as ES modules. Every user-facing string goes into `web/i18n.js` with matching `en` and `zh` entries.
- `bin/cli.mjs`: terminal summary.
- `scripts/`: release builder, installers, screenshot renderer.
- `tests/`: `node:test` unit suites, `tests/e2e/` end-to-end suite, `tests/fixtures/` sanitized fixtures.

## Before opening a pull request

```bash
node --test tests/*.mjs
node tests/e2e/run.mjs
node scripts/build-release.mjs
```

If you changed the UI, regenerate the images with `node scripts/render-screenshots.mjs` (needs Chrome or Edge).

CI runs the checks on Ubuntu, Windows and macOS.

## Guidelines

- **Stay local-first and read-only.** Open databases read-only. The only default network calls go to the app's local language server; external requests must be explicit opt-in read-only fetches like the price sync, with no user data sent. Never patch the app or inject scripts.
- **No new dependencies.** Use Node built-ins only.
- **The panel must load as a classic script.** Keep `web/` imports relative and static so `lib/web-bundle.mjs` can bundle them.
- **Additive API changes.** Keep the JSON contracts between `lib/`, the backend, the UI and the CLI backwards compatible.
- **Never commit personal data.** Fixtures and screenshots use synthetic data only; no real titles, IDs, emails or paths.
- Add or update tests for engine and backend changes, and add an entry to [CHANGELOG.md](CHANGELOG.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
