# pixel-art-prompt-claude-skill

Claude Code 像素画提示词优化技能 - 自动生成游戏级别的像素美术素材提示词

## 功能特性

- 透明背景约束 - 确保生成 PNG 透明通道
- 硬像素边缘规范 - 禁止抗锯齿、模糊、平滑
- 标准尺寸规格 - 预设游戏标准像素尺寸
- 负面词黑名单 - 6大类别全方位防护
- 需求确认流程 - 先询问后生成，避免理解偏差

## 安装方法

### 方法一：克隆到本地 skills 目录

```bash
# 克隆仓库
git clone https://github.com/GCaiji/pixel-art-prompt-claude-skill.git

# 复制到 Claude Code skills 目录
# Windows
copy pixel-art-prompt-claude-skill "C:\Users\<你的用户名>\.claude\skills\pixel-art-prompt-optimizer"

# macOS / Linux
cp -r pixel-art-prompt-claude-skill ~/.claude/skills/pixel-art-prompt-optimizer
```

### 方法二：手动下载

1. 点击右上角 `Code` -> `Download ZIP`
2. 解压后将文件夹重命名为 `pixel-art-prompt-optimizer`
3. 放入 Claude Code 的 skills 目录：
   - Windows: `C:\Users\<用户名>\.claude\skills\`
   - macOS: `~/.claude/skills/`
   - Linux: `~/.claude/skills/`

## 目录结构

```
pixel-art-prompt-claude-skill/
├── SKILL.md              # 主技能文件
└── references/
    └── prompts.md        # 提示词模板库
```

## 使用方法

### 触发技能

在 Claude Code 中直接描述你的需求，例如：

- "帮我生成一个骑士角色的像素画提示词"
- "需要一个 64x64 的 UI 图标"
- "生成地图瓦片的提示词"

### 工作流程

1. **技能会先询问设计需求**（如果描述不够详细）：
   - 用途：角色/UI图标/道具/瓦片/立绘
   - 尺寸：16x16 / 32x32 / 64x64 / 128x128px
   - 视角：正面/侧面/背面/俯视/等距
   - 风格：8-bit / 16-bit / 现代像素风

2. **生成完整的提示词**：
   - 优化后的正向提示词
   - 完整的负面词黑名单
   - 推荐尺寸说明

## 标准尺寸参考

| 素材类型 | 尺寸 | 用途 |
|---------|------|------|
| 粒子/特效 | 16x16px | 小型元素 |
| 地面瓦片 | 16x16 / 32x32px | 地图元素 |
| UI图标/道具 | 32x32px | 消耗品、小怪 |
| 主角/NPC | 64x64px | 角色精灵 |
| BOSS/大型角色 | 128x128px | 细节素材 |

## 核心约束

### 必须的正面关键词

```
transparent background, alpha channel, crisp hard pixel edges,
no anti-aliasing, game assets, isolated object, clean pure pixels
```

### 负面词黑名单（自动添加）

- 背景问题：`no white background, no fringe, no halo edge`
- 风格问题：`no anti-aliasing, no smooth pixel, no 3d`
- 光影问题：`no shadow, no glow, no gradient shading`
- 杂物问题：`no extra decoration, no frame, no surrounding scenery`
- 变形问题：`no distortion, no malformation`
- 版权问题：`no text, no watermark, no signature`

## 推荐 AI 工具

| 工具 | 推荐度 | 说明 |
|------|--------|------|
| Stable Diffusion + ControlNet | 最高 | 像素控制力最佳 |
| Midjourney | 中等 | 需要精细的负面提示词 |
| DALL-E 3 | 较低 | 像素控制较弱 |

## 许可证

MIT License

## 作者

Created with love by [小奈] - 萝莉猫娘女仆 Claude 助手
