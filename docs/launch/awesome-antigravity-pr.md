# Awesome-list pull request

**Target:** https://github.com/ZhangYu-zjut/awesome-Antigravity (check that the list is still active, read its CONTRIBUTING, and match the exact section names and entry format before opening the PR; other Antigravity awesome lists can reuse the same text)

**Section:** Plugins / Extensions (or Tools / Monitoring, whichever exists)

**Entry:**

```markdown
- [Agy Lens](https://github.com/Aoike123/agy-lens) - All-in-one local cockpit & CLI for Antigravity 2.0: exact context window, live tok/s, 5h & weekly quotas with implied `$` value, multi-cycle waste tracker & opt-in auto-wake, project subagent spend, and 6-style WebGL/Pixel share cards (Live Photo/MP4/GIF). Pure Node.js 24, 0 deps.
```

**PR title:** `Add Agy Lens (context, speed, quota value/utilization, share cards & CLI)`

**PR body:**

```markdown
Adds [Agy Lens](https://github.com/Aoike123/agy-lens), an MIT-licensed side-panel plugin & terminal CLI for the Antigravity 2.0 desktop app.

- Exact context window breakdown (same accounting as `agy /context`) + request-budget trimming alert
- Streaming tok/s, time to first token, and cache hit rate per model
- Official 5-hour and weekly quotas with countdowns, implied 100% cycle dollar value & shrinkage history, multi-cycle utilization (`Used / Total`, `Past unused`), in-cycle burn-rate drill-down, and opt-in per-pool auto-wake (OFF by default)
- Desktop + CLI usage history with project grouping, subagent tree rollups, pruned DB archiving, and time-locked per-project weekly `%`
- 6-style sanitized WebGL & Pixel Hero share cards (Dark/Light, Live Photo / MP4 / GIF / PNG / SVG)
- Pure Node.js 24 (`npx github:Aoike123/agy-lens`), zero dependencies, read-only by default, SHA-256-verified in-panel updates

Placed alphabetically in the section; happy to move it if another section fits better.
```
