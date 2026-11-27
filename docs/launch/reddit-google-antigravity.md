# r/google_antigravity launch post (v2.8.0)

**Flair:** Tool / Showcase

**Title:** I built Agy Lens v2.8 for Antigravity 2.0: exact context window, live tok/s, multi-cycle weekly quota waste & shrinkage tracker, opt-in auto-wake, and 6-style WebGL/Pixel RPG share cards (zero deps)

**Images:** Attach `docs/img/en/share-card.png` (lead image!) and `docs/img/hero-en.png` (or a short screen recording of the WebGL poster + Pixel Hero card).

---

I kept running into three frustrations while using Antigravity 2.0 heavily:

1. **Lazy-start weekly timers**: freshly reset pools sit at 100% and don't start their 7-day countdown until you send your first message in that pool.
2. **Zero visibility on plan ROI & shrinkage**: across 4 weekly cycles (400% total quota), how much did I actually use vs let expire unused? Did the implied `$` allowance shrink this week? Which project + subagent tree burned the most?
3. **Silent context trimming & 5-hour walls** mid-task.

So I built **Agy Lens** (MIT, pure Node.js 24 built into Antigravity, **0 npm dependencies, no Python**):

- **Overview (active chat)**: exact `/context` token breakdown (100-dot map), request-budget trimming alert, live streaming `tok/s` / TTFT / cache hit per model, and this conversation's time-locked `≈ X% weekly` share (including subagents).
- **Quota (limits, value & waste)**:
  - Official 5h + weekly meters with live countdowns and a clear `Starts on first use` hint.
  - **Multi-cycle utilization strip** (`Used / Total` · `Cycle left` · `Past unused`) right below each pool's cycle valuation chart so you can see wasted quota across resets and right-size your plan.
  - **Click-to-drill-down burn-rate phases** inside any cycle bar (spotting `≥ 1.4×` surges & peak concurrent chats).
  - **Opt-in per-pool Auto-wake** *(strictly OFF by default)*: when enabled, sends strictly 1 minimal tool-disabled prompt via the pool's cheapest model on reset and deletes the temp chat — backed by a persistent per-cycle circuit breaker & 12h cooldown so it can never loop.
- **History (projects & pruned archives)**: desktop + CLI totals (`Today / 7d / 30d / All`), **By project / Flat** grouping, multi-level subagent tree rollups, and local archiving when Antigravity prunes old DBs.
- **6-Style Share Cards (WebGL + Pixel Hero RPG)**: 5 editorial posters (**Mountain · Almanac**, **Abyssal · Trench**, **Eclipse · Astrolabe**, **Bauhaus · Overprint**, **Phosphor · Ribbon**) + a **Pixel · Hero** RPG card (13 classes, 6 usage stats, 12 achievements), all with Night & Day themes, 60fps WebGL preview, full-bleed modal, and zero-dependency **Live Photo (`.jpg`) / MP4 / WebM / GIF / PNG / SVG** export (aggregate stats only — zero conversation titles or paths).
- **Terminal CLI** (`npx github:Aoike123/agy-lens`) + one-click SHA-256-verified in-panel updates.

**30-second install:**

Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

macOS / Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

Repo: https://github.com/Aoike123/agy-lens

Would love to see what RPG class & weekly utilization everyone gets — feedback and PRs welcome!
