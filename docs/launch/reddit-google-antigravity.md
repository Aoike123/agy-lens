# r/google_antigravity launch post

**Flair:** Tool / Showcase

**Title:** I built Agy Lens: exact context window, live tok/s, 5h/weekly quotas + weekly quota value tracking for Antigravity 2.0 in one local side panel

**Image:** `docs/img/hero-en.png` (or a 10-second GIF switching Overview → Quota → History)

---

I kept hitting two annoying walls mid-task in Antigravity 2.0: getting cut off by the 5-hour limit without warning, and having no idea how much of my weekly quota a multi-subagent project actually burned (or whether my weekly allowance changed after a reset).

So I built **Agy Lens** — a free, MIT-licensed local side panel & CLI that runs directly on Antigravity's built-in Node.js 24:

- **Context window by category** (Overview): exact `/context` accounting from Antigravity's recorded token groups, 100-dot map, request-budget trimming warning, live streaming `tok/s` / TTFT / cache hit per model, and this conversation's `≈ X% weekly` size (including subagents).
- **Official 5h & weekly quotas + shrinkage tracking** (Quota): live 20-dot meters and reset countdowns per pool, plus an implied **100% weekly quota dollar value** anchored strictly to each official `[reset_time - 7d, reset_time)` cycle so you can compare week-over-week changes across resets.
- **History & Share Card** (History): desktop + CLI totals (`Today / 7d / 30d / All`), adaptive heatmap, period-scoped model rankings, top-level conversation trees rolling up multi-level subagents & pruned DB archives, per-project `≈ X% weekly` sizing, and one-click clipboard copy for a sanitized PNG/SVG share card (zero titles or paths).
- **Terminal CLI**: `npx github:Aoike123/agy-lens` (or `--json`).

Zero npm dependencies, zero Python, read-only SQLite, zero tokens per refresh, and no external network requests unless you click **Sync prices** (LiteLLM / OpenRouter).

Install (Windows PowerShell):

```powershell
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

Repo: https://github.com/Aoike123/agy-lens

Feedback welcome — especially if your plan shows different quota pools or model tiers! If you find it useful, a ⭐ helps other Antigravity users discover it.
