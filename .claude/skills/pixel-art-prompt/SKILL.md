---
name: pixel-art-prompt-optimizer
description: 优化和扩充AI生成像素画（Pixel Art）的提示词。适用于游戏素材、UI图标、角色精灵、地图瓦片等像素美术生成场景。自动添加透明背景约束、硬像素边缘规则、标准尺寸规格、负面提示词黑名单等核心约束。
---

# Pixel Art Prompt Optimizer

Optimize and expand prompts for AI-generated pixel art assets for game development.

## Purpose

Transform simple pixel art descriptions into comprehensive, production-ready prompts that ensure:
- True transparent backgrounds with clean edges
- Authentic hard-pixel aesthetics (no anti-aliasing, no smoothing)
- Standardized game asset dimensions
- Style consistency across entire asset libraries

## When to Use

Use this skill when:
- Generating pixel art game assets (characters, items, tiles, UI icons)
- Creating assets for 16-bit retro style games
- Building pixel art sprite sheets or tilesets
- Making icons, buttons, or UI elements in pixel style
- Any AI image generation for game development purposes

## IMPORTANT: Requirement Confirmation Workflow (MANDATORY)

**BEFORE generating any prompts, ALWAYS follow this workflow:**

### Step 1: Ask Clarifying Questions First

When the user provides an incomplete or general request, **STOP and ask questions** before generating prompts. Use the question template below to gather essential information.

### Essential Questions to Ask:

1. **Usage/Purpose** (必问):
   - "这个像素图是用于什么场景？"（游戏角色/UI图标/道具/地图瓦片/立绘等）
   - "是静态立绘还是需要包含动作帧？"

2. **Dimensions** (必问):
   - "需要的尺寸是多少？"
   - 提供选项: 16x16px / 32x32px / 64x64px / 128x128px

3. **View/Perspective** (必问):
   - "需要什么视角？"（正面/侧面/背面/俯视/等距视角）

4. **Style Variant** (建议问):
   - "想要什么像素风格？"（8-bit复古/16-bit经典/现代像素风）

5. **Additional Details** (根据需要问):
   - "有什么特别的设计要求吗？"（颜色偏好/特殊道具/角色特征等）

### Step 2: Analyze Completeness

| User Input Level | Action |
|-----------------|--------|
| Vague/General ("帮我生成一个角色") | Ask questions until clear |
| Partial ("一个骑士") | Ask about missing details |
| Detailed description | Proceed to prompt generation |
| "你自己设计"/"随便"/"你来" | Creative freedom mode - design based on typical defaults |

### Step 3: Design Only When Authorized

- **Do NOT design freely** unless user explicitly says so
- **Do NOT assume details** not provided by the user
- **Wait for confirmation** of requirements before generating

### Question Template

When asking for clarification, use this friendly format:

```
主人~ 小奈需要先了解一些设计细节才能帮您生成完美的提示词喵~

1. 【用途】这个像素图是用于？
   - [ ] 游戏角色精灵（需要动作帧）
   - [ ] 静态立绘/头像
   - [ ] UI图标/道具
   - [ ] 地图瓦片/背景元素
   - [ ] 其他：___

2. 【尺寸】需要什么像素尺寸？
   - [ ] 16x16px（小型元素/粒子）
   - [ ] 32x32px（图标/小道具）
   - [ ] 64x64px（主角/NPC）
   - [ ] 128x128px（大型角色/细节素材）
   - [ ] 其他：___

3. 【视角】需要什么角度/视角？
   - [ ] 正面
   - [ ] 侧面
   - [ ] 背面
   - [ ] 俯视
   - [ ] 等距视角
   - [ ] 不限

4. 【风格】想要什么像素风格？
   - [ ] 8-bit 复古（颜色少、像素粗）
   - [ ] 16-bit 经典（颜色丰富、细节适中）
   - [ ] 现代像素风
   - [ ] 不限

5. 【描述】请描述您想要的画面内容~
   （角色外观/道具/颜色/氛围等，越详细越好喵~）
```

## Core Constraints (Always Enforced After Confirmation)

### 1. Transparent Background Requirements

**Mandatory positive keywords:**
```
transparent background, alpha channel, no background, empty background, isolated object
```

**Forbidden (always add to negative prompt):**
```
no white background, no black background, no gradient background
no fringe, no halo edge, no semi-transparent stray pixels
no matte edge, no border glow, no residual background color
```

### 2. Pixel Art Style Constraints

