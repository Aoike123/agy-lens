# Pixel Art Prompt Templates & Negative Blacklists

Complete reference for pixel art prompt optimization.

## Universal Base Prompt (Copy-Paste Ready)

### Positive Prompt - General Base

```
16-bit retro pixel art, crisp hard pixel edges, no anti-aliasing,
game assets, isolated object, transparent background, alpha channel,
no background, empty background, clean pure pixels, high contrast,
web game design
```

### Negative Prompt - Complete Blacklist

```
no white background, no black background, no gradient background,
no fringe, no halo edge, no semi-transparent stray pixels,
no matte edge, no border glow, no residual background color,
no anti-aliasing, no soft edge, no blurring, no smooth pixel,
no shadow, no highlight, no glow, no texture, no ambient light,
no gradient shading, no ambient occlusion,
no extra decoration, no pattern, no frame, no surrounding scenery,
no redundant details, no grass, no sky, no ground,
no text, no numbers, no letters, no watermark, no signature,
no noise stain, no noise dots, no color stains,
no distortion, no malformation, no broken parts, no forced perspective,
no 3d, no realistic, no smooth shading, no forced perspective
```

---

## Character Sprites

### Side-View Character (64x64px)

**Positive:**
```
16-bit retro pixel art, side view, [character description],
64x64px, game character sprite, simple outline,
crisp hard pixel edges, no anti-aliasing, transparent background,
alpha channel, isolated character, clean pixel work
```

**Negative:** Use Universal Negative + add:
```
no multi-frame animation, no sprite sheet layout
```

### Top-Down Character (64x64px)

**Positive:**
```
16-bit retro pixel art, top-down view, [character description],
64x64px, game character sprite, overhead perspective,
crisp hard pixel edges, no anti-aliasing, transparent background,
alpha channel, clean pure pixels
```

### Boss/Large Character (128x128px)

**Positive:**
```
16-bit retro pixel art, boss character, [enemy description],
128x128px, detailed pixel sprite, menacing pose,
crisp hard pixel edges, no anti-aliasing, transparent background,
alpha channel, high detail pixel art
```

---

## Tiles & Environment

### Ground Tile (32x32px)

**Positive:**
```
32x32px, rpg map tileset, ground tile, seamless tileable,
top-down view, [terrain type: grass/stone/dirt],
crisp hard pixel edges, no anti-aliasing, transparent background,
flat pixel art, no shading, no depth
```

### Wall/Brick Tile (32x32px)

**Positive:**
```
32x32px, seamless tileable, wall tile, brick texture,
side view, flat pixel, no 3d perspective,
crisp hard pixel edges, transparent background,
rpg map tileset
```

### Nature Element (Tree/Plant)

**Positive:**
```
pixel art tree, 32x32px, game asset, top-down view,
seamless tileable, green foliage, brown trunk,
crisp hard pixel edges, transparent background,
no shadow, no glow, no gradient
```

---

## UI & Items

### Small Icon (32x32px)

**Positive:**
```
32x32px, minimalist pixel art, game ui icon,
[item description], single item, clean design,
crisp hard pixel edges, transparent background,
alpha channel, no extra decoration
```

### Consumable Item (32x32px)

**Positive:**
```
32x32px, pixel art item, [potion/key/coin description],
game consumable, bright clear colors,
crisp hard pixel edges, transparent background,
alpha channel, isolated object
```

### Weapon/Tool (32x32px or 64x64px)

**Positive:**
```
[32x32px or 64x64px], pixel art weapon, [sword/axe/bow description],
game item, held item view, crisp hard pixel edges,
transparent background, alpha channel,
no glow, no enchantment effect, plain weapon
```

---

## Effects & Particles

### Small Particle (16x16px)

**Positive:**
```
16x16px, pixel art particle, [effect type: spark/poof/star],
small detail, game effect, transparent background,
crisp hard pixel edges, no anti-aliasing
```

### Explosion Effect (32x32px)

**Positive:**
```
32x32px, pixel art explosion, [explosion description],
game effect sprite, animated cycle ready,
crisp hard pixel edges, transparent background,
no smoke texture, no gradient, pure color pixels
```

---

## Category-Specific Additional Keywords

### 8-bit Style
```
8-bit style, nes style, simple color palette, limited colors,
chunky pixels, nostalgic retro
```

### 16-bit Style
```
16-bit style, snes genesis style, smooth animation ready,
rich but clean color usage
```

### Modern Pixel Art
```
modern pixel art, indie game style, clean pixel work,
high resolution pixel art (but still pixelated)
```

### Isometric
```
isometric pixel art, 2.5d perspective, clean isometric grid
```

---

## Common Mistakes to Prevent

### AI Pixel Art Problems & Solutions

| Problem | Prevention Keywords |
|---------|---------------------|
| White/fringe edges | no fringe, no halo, no matte edge |
| Anti-aliased smoothing | no anti-aliasing, no smooth pixel |
| Random shadows | no shadow, no ambient light |
| Gradient shading | no gradient shading, flat colors only |
| Background bleed | no residual background color, pure transparent |
| Texture/pattern overlay | no texture, no pattern |
| 3D appearance | no 3d, no realistic, flat 2d |
| Decorative extras | no extra decoration, no frame |
| Text/watermarks | no text, no watermark |
| Dimension stretching | Always specify exact px dimensions |
| AI upscaling artifacts | no blur, no smooth, sharp pixels only |

---

## Dimension Quick Reference

| Asset Type | Size | Grid |
|------------|------|------|
| Particles, tiny effects | 16x16px | Fine detail |
| Ground tiles, small elements | 16x16px or 32x32px | Standard |
| UI icons, items, small enemies | 32x32px | Medium |
| Player characters, NPCs | 64x64px | Large |
| Elite enemies, detailed items | 64x64px or 128x128px | Large |
| Bosses, major characters | 128x128px | Extra Large |

---

## AI Tool Recommendations

### Recommended
- **Stable Diffusion + ControlNet** - Best pixel control
- **Midjourney** - Good but requires careful negative prompting
- **DALL-E 3** - Limited pixel control

### Not Recommended
- **Midjourney** - Pixel control poor, transparent unstable
- **Adobe Firefly** - Too smooth, anti-aliasing issues

For best results: Use Stable Diffusion with pixel art LoRA or custom model trained on pixel art.
