# Awesome-list pull request

**Target:** https://github.com/ZhangYu-zjut/awesome-Antigravity (check that the list is still active, read its CONTRIBUTING, and match the exact section names and entry format before opening the PR; other Antigravity awesome lists can reuse the same text)

**Section:** Plugins / Extensions (or Tools / Monitoring, whichever exists)

**Entry:**

```markdown
- [Agy Lens](https://github.com/Aoike123/agy-lens) - All-in-one local cockpit & CLI for Antigravity 2.0: exact context window by category, live tok/s, 5-hour & weekly quotas with implied dollar value tracking, subagent tree rollups, and sanitized share cards.
```

**PR title:** `Add Agy Lens (context, speed, quota value & usage side panel + CLI)`

**PR body:**

```markdown
Adds [Agy Lens](https://github.com/Aoike123/agy-lens), an MIT-licensed plugin & CLI for the Antigravity 2.0 desktop app.

- Exact context window breakdown (same accounting as `agy /context`) + request-budget trimming alert
- Streaming tok/s, time to first token, and cache hit rate per model
- Official 5-hour and weekly quotas with countdowns + implied 100% weekly quota value & shrinkage history
- Desktop + CLI usage history with subagent tree rollups, pruned DB archiving, per-project weekly `%`, and sanitized SVG/PNG share cards
- Runs on Antigravity's bundled Node.js 24 (`npx github:Aoike123/agy-lens`), zero dependencies, read-only, no external requests by default

Placed alphabetically in the section; happy to move it if another section fits better.
```
