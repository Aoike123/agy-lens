<div align="center">

<img src="assets/logo.svg" width="72" alt="Agy Lens logo">

# Agy Lens

**Antigravity 2.0 的一站式本地驾驶舱。**<br>
上下文窗口、实时 tok/s、5 小时与每周额度、Token 花费，一个零依赖的侧边面板全部看清。

[![CI](https://github.com/Aoike123/agy-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoike123/agy-lens/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Aoike123/agy-lens?label=release)](https://github.com/Aoike123/agy-lens/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

[English](README.md) · **简体中文**

<img src="docs/img/hero-zh.png" alt="Agy Lens 概览、额度、历史三个页签" width="100%">

</div>

这是一个专为桌面应用打造的本地用量监控与额度提醒侧边面板。再也不会被 5 小时限额突然卡住，也不会在不知情的情况下被裁掉上下文。Agy Lens 读取 Antigravity 本来就保存在你电脑上的数据，在对话旁边实时展示。刷新不消耗任何 Token，数据不出本机。

## 为什么选 Agy Lens

| | Agy Lens | [desktop-context](https://github.com/dimitr-io/antigravity-desktop-context) | [agy-context](https://github.com/ahmetdotsh/agy-context) + [agy-usage](https://github.com/ahmetdotsh/agy-usage) | 仅额度类扩展 |
| --- | :---: | :---: | :---: | :---: |
| 上下文按类别拆解 | ✅ | ✅ | ✅ | — |
| 流式 tok/s、首字延迟、缓存命中 | ✅ | — | 部分 | — |
| 官方 5 小时 **与** 每周额度及重置倒计时 | ✅ | — | — | ✅ |
| 桌面 + CLI 历史、费用估算、按额度池归因周额度 | ✅ | — | 部分 | — |
| 脱敏分享卡片（SVG / PNG） | ✅ | — | — | — |
| 终端汇总命令 | ✅ | — | — | — |
| 需要安装的插件数 | **1** | 1 | 2 | 1 |
| 运行时依赖 | **0**（内置 Node 24） | Python | 0 | IDE 扩展宿主 |

## 安装（30 秒）

只需要 **Antigravity 2.0 桌面应用**。它自带 Node.js 24 和内置的 `node:sqlite`，不用再装任何东西。

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

然后重启 Antigravity，在 **Customizations → Installed** 中打开 **Agy Lens**，在任意对话右侧边栏打开它即可。

<details>
<summary>其他安装方式</summary>

**Antigravity CLI**

```bash
agy plugin install https://github.com/Aoike123/agy-lens
```

**发布包（不用命令行）**：从 [最新发布](https://github.com/Aoike123/agy-lens/releases/latest) 下载 `agy-lens.zip` 并解压，确保 `plugin.json` 位于：

- Windows：`%USERPROFILE%\.gemini\config\plugins\agy-lens\plugin.json`
- macOS / Linux：`~/.gemini/config/plugins/agy-lens/plugin.json`

**源码安装**

```bash
git clone https://github.com/Aoike123/agy-lens.git ~/.gemini/config/plugins/agy-lens
```

安装脚本会原子替换文件，并清理旧版本留下的目录，避免出现重复面板。

</details>

## 功能

| 概览 | 额度 | 历史 |
| --- | --- | --- |
| ![概览](docs/img/zh/overview.png) | ![额度](docs/img/zh/quota.png) | ![历史](docs/img/zh/history.png) |

### 概览：当前对话

- **上下文窗口**：与 agy CLI 的 `/context` 统计方式一致，读取 Antigravity 为每次模型调用记录的真实 Token 数据，而不是按字符估算。100 个点展示用户消息、智能体回复、工具调用、系统提示词、规则、技能、MCP 工具等的占比。
- **请求预算**提醒：在 Antigravity 开始裁剪较早历史之前就能看到。
- **输出速度**：流式 tok/s（已过滤异常值）、端到端速度、首字延迟、缓存命中率、近期趋势，并按模型拆分。
- **本会话累计**：输入、输出、缓存读取、思考 Token，按公开价估算的费用，以及占每周额度的比例。

### 额度：撞墙之前就知道

- 从应用本地语言服务器读取各模型池（Claude / GPT-OSS、Gemini、Tab 补全）的官方**每周**与 **5 小时**限额。
- 20 点额度条、已用 / 剩余百分比与实时重置倒计时。

### 历史：Token 都花在哪了

- 覆盖桌面端**和** CLI 会话（自动归档被清理旧对话的用量，并汇总多级子智能体树），提供 `今天 / 7 天 / 30 天 / 全部` 汇总、活跃度热力图和模型排行。
- 按官方固定重置周期反算每个模型池的 **100% 周额度美元估值**，给出各模型与项目的 `≈ 周额度 X%` 大小，并记录历周额度总价值变化以检测额度是否缩水。
- 按主对话树排行（可逐级展开子智能体）与可搜索的会话列表。
- **分享卡片**：把聚合用量导出为 SVG 或 PNG，绝不包含对话标题和文件路径。

<img src="docs/img/zh/share-card.png" alt="Agy Lens 分享卡片：近 30 天 Token、费用、以 100 个点表示的模型占比、每日活跃度" width="100%">

### 终端命令

在终端里看同样的数字（需要 Node.js 24+）：

```bash
npx github:Aoike123/agy-lens          # 最近一次对话 + 历史汇总
npx github:Aoike123/agy-lens --json   # 机器可读输出
```

## 隐私

- **默认完全本地**：所有数字都来自本机文件，没有遥测，不上传任何数据。
- **只读**：会话数据库以只读方式打开；不修改应用本身，只使用官方插件 / sidecar 机制。
- **唯一可选的网络请求**：费用按内置价格表估算。只有你点击 **同步官网价** 时，才会下载公开的 LiteLLM 价格表（失败时回退 OpenRouter），不发送任何凭据或本地数据。

## 常见问题

<details>
<summary>Customizations → Installed 里看不到面板</summary>

确认 `plugin.json` 直接位于插件目录第一层（`~/.gemini/config/plugins/agy-lens/plugin.json`，不要多套一层），然后完全重启 Antigravity。

</details>

<details>
<summary>额度页显示「暂不可用」</summary>

先登录 Antigravity，然后把 Agy Lens 关闭再打开，让 sidecar 重新拿到语言服务器地址和令牌。

</details>

<details>
<summary>会消耗 Token 或拖慢智能体吗？</summary>

不会。它从不调用模型，只读取本地数据库，并向本地语言服务器查询额度。

</details>

<details>
<summary>美元金额是我的账单吗？</summary>

不是。这是按公开 API 价格估算的数值，用来比较模型和会话。预览模型按已发布的同系列模型估算，并标注 `≈`。

</details>

## 参与贡献

欢迎用中文或英文提交 Issue 和 Pull Request。架构、数据来源和协议说明见 [docs/architecture.md](docs/architecture.md)，开发环境见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
node --test tests/*.mjs          # 单元测试
node tests/e2e/run.mjs           # 端到端测试
node scripts/build-release.mjs   # 构建 dist/agy-lens.zip
```

如果 Agy Lens 帮你躲过了一次限额突袭，点个 ⭐ 能让更多 Antigravity 用户看到它。

## 许可证

[MIT](LICENSE)。最初派生自 [dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context)（MIT）。
