# Images

Every image here is rendered by `node scripts/render-screenshots.mjs` from synthetic, sanitized data
(`tests/fixtures/panel-fixtures.json`). No real conversation titles, account data or local paths appear in them.
Re-run the script after UI changes; it needs Node.js 24+ and a local Chrome or Edge.

| File | Size | Used in |
| --- | --- | --- |
| `hero-en.png` | 2800×1640 | `README.md`, above the fold |
| `hero-zh.png` | 2800×1640 | `README.zh-CN.md`, above the fold |
| `social-preview.png` | 1280×640 | GitHub → Settings → Social preview |
| `en/overview.png`, `en/quota.png`, `en/history.png` | 840×2080 (420 px panel at 2×) | English screenshots |
| `zh/overview.png`, `zh/quota.png`, `zh/history.png` | 840×2080 | Chinese screenshots |
| `en/share-card.png`, `zh/share-card.png` | 2400×1260 | Share card examples (30 days, dark theme) |
