# X / Twitter launch thread

Attach `docs/img/hero-en.png` to post 1 and `docs/img/en/share-card.png` to post 3.

**1/**
Antigravity 2.0 tells you that you hit the 5-hour limit. It doesn't tell you you're about to — or if your weekly quota silently shrank.

So I built Agy Lens: context window, live tok/s, 5h + weekly quotas, implied `$` value per weekly cycle, and project spend in one local side panel.

MIT, zero deps: https://github.com/Aoike123/agy-lens

**2/**
What it gives you without leaving your editor:
• Exact context breakdown (same numbers as `agy /context`) + request-budget warning
• Streaming tok/s & TTFT per model
• Official 5h + weekly limits with countdowns & week-over-week `$` valuation history
• Subagent tree rollups + per-project `≈ X% weekly` sizing

**3/**
Antigravity prunes older conversation DBs over time, so Agy Lens archives deleted sessions locally and recovers subagent totals too.

You can also one-click copy a sanitized Share Card (PNG / SVG) to your clipboard — aggregate numbers only, zero conversation titles or file paths. My 30d snapshot 👇

**4/**
100% local, read-only, zero tokens per refresh. It runs directly on the Node.js 24 bundled inside Antigravity — zero npm packages, zero Python.

Windows (30s):
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex

macOS / Linux:
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash

**5/**
Prefer the terminal? Same engine works as a CLI:
npx github:Aoike123/agy-lens

If Agy Lens saves you from a mid-task rate-limit surprise, a ⭐ on GitHub helps other Antigravity users find it!
