# Pulse · antigravity-pulse

[![CI](https://github.com/Aoike123/antigravity-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoike123/antigravity-pulse/actions/workflows/ci.yml)
[![Release](https://github.com/Aoike123/antigravity-pulse/actions/workflows/release.yml/badge.svg)](https://github.com/Aoike123/antigravity-pulse/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**简体中文** · [English](#english)

Antigravity 2.0 桌面应用的 **Pulse** 实时用量侧边面板：**免装 Python · 免装 Git · 零外部依赖 · 解压即用**。一个面板看清上下文占用、输出速度、模型额度（每周 + 5 小时限额）、单会话累计、分类历史视图、官方周额度自动对齐与公开单价费用估算。默认 100% 本地只读运行，刷新不消耗任何 Token。

## 30 秒安装

只需 **Antigravity 2.0 桌面应用**（内置 Node.js 24 运行时，**不需要安装 Python 或任何第三方依赖**）。

### 方式一：一键命令直装（推荐）

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/Aoike123/antigravity-pulse/main/scripts/install.ps1 | iex
```

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/antigravity-pulse/main/scripts/install.sh | bash
```

### 方式二：直装压缩包（零命令行）

1. 前往 [GitHub Releases](https://github.com/Aoike123/antigravity-pulse/releases/latest) 下载 **`antigravity-pulse.zip`**。
2. 解压得到 `antigravity-pulse` 文件夹，将其放进你的 Antigravity 插件目录（不存在可手动新建）：
   - **Windows**：`%USERPROFILE%\.gemini\config\plugins\antigravity-pulse`
   - **macOS / Linux**：`~/.gemini/config/plugins/antigravity-pulse`
3. 确认目录下能直接看到 `plugin.json`（即路径为 `.../plugins/antigravity-pulse/plugin.json`），然后重启 Antigravity 即可。

<details>
<summary>方式三：开发者源码安装（git clone）</summary>

```bash
# macOS / Linux
git clone https://github.com/Aoike123/antigravity-pulse.git ~/.gemini/config/plugins/antigravity-pulse
```

```powershell
# Windows (PowerShell)
git clone https://github.com/Aoike123/antigravity-pulse.git "$HOME\.gemini\config\plugins\antigravity-pulse"
```

更新时在目录内执行 `git pull`，再到 **Customizations → Installed** 中关闭再重新启用插件。

</details>

## 新手 3 步上手

1. **启用插件**：重启 Antigravity，在左侧打开 **Customizations → Installed**，找到并打开 **Pulse** 开关。
2. **打开面板**：打开任意一个对话，在右侧边栏打开 **Pulse**（右上角支持一键刷新或切换 `中 | EN`）。
3. **看懂 3 个页签**：
   - **概览**：当前对话用了多少上下文窗口、是否触发请求预算裁剪、模型流式输出速度、以及本会话累计花费与 Token。
   - **额度**：各个模型池（Claude / GPT-OSS、Gemini、Tab 补全）的**每周限额**、**5 小时限额**和重置倒计时。
   - **历史**：全机（桌面端 + CLI）历史用量汇总、随时段自适应疏密的活跃度热力图、按模型/按会话排行与实时搜索。

## 截图

| 概览 | 额度 | 历史 |
| --- | --- | --- |
| ![概览](docs/img/overview.png) | ![额度](docs/img/quota.png) | ![历史](docs/img/history.png) |

## 功能详情

面板分为三个标签页（**概览**、**额度**、**历史**）。顶栏提供统一的 SVG 刷新图标按钮与 `中 | EN` 分段切换按钮，并采用混合自动刷新机制：

- **概览**：可见时每 3 秒自动轮询。
- **额度 / 历史**：可见时每 65 秒静默自动刷新，窗口重新可见或获得焦点且数据超过 60 秒时自动更新；额度池倒计时归零约 3 秒后还会自动触发一次刷新。静默刷新不打断搜索框焦点或已展开的详情。

### 概览

- **上下文用量**：与 agy CLI 的 `/context` 相同的统计方式（从 CLI 二进制移植），读取 Antigravity 为每次模型调用记录的真实 Token 数据，而不是按字符数估算。
  - 标题：模型名称、已用 / 上限 Token 与百分比；模型名和上下文窗口来自应用的实时模型目录。
  - 点阵图：每个点代表上下文窗口的 1%。
  - 按类别的 Token 用量：用户消息、智能体回复、工具调用，以及非零时显示的系统提示词、系统工具、系统开销、规则、技能、子智能体、工作流、插件、MCP 工具等；剩余空间与检查点缓冲。
  - **请求预算**：超出请求预算（通常 256,000 tokens）后应用会裁剪较早历史，面板会提示。
  - 检查点、知识文件 / 产物文件 / 技能文件 / 自动加载的系统文件。
  - 「复制文本」按 CLI 输出格式复制报告。
- **输出速度**：最近若干次调用的流式速度（自动过滤短回复与缓冲突发异常值）、端到端速度、首字延迟 TTFT、缓存命中率、柱状趋势图，以及本次回复的输出 Token（含思考 / 回复拆分）；同一会话中切换过多个模型时按模型分别展示速度与趋势。
- **本会话累计**：当前会话所有模型调用的输入、输出、缓存读取、思考 Token、调用次数、估算周额度消耗（`≈ 周额度 X%` 或 `占近 7 天已用 X%`，多额度池自动拆分）、缓存命中率、时间跨度、公开价费用估算（同系列估算标 `≈`）与按模型拆分。

### 额度

- 通过应用本地语言服务器（`RetrieveUserQuotaSummary`、`GetUserStatus` 与 `GetAvailableModels`）获取模型额度，按类别分组：**Claude / GPT-OSS 模型**、**Gemini 模型**、**Tab 补全**、其他模型。
- 每个额度池自动展示**每周限额**与 **5 小时限额**（优先采用 `RetrieveUserQuotaSummary` 显式返回的官方限额桶；若接口未返回，则回退为按重置时间推断并标示 `≈`）、已用 / 剩余百分比、**20 点额度条**（每点 5%）与实时重置倒计时；无重置时间且剩余 100% 的池显示为「不限 · 无重置」。
- 模型列表按模型系列与思考档位去重展示，内部或非主力模型收在可折叠的「其他 N 个模型」中；同时显示当前套餐与等级。

### 历史

扫描本机所有桌面端与 CLI 会话，提供三个分类子视图，并支持**自动对齐官方周额度**与**可选同步公开官网价**：

- **按额度池自动对齐周额度**：
  - 自动通过同一本地语言服务器通道读取 `RetrieveUserQuotaSummary` 返回的官方周额度（Gemini、Claude/GPT），在「按总量」展示各额度池官方周已用比例，并按每个模型与会话在该池近 7 天的用量占比自动估算其官方周额度消耗（**`≈ 周额度 X%`**），无需手动填写。
  - 仅当语言服务器未提供周额度桶时，才回退为「按总量」中的可选手动校准（对照左下角 **View Usage** 弹窗填入，保存于本机 `localStorage` 的 `ctx.weeklyLeft`），或明确标注为近 7 天总用量占比（**`占近7天已用 X%`**）。
- **公开官网价费用估算与同步**：
  - 内置常见模型的公开官网单价表离线可用；点击历史页的 **「同步官网价」** 按钮可主动调用 `/api/pricing?refresh=true`，从 **LiteLLM** 公开价格库（失败时回退 **OpenRouter** 公开 API）拉取最新公开单价并在本机缓存 24 小时。
  - 已有公开单价的模型显示 `$x.xx`；未发布 / 预览模型（如 Gemini 4、Orchestrator、Claude 5.5）按同系列已发布模型的公开单价估算并明确标示 **`≈`**（若包含无单价模型则标示下限 `≥`）。
- **按总量**：`今天 / 7 天 / 30 天 / 全部` 周期切换胶囊、主指标与统计网格（输入、输出、缓存读取、调用、对话、费用估算与官方周额度状态）、随时间范围自适应疏密的活跃度热力图（今天按 24 小时、7 天 / 30 天 / 全部逐级变密），以及按显示名称合并的 Top 5 模型榜（悬浮查看原始模型 ID，支持展开其余模型）。
- **按会话**：按 Token 用量（输入 + 输出）降序排列，支持周期筛选（全部 / 近 30 天 / 近 7 天 / 今天）、`隐藏子智能体` 开关、比例条、分页，以及点击展开的详细拆分（输入 / 输出 / 缓存读取 / 思考、缓存命中率、调用次数、费用估算、周额度占比、时间跨度、来源与按模型明细）。
- **会话列表**：按时间线浏览会话，支持实时搜索（按标题 / 模型 / ID，静默刷新不丢焦点）、排序切换（最近活跃 / 按用量 / 按调用）、来源筛选（全部 / 桌面 / CLI，有 CLI 记录时显示）、`隐藏子智能体` 开关，以及同样的展开明细与分页；会话标题读取自应用自身的会话摘要数据库。

## 常见问题（FAQ）

<details>
<summary>1. 安装后在 Customizations → Installed 里看不到 Pulse</summary>

请检查目录层级，确保 `plugin.json` 直接位于插件子目录第一层，例如：
`~/.gemini/config/plugins/antigravity-pulse/plugin.json`（常见错误是多套了一层 `antigravity-pulse/antigravity-pulse/plugin.json`）。放好后需**完全重启**一次 Antigravity。

</details>

<details>
<summary>2. 打开概览显示「先打开一个对话」或「新对话已就绪」</summary>

这是正常引导状态。在左侧选中一个已有对话，或在新对话里发送第一条消息后，面板会在 3 秒内自动加载上下文与速度；此时也可以先点卡片里的按钮切到「额度」或「历史」。

</details>

<details>
<summary>3. 额度页显示「额度信息暂不可用」或看不到周额度</summary>

请确认已登录 Antigravity 账号，并在 **Customizations → Installed** 里把 Pulse 关闭再重新开启（重新注入语言服务器端口与令牌）。如果当前应用版本未返回周额度分桶，历史页仍可用内置的手动校准按钮对齐周剩余百分比。

</details>

<details>
<summary>4. 这个插件会上传我的代码或对话内容吗？会消耗额外 Token 吗？</summary>

不会。所有数据库只以只读方式在本机解析，刷新完全零 Token。只有当你**手动点击**历史页的「同步官网价」时，后端才会发起一次匿名只读请求获取公开模型价格 JSON，不会发送任何本机数据或账号信息。

</details>

<details>
<summary>5. 如何更新或卸载？</summary>

- **更新**：重新运行一次上面的一键安装命令（会自动保留缓存并原子替换文件），然后重启或在插件管理里开关一次 Pulse。
- **卸载**：在 **Customizations → Installed** 关闭 Pulse，并删除 `~/.gemini/config/plugins/antigravity-pulse` 文件夹即可。

</details>

## 工作原理

```
plugin.json                       插件清单
sidecars/context/
  sidecar.json                    注册侧边面板（由 Antigravity 内置 Node 运行 main.mjs）
  main.mjs                        后端：提供面板页面与 /api/report、/api/quota、/api/history、/api/pricing
  pb.mjs                          共享 Protobuf 解码器、只读 node:sqlite 封装与时间工具
  context_report.mjs (.py)        单会话解析器（上下文、输出速度、本会话累计）
  history_scanner.mjs (.py)       多会话历史扫描器（增量缓存）
  index.html, app.js, styles.css  面板前端
scripts/                          一键安装脚本（install.ps1 / install.sh）与打包脚本（build-release.mjs）
tests/                            Node 与 Python 测试
```

- 面板通过 Antigravity 的 sidecar 桥获取当前会话 ID 与工作区，每 3 秒请求一次 `/api/report`。
- 后端直接在同一 Node 进程内使用 Antigravity 内置 Node 24 的 **`node:sqlite`** 只读读取会话数据库（`~/.gemini/antigravity/conversations/<id>.db`），零子进程、无需安装 Python（若运行在缺少 `node:sqlite` 的旧环境下，仍保留 Python 3.10+ 脚本作为兼容回退）。
- 后端对静态资源返回 `Cache-Control: no-store, no-cache, must-revalidate`，并在提供 `index.html` 时按文件修改时间与大小自动为 `styles.css`、`app.js` 附加查询参数（`?v=...`），避免 WebView 缓存错配。
- `/api/quota` 通过应用交给 sidecar 的语言服务器地址与 CSRF 令牌，调用 `RetrieveUserQuotaSummary`、`GetUserStatus` 与 `GetAvailableModels`，合并官方每周 / 5 小时限额与模型目录；模型目录每 10 分钟刷新一次，获取失败时回退到内置的上下文窗口表。
- `/api/history` 增量扫描 `~/.gemini/antigravity/conversations` 与 `~/.gemini/antigravity-cli/conversations`，结果缓存在插件的数据目录中。
- `/api/pricing` 管理本机 `pricing-cache.json`（24 小时缓存）；当缓存存在时，单会话与历史统计自动使用缓存价格。

## 隐私

- **默认 100% 本地**：所有会话统计都来自本机文件，不上传任何本地数据，没有遥测。
- **只读**：会话数据库与会话摘要数据库均以只读方式打开。
- **默认网络通信**：默认情况下，唯一的网络请求是发往应用自身的**本地**语言服务器（使用应用通过 sidecar 环境变量提供的地址与 CSRF 令牌），不访问任何外部服务。
- **可选的公开单价同步**：**仅当**你主动点击 **「同步官网价」** 时，后端才会发起一次只读的匿名 HTTPS `GET` 请求，从 LiteLLM（主源）或 OpenRouter（备用源）获取公开的模型单价 JSON；不携带认证信息，也不上传任何本地或个人数据。
- **不修改应用**：不修补 `app.asar`，不注入脚本，只使用官方插件 / sidecar 机制。
- 缓存（模型目录、已脱敏的额度原始响应、历史扫描缓存、公开单价缓存）只保存在 sidecar 的数据目录中；各额度池的周剩余校准值与新手引导状态仅保存在前端 `localStorage` 中。

## 限制

- 额度数据来自应用语言服务器的非公开接口（`RetrieveUserQuotaSummary` / `GetUserStatus` / `GetAvailableModels`），字段与分组可能随应用更新而变化；若语言服务器未返回周额度桶，则回退为按重置时间推断限额类型（标示 `≈`）以及手动校准或 `占近7天已用 %`。
- 美元费用基于公开 API 单价（内置表或同步自 LiteLLM / OpenRouter）估算，预览模型按同系列公开单价估算并标示 `≈`，仅供参考，不代表实际订阅账单。
- Token 统计依赖应用在会话数据库中记录的元数据，旧版本或损坏的数据库可能无法读取。

## 开发与测试

开发测试仅依赖 Node.js 24+（以及可选的 Python 3.10+ 标准库用于双引擎一致性校验）：

```bash
# 语法检查
node --check sidecars/context/main.mjs
node --check sidecars/context/app.js
node --check scripts/build-release.mjs

# Node 原生引擎与跨引擎一致性测试（Node 24+）
node --test tests/test_main_helpers.mjs tests/test_native_engine.mjs

# 构造免 Python 直装压缩包（输出到 dist/）
node scripts/build-release.mjs

# Python 兼容脚本测试（可选）
python -m unittest discover tests

# 命令行单独运行原生 Node 解析器 / 扫描器
node sidecars/context/context_report.mjs --json
node sidecars/context/history_scanner.mjs --json
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)

## 致谢

Originally derived from [dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context) (MIT).

---

<a id="english"></a>

# English

**Pulse** — a live telemetry and usage side panel for the **Antigravity 2.0 desktop app**: **no Python, no Git, zero external dependencies — ready out of the box**. Track context window usage, output speed, model quota (Weekly + 5-hour limits), per-conversation totals, categorized usage history, automatic official weekly quota attribution, and public-price USD cost estimates in one panel. 100% local and read-only by default; refreshing costs zero tokens.

## Installation

Requires only the **Antigravity 2.0 desktop app** (which bundles Node.js 24 with built-in `node:sqlite` — **no Python installation required**).

### Option 1: One-Line Installer (Recommended)

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Aoike123/antigravity-pulse/main/scripts/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/antigravity-pulse/main/scripts/install.sh | bash
```

### Option 2: Direct-Install ZIP (No Terminal)

1. Download **`antigravity-pulse.zip`** from the [latest release](https://github.com/Aoike123/antigravity-pulse/releases/latest).
2. Extract it and place the `antigravity-pulse` folder inside your Antigravity plugins directory:
   - **Windows**: `%USERPROFILE%\.gemini\config\plugins\antigravity-pulse`
   - **macOS / Linux**: `~/.gemini/config/plugins/antigravity-pulse`
3. Verify `plugin.json` sits directly inside that folder (`.../plugins/antigravity-pulse/plugin.json`), then restart Antigravity.

<details>
<summary>Option 3: From source (git clone)</summary>

```bash
# macOS / Linux
git clone https://github.com/Aoike123/antigravity-pulse.git ~/.gemini/config/plugins/antigravity-pulse
```

```powershell
# Windows (PowerShell)
git clone https://github.com/Aoike123/antigravity-pulse.git "$HOME\.gemini\config\plugins\antigravity-pulse"
```

To update, run `git pull` inside that folder, then turn the plugin off and on again under **Customizations → Installed**.

</details>

## Getting Started in 3 Steps

1. **Enable the plugin**: Restart Antigravity, open **Customizations → Installed**, and turn **Pulse** on.
2. **Open the panel**: Open any conversation and open **Pulse** in the right-side pane (use the top bar to refresh or switch `中 | EN`).
3. **Explore the 3 tabs**:
   - **Overview**: live context window gauge, request budget, output speed, and this conversation's cumulative totals.
   - **Quota**: **Weekly** and **5-hour** limits per model pool with live reset countdowns.
   - **History**: desktop + CLI usage totals, period-adaptive activity heatmap, model & session rankings, and live search.

## Screenshots

| Overview | Quota | History |
| --- | --- | --- |
| ![Overview](docs/img/overview.png) | ![Quota](docs/img/quota.png) | ![History](docs/img/history.png) |

## Features

The panel has three tabs (**Overview**, **Quota**, **History**). The top bar provides a unified inline SVG refresh button, a segmented `中 | EN` language toggle, and hybrid auto-refresh:

- **Overview**: polls every 3 seconds while visible.
- **Quota & History**: silently auto-refresh every 65 seconds while visible, plus on tab visibility / window focus when stale (>60s); Quota also triggers a one-shot refresh ~3 seconds after a pool's reset countdown reaches 0. Silent refreshes preserve search focus and expanded disclosures.

### Overview

- **Context usage**, computed like the agy CLI's `/context` (accounting ported from the CLI binary) from the token breakdown Antigravity records for every model call, not estimated from characters.
  - Header: model name, used / limit tokens and percentage; model name and context window come from the app's live model catalog.
  - Usage grid: each dot is 1% of the context window.
  - Token usage by category: user messages, agent responses, tool calls, plus system prompt, system tools, system overhead, rules, skills, subagents, workflows, plugins, MCP tools when non-zero; free space and checkpoint buffer.
  - **Request budget**: past the per-request budget (usually 256,000 tokens) the app trims older history, and the panel flags it.
  - Checkpoints, knowledge / artifact / skill files and auto-loaded system files.
  - **Copy as text** copies the report as the CLI prints it.
- **Output Speed**: streaming speed (filtering out short/buffered-burst outliers), end-to-end speed, time to first token (TTFT), cache hit rate, recent-call bar chart, and this reply's output tokens (thinking / response split), plus a per-model breakdown with expandable trends when multiple models were used in the conversation.
- **This conversation**: input, output, cache-read and thinking tokens, calls, estimated weekly quota share (`≈ X% weekly` or `% of 7d usage`, with per-pool split when active), cache hit rate, time span, public-price USD cost estimate (`≈` for same-family preview estimates), and per-model breakdown summed over every model call of the open conversation.

### Quota

- Model quota from the app's local language server (`RetrieveUserQuotaSummary`, `GetUserStatus`, and `GetAvailableModels`), grouped by category: **Claude / GPT-OSS models**, **Gemini models**, **Tab completion**, and other models.
- Each pool automatically displays both its **Weekly** and **5-hour** limits (preferring explicit official buckets from `RetrieveUserQuotaSummary`, falling back to reset-time inference marked `≈` when unavailable), used / remaining percentage, a **20-dot meter** (1 dot = 5%) and a live reset countdown. A pool with no reset time and 100% left shows "Unlimited · no reset".
- Models are grouped into deduplicated families with thinking levels, internal models sit in a collapsible "Other N models" disclosure, and the current tier and plan are shown.

### History

Scans desktop and CLI conversations on this machine across three categorized sub-views, with **automatic official weekly quota attribution** and **opt-in public pricing sync**:

- **Per-pool weekly quota**:
  - Automatically queries `RetrieveUserQuotaSummary` via the same local language server channel to read each pool's official weekly remaining percentage (`Gemini`, `Claude/GPT`), showing live official weekly usage in **Totals** and auto-calibrating each model / conversation's estimated share of that pool's weekly quota (**`≈ X% weekly`**) proportionally from its 7-day pool usage.
  - Falls back to optional manual calibration (from Antigravity's **View Usage** popup, saved in `localStorage` as `ctx.weeklyLeft`) or unambiguous 7-day usage share (**`X% of 7d usage`**) only if the language server does not expose weekly buckets.
- **Public pricing & opt-in sync**:
  - Ships with a built-in offline table of published model list prices. Click **Sync prices** in History to call `/api/pricing?refresh=true`, fetching public pricing from **LiteLLM** (primary) with **OpenRouter** as fallback, cached locally for 24 hours.
  - Published models show `$x.xx`; preview / unreleased models (e.g. Gemini 4, Orchestrator, Claude 5.5) are estimated from their released same-family public price and clearly marked **`≈`** (`≥` marks a lower bound when unpriced calls are included).
- **Totals**: 4-pill period selector (`Today / 7d / 30d / All`), hero total (excl. cache read) and stat grid (Input, Output, Cache read, Calls, Cost estimate & live weekly quota status), period-adaptive activity heatmap (hourly for Today, progressively denser across 7d / 30d / All), and merged Top 5 models (duplicate display names merged, raw model IDs in tooltip, expandable for the rest).
- **By session**: conversations ranked by usage (`input + output`), with period filter (`All / 30d / 7d / Today`), hide-subagents toggle, proportional bars, pagination, and click-to-expand breakdowns (input / output / cache read / thinking, cache hit %, calls, cost estimate, weekly quota %, time span, source and per-model breakdown).
- **Session list**: chronological conversation list with live search (by title / model / ID, keeping focus across silent refreshes), sort switch (Recent / By usage / By calls), conditional Desktop / CLI source filter, hide-subagents toggle, pagination and expandable breakdowns. Titles come from the app's own conversation summaries database.

<a id="faq"></a>

## FAQ

<details>
<summary>1. Pulse doesn't show up under Customizations → Installed</summary>

Check that `plugin.json` is directly inside the plugin directory: `~/.gemini/config/plugins/antigravity-pulse/plugin.json` (not nested inside an extra subfolder). After placing the folder, **fully restart** Antigravity.

</details>

<details>
<summary>2. Overview says "Open a conversation first" or "New conversation ready"</summary>

That is normal when no conversation is open or before a new conversation receives its first reply. Select a conversation or send a message and the Overview populates within 3 seconds; you can also jump straight to Quota or History via the buttons inside the card.

</details>

<details>
<summary>3. Quota says "Quota unavailable" or weekly bars don't appear</summary>

Make sure you are signed in to Antigravity and toggle **Pulse** off and on under **Customizations → Installed** so the sidecar picks up the language server credentials. If your Antigravity build does not expose weekly buckets, you can still use the inline **Calibrate** control in History.

</details>

<details>
<summary>4. Does this upload my conversations or cost tokens?</summary>

No. Conversation databases are opened strictly read-only on your machine, and refreshing costs zero tokens. An external HTTPS `GET` request happens **only** when you manually click **Sync prices**, and it only downloads public model pricing JSON without sending any local data.

</details>

<details>
<summary>5. How do I update or uninstall?</summary>

- **Update**: re-run the one-line installer (it preserves your cache in `sidecar_data` and atomically replaces the plugin files), then toggle or restart Pulse.
- **Uninstall**: turn **Pulse** off under **Customizations → Installed** and delete `~/.gemini/config/plugins/antigravity-pulse`.

</details>

## How it works

```
plugin.json                       plugin manifest
sidecars/context/
  sidecar.json                    registers the side panel (runs main.mjs with Antigravity's Node)
  main.mjs                        backend: serves the panel and /api/report, /api/quota, /api/history, /api/pricing
  pb.mjs                          shared protobuf decoder, read-only node:sqlite loader & time helpers
  context_report.mjs (.py)        per-conversation parser (context, output speed, this-conversation usage)
  history_scanner.mjs (.py)       multi-conversation history scanner (incremental cache)
  index.html, app.js, styles.css  panel front end
scripts/                          one-line installers (install.ps1 / install.sh) & release builder (build-release.mjs)
tests/                            Node and Python tests
```

- The panel gets the open conversation's ID and workspace from Antigravity's sidecar bridge and asks the backend for `/api/report` every 3 seconds.
- The backend reads conversation databases (`~/.gemini/antigravity/conversations/<id>.db`, opened read-only) directly in-process via **`node:sqlite`** inside Antigravity's bundled Node 24 runtime — no Python installation and no subprocess overhead (Python 3.10+ fallback scripts are retained for legacy environments without `node:sqlite`).
- Static assets are served with `Cache-Control: no-store, no-cache, must-revalidate`, and `/` dynamically stamps `styles.css` and `app.js` URLs with their current mtime/size (`?v=...`) to prevent stale WebView asset mismatches.
- `/api/quota` calls `RetrieveUserQuotaSummary`, `GetUserStatus`, and `GetAvailableModels` on the app's local language server, using the address and CSRF token the app hands the sidecar, merging official Weekly / 5-hour buckets with the model catalog. The model catalog refreshes every 10 minutes; if it fails, the parser falls back to a built-in context window table.
- `/api/history` incrementally scans `~/.gemini/antigravity/conversations` and `~/.gemini/antigravity-cli/conversations`, caching parsed per-DB usage in the plugin's data directory.
- `/api/pricing` manages a local `pricing-cache.json` (24-hour cache); when present, both `context_report` and `history_scanner` automatically use those prices.

## Privacy

- **100% local by default**: all usage data comes from local files on your machine. No local or personal data is ever uploaded, and there is no telemetry.
- **Read-only**: conversation and conversation-summary databases are opened read-only.
- **Default network traffic**: by default, the only network requests go to the app's own **local** language server, through the address and CSRF token the app provides to the sidecar. No external services are contacted.
- **Opt-in public pricing sync**: **only** when you click **Sync prices** does the backend perform an unauthenticated, read-only HTTPS `GET` to fetch the public model price list from LiteLLM (with OpenRouter as fallback) and cache it locally in `pricing-cache.json`. Zero local data is sent.
- **No app patching**: no `app.asar` modification and no script injection; only the official plugin / sidecar mechanism.
- Caches (model catalog, redacted raw quota response, history scan cache, public price list cache) live only in the sidecar's data directory; per-pool weekly calibration and onboarding state live only in panel `localStorage`.

## Limitations

- Quota data comes from undocumented language-server RPCs (`RetrieveUserQuotaSummary` / `GetUserStatus` / `GetAvailableModels`), so its fields and grouping may change with app updates. If `RetrieveUserQuotaSummary` does not expose weekly buckets, the panel falls back to reset-time inference (marked `≈`) and manual calibration or `X% of 7d usage`.
- USD cost figures are estimates from public API list prices (built-in or synced from LiteLLM / OpenRouter); preview models use same-family estimates marked `≈` and do not represent your actual subscription bill.
- Token counts depend on the metadata the app writes to its conversation databases; old or damaged databases may not be readable.

## Development and testing

Only Node.js 24+ (and optionally Python 3.10+ stdlib for parity checks) are needed:

```bash
# Syntax checks
node --check sidecars/context/main.mjs
node --check sidecars/context/app.js
node --check scripts/build-release.mjs

# Node backend & native engine parity tests (Node 24+)
node --test tests/test_main_helpers.mjs tests/test_native_engine.mjs

# Build direct-install ZIP package (outputs to dist/)
node scripts/build-release.mjs

# Optional Python fallback tests
python -m unittest discover tests

# Run the native Node parser / scanner directly
node sidecars/context/context_report.mjs --json
node sidecars/context/history_scanner.mjs --json
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE)

## Acknowledgements

Originally derived from [dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context) (MIT).
