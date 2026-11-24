---
name: game-art-prompt-kit
description: 游戏美术构图提示词档案库（14 个档案，中英双语，带示例图）。为像素精灵表、角色动作表、俯视/斜俯视场景、横版与街机场景背景挑选并改写构图模板时使用。本项目分享卡美术选定其中三套：横版街机决斗场、斜俯视小镇、基于角色参考图的侧视动作。
---

# Game Art Prompt Kit

可复用的游戏美术提示词档案。每个档案是一份独立 Markdown：用途、使用场景（纯文字生成 / 参考图驱动 / 两者兼备）、示例图和可复制的模板。

本技能只提供**构图模板**。像素尺度、硬边、透明边缘、负面词等通用约束由 `pixel-art-prompt` 技能负责；角色动画的锁母版、单方向单动作、脚底对齐和缩小验收由 `game-character-sprites` 技能负责。

## 使用方法

1. 读 [README.zh-CN.md](README.zh-CN.md) 的档案表，按用途和使用场景选档案。
2. 打开 `profiles/zh-CN/<档案>.md`（英文在 `profiles/en/`），先看「使用场景」，再复制模板部分。
3. 替换占位字段；参考图驱动的档案需要上传参考图。
4. 对照 `img/<档案>.png` 的示例调整变量字段再迭代。

## 本项目选用的三套档案

| 用途 | 档案 |
|---|---|
| 横版街机决斗场（`art-src/arenas/`） | [parallax-sideview-arcade-environment](profiles/zh-CN/parallax-sideview-arcade-environment.md) |
| 斜俯视小镇（角色档案、挑战书背景） | [angled-topdown-pixel-scene](profiles/zh-CN/angled-topdown-pixel-scene.md) |
| 基于角色参考图的侧视动作 | [reference-based-sideview-action-sheet](profiles/zh-CN/reference-based-sideview-action-sheet.md) |

项目里每套档案具体贡献了什么，见 `docs/share-art-prompts.md` 的「规范来源」一节。

来源：lexlex47/game-art-prompt-kit，MIT 许可（见 [LICENSE](LICENSE)）。原先随 `pixel-art-prompt` 技能放在其 `references/` 目录下，在本项目里独立成技能，便于直接调用。
