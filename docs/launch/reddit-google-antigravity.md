# r/google_antigravity launch post

**Flair:** Tool / Showcase

**Title:** I built Agy Lens: context window, tok/s and 5h/weekly quotas for Antigravity 2.0 in one local side panel

**Image:** `docs/img/hero-en.png` (or a 10-second GIF switching Overview → Quota → History)

---

I kept hitting the 5-hour limit mid-task and only noticing when Antigravity started trimming context, so I built a side panel that shows what's going on while I work.

**Agy Lens** is a free, MIT-licensed plugin for the Antigravity 2.0 desktop app:

- **Context window by category**, counted like the agy CLI's `/context` from the token data the app already records (not estimated from characters), plus a warning before the request budget starts trimming history
- **Live output speed**: streaming tok/s, time to first token, cache hit rate, split by model
- **Official 5-hour and weekly quotas** per pool with reset countdowns
- **History** across desktop + CLI conversations: totals, heatmap, subagent tree rollups, model ranking, estimated cost at public prices, project sizes against your implied 100% weekly quota value, and week-over-week quota value tracking
- **Share card** (SVG/PNG) with aggregate numbers only, and a terminal CLI (`npx github:Aoike123/agy-lens`)

It runs on the Node.js that ships with Antigravity, so there's nothing else to install. It only reads local databases (read-only), never calls a model, and makes no external requests unless you click "Sync prices".

Install (Windows):

```
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

macOS / Linux:

```
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

Repo: https://github.com/Aoike123/agy-lens

Feedback welcome, especially if your quota pools or models show up differently. The quota RPCs are undocumented, so reports from other plans help a lot.
