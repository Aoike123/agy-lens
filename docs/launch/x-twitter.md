# X / Twitter launch thread

Attach `docs/img/hero-en.png` to post 1 and `docs/img/en/share-card.png` to post 3.

**1/**
Antigravity 2.0 tells you that you hit the 5-hour limit. It doesn't tell you you're about to.

So I built Agy Lens: context window, live tok/s, 5h + weekly quotas and token spend in one local side panel.

Free, MIT, zero dependencies.
https://github.com/Aoike123/agy-lens

**2/**
What it shows:
• context by category (same accounting as agy /context)
• request-budget warning before history gets trimmed
• streaming tok/s + TTFT per model
• official 5h / weekly quotas with countdowns
• desktop + CLI history with estimated cost

**3/**
There's a share card too. Aggregate numbers only: no conversation titles, no paths.

My last 30 days 👇

**4/**
100% local and read-only. It runs on the Node that ships inside Antigravity, never calls a model, and refreshing costs zero tokens.

Windows:
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex

**5/**
Also works from the terminal:
npx github:Aoike123/agy-lens

If it saves you from a rate-limit surprise, a ⭐ helps others find it.
