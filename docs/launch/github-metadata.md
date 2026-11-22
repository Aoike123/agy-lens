# GitHub repository metadata & release playbook

Set these on `https://github.com/Aoike123/agy-lens` after renaming the repository (Settings → General → Repository name: `agy-lens`; GitHub redirects old repository URLs automatically).

## About description (≤ 350 chars)

```
All-in-one local cockpit & CLI for Antigravity 2.0: exact context window by category, live tok/s, 5-hour & weekly quotas, implied 100% weekly quota value & shrinkage history, subagent tree cost, and sanitized share cards. Pure Node.js 24, zero deps, local & read-only.
```

Website: `https://github.com/Aoike123/agy-lens#readme`

## Topics

```
antigravity
google-antigravity
antigravity-plugin
agy
agy-lens
gemini
claude
llm
ai-coding
coding-agent
context-window
token-usage
cost-tracking
quota-monitor
rate-limit
usage-tracker
cli
developer-tools
nodejs
zero-dependency
```

## Social preview

Settings → General → Social preview → upload `docs/img/social-preview.png` (1280×640).

## Release & growth checklist (`v2.2.0`)

1. Rename GitHub repository to `agy-lens` and update local remote:
   ```bash
   git remote set-url origin https://github.com/Aoike123/agy-lens.git
   git push -u origin main
   git push origin v2.2.0
   ```
2. Pushing tag `v2.2.0` triggers `.github/workflows/release.yml`, which attaches `agy-lens.zip`, `agy-lens-v2.2.0.zip`, `SHA256SUMS.txt`, and changelog-backed release notes with `docs/img/hero-en.png`.
3. Configure GitHub **About** description, website URL, all 20 Topics, and upload `docs/img/social-preview.png`.
4. Open a pinned issue (`Roadmap & feedback`) asking which Antigravity quota pools, models, or CLI flags users want next.
5. Publish launch posts in order with visuals (`hero-en.png` / `hero-zh.png` + `share-card.png`):
   - `docs/launch/reddit-google-antigravity.md` (`r/google_antigravity`)
   - `docs/launch/x-twitter.md` (5-post thread)
   - `docs/launch/v2ex.md` (`/go/create`) & `docs/launch/linux-do.md`
   - `docs/launch/awesome-antigravity-pr.md` (PR to awesome lists once `v2.2.0` release is live)