**Mandatory positive keywords:**
```
crisp hard pixel edges, no anti-aliasing, game assets, clean pure pixels, high contrast
```

**Forbidden:**
```
no anti-aliasing, no soft edge, no blurring, no smooth pixel
no pixel stretching, no pixel displacement, no irregular pixel blocks
no 3d, no realistic, no smooth shading
```

### 3. Light/Shadow/Effects Forbidden

**Always include in negative prompt:**
```
no shadow, no highlight, no glow, no texture, no ambient light
no gradient shading, no ambient occlusion
no particles, no fog, no filter effects
```

### 4. Extra Elements Forbidden

**Always include:**
```
no extra decoration, no pattern, no frame, no surrounding scenery
no redundant details, no grass, no sky, no ground
```

### 5. Distortion/Deformation Forbidden

**Always include:**
```
no distortion, no malformation, no broken parts, no forced perspective
no deformed, no asymmetric, no extra limbs
```

### 6. Text/Watermark/Noise Forbidden

**Always include:**
```
no text, no numbers, no letters, no watermark, no signature
no noise stain, no noise dots, no color stains
```

## Standard Asset Dimensions

Always specify exact pixel dimensions in prompts:

| Asset Type | Dimensions | Additional Keywords |
|------------|------------|---------------------|
| UI icons, consumables, small enemies | 32x32px | minimalist, single item, game ui icon |
| Protagonist, elite monsters | 64x64px | game character sprite, simple outline |
| Map tiles, ground elements | 16x16px / 32x32px | seamless tileable, rpg map tileset |
| Effect particles | 16x16px / 32x32px | small detail, particle effect |
| Large characters/Bosses | 128x128px | boss sprite, detailed character |

**Critical:** Lock resolution in AI settings. Never generate large images for downscaling.

## Prompt Generation Workflow (After Requirements Confirmed)

### Step 1: Extract Core Intent

Parse user's confirmed description to identify:
- Asset type (character, item, tile, UI, effect)
- View perspective (side view, top-down, isometric)
- Style variant (retro 8-bit, 16-bit, modern pixel)
- Required dimensions

### Step 2: Apply Base Template

Select appropriate base template from `references/prompts.md`:
- General base for all assets
- Character-specific additions
- Tile/environment additions
- UI/item additions

### Step 3: Inject User Requirements

Merge user's specific request with base template:
- Keep user's core concept/intent
- Fill in missing constraints from templates
- Ensure dimension specifications match asset type

### Step 4: Generate Negative Prompt

Combine all forbidden keywords from sections 1-6 above:
- Minimum: Core 6 categories
- Enhanced: Full blacklist from `references/prompts.md`

### Step 5: Final Assembly

Structure output as:
```
[Style Base] + [Subject Description] + [View/Dimension] + [Positive Constraints]
---
Negative: [Combined Forbidden Keywords]
```

### Step 6: Present Results

Present optimized prompts in this format:

**Optimized Positive Prompt:**
```
[pasted optimized positive prompt]
```

**Negative Prompt (Blacklist):**
```
[pasted complete negative prompt]
```

**Recommended Dimensions:**
```
[exact dimensions]
```

**Design Summary:**
```
[brief summary of what this prompt will generate]
```

### Creative Freedom Mode

When user says "你自己设计"/"随便"/"你来" or similar:
- Design based on typical defaults for the asset type
- Use most common dimensions (64x64 for characters, 32x32 for items)
- Apply standard 16-bit style
- Still provide the structured output

## Quick Reference Templates

### Universal Base (All Assets)
```
16-bit retro pixel art, crisp hard pixel edges, no anti-aliasing,
game assets, isolated object, transparent background, alpha channel,
no background, empty background, clean pure pixels, high contrast,
web game design
```

### Side-View Character
```
16-bit retro pixel art, side view, [character description],
64x64px, game character sprite, simple outline,
crisp hard pixel edges, no anti-aliasing, transparent background
```

### Top-Down Tileset
```
top-down view, rpg game tile, seamless tileable,
[32x32px or 16x16px], rpg map tileset,
flat pixel art, transparent background
```

### UI Icon
```
minimalist pixel art, game ui icon, [item description],
32x32px, single item, clean design,
transparent background, alpha channel
```

## Complete Negative Prompt (One-Click Copy)

See `references/prompts.md` for the complete, production-ready negative prompt blacklist that combines all forbidden categories into a single copy-paste block.

---

For detailed prompt templates, category-specific keywords, and the complete negative prompt blacklist, refer to `references/prompts.md`.
