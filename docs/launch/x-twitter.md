# X / Twitter launch thread (v2.8.0)

Attach `docs/img/en/share-card.png` (or a 6s MP4 exported directly from Agy Lens!) to post 1, and `docs/img/hero-en.png` to post 2.

**1/**
I turned my Antigravity 2.0 token usage into 60fps WebGL art posters & a Pixel RPG hero card — inside a zero-dependency cockpit that also tracks context window, live tok/s, weekly quota shrinkage, and how much quota you let expire unused.

Meet **Agy Lens v2.8** (MIT, 0 deps): https://github.com/Aoike123/agy-lens

**2/**
Why I built it: Antigravity's weekly & 5h timers don't even start ticking until your first message in a pool, and you never see how much of your monthly quota went unused (e.g. 226% / 400%).

Agy Lens adds:
• Exact `/context` 100-dot breakdown + request-budget warning
• Live streaming tok/s & TTFT per model
• Multi-cycle `Used / Total` & `Past unused` waste tracker + click-to-drill burn-rate phases
• Opt-in per-pool Auto-wake (strictly OFF by default; 1 minimal cheapest-model ping + auto-delete)

**3/**
History & project attribution:
• Desktop + CLI totals across `Today / 7d / 30d / All`
• Group by Antigravity project + roll up multi-level subagent trees
• Archives deleted DBs automatically when Antigravity prunes old chats
• Time-locked `≈ X% weekly` sizing per project

**4/**
And the fun part — **6 sanitized Share Card styles** (Night & Day themes, zero titles or paths):
• Mountain · Almanac
• Abyssal · Trench
• Eclipse · Astrolabe
• Bauhaus · Overprint
• Phosphor · Ribbon
• Pixel · Hero (13 RPG classes, 6 stats, 12 achievements)

Exports straight to **Live Photo (.jpg), MP4, GIF, PNG, or SVG** with one-click clipboard copy.

**5/**
100% local, read-only by default, runs directly on Antigravity's built-in Node.js 24 (no npm packages, no Python), with one-click SHA-256 in-panel updates & a CLI (`npx github:Aoike123/agy-lens`).

Windows:
`irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex`

macOS / Linux:
`curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash`

Drop your Pixel Hero class below — and a ⭐ on GitHub helps other Antigravity users find it!
