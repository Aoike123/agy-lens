# Usage Dashboard · antigravity-usage-dashboard

[![CI](https://github.com/<OWNER>/antigravity-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/<OWNER>/antigravity-usage-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**简体中文** · [English](#english)

Antigravity 2.0 桌面应用的**用量仪表盘**侧边面板：上下文占用、输出速度、模型额度（5 小时限额）、单会话与历史 Token 用量，一个面板全部看清。所有数据都在本机读取，刷新不消耗任何 Token。

## 截图

> 截图将在后续补充，存放于 [`docs/img/`](docs/img/)。


| 概览                           | 额度                        | 历史                          |
| ------------------------------ | --------------------------- | ----------------------------- |
| ![概览](docs/img/overview.png) | ![额度](docs/img/quota.png) | ![历史](docs/img/history.png) |

## 功能

面板分为三个标签页，界面支持中文 / English 一键切换。

### 概览

- **上下文用量**：与 agy CLI 的 `/context` 相同的统计方式（从 CLI 二进制移植），读取 Antigravity 为每次模型调用记录的真实 Token 数据，而不是按字符数估算。
  - 标题：模型名称、已用 / 上限 Token 与百分比；模型名和上下文窗口来自应用的实时模型目录。
  - 点阵图：每个点代表上下文窗口的 1%。
  - 按类别的 Token 用量：用户消息、智能体回复、工具调用，以及非零时显示的系统提示词、系统工具、系统开销、规则、技能、子智能体、工作流、插件、MCP 工具等；剩余空间与检查点缓冲。
  - 请求预算：超出请求预算（通常 256,000 tokens）后应用会裁剪较早历史，面板会提示。
  - 检查点、知识文件 / 产物文件 / 技能文件 / 自动加载的系统文件。
  - 「复制为文本」按 CLI 输出格式复制报告。
- **输出速度**：最近若干次调用的流式速度、端到端速度、首字延迟 TTFT、缓存命中率，以及本次回复的输出 Token（含思考 / 回复拆分）；同一会话使用多个模型（如主智能体与子智能体）时按模型分别显示。
- **本会话累计**：当前会话所有模型调用的输入、输出、缓存读取、思考 Token、调用次数、缓存命中率、参考费用，以及按模型拆分。

### 额度

- 来自应用语言服务器的模型额度，按类别分组：**Claude / GPT-OSS 模型**、**Gemini 模型**、**Tab 补全**、其他模型。
- 每个额度池显示限额类型（如 **5 小时限额**）、已用 / 剩余百分比与重置倒计时；若数据中包含每日 / 每周等其他窗口，则各自显示一条进度条。没有重置时间且剩余 100% 的池显示为「不限 · 无重置」。
- 模型列表按显示名称去重，内部模型收在「更多」中；同时显示当前套餐。

### 历史

- 扫描本机所有桌面端与 CLI 会话：**今天 / 近 7 天 / 近 30 天 / 全部** 的输入、输出、缓存读取 Token、调用次数与会话数。
- **按模型**：各模型用量与占比。
- **按会话**：最近活跃的会话（标题或短 ID、模型、最后活跃时间、Token、参考费用）；标题取自应用自身的会话摘要数据库。
- **活跃度**热力图：近一年每天的 Token 与调用次数。
- **参考价**：按公开单价估算的费用，仅供参考（见[限制](#限制)）。

## 安装

需要 Antigravity 2.0 桌面应用，以及 `PATH` 中的 Python 3.10+（`python`、`py` 或 `python3`）。

1. 克隆到 Antigravity 插件目录：

   ```bash
   # macOS / Linux
   git clone https://github.com/<OWNER>/antigravity-usage-dashboard.git ~/.gemini/config/plugins/antigravity-usage-dashboard
   ```

   ```powershell
   # Windows (PowerShell)
   git clone https://github.com/<OWNER>/antigravity-usage-dashboard.git "$HOME\.gemini\config\plugins\antigravity-usage-dashboard"
   ```
2. 重启 Antigravity，打开 **Customizations → Installed**，启用 **Usage Dashboard**。
3. 打开一个会话，在右侧面板中打开该面板。

更新：在该目录中执行 `git pull`，然后在 Customizations 中关闭再重新启用插件。

## 工作原理

```
plugin.json                 插件清单
sidecars/context/
  sidecar.json              注册侧边面板（用 Antigravity 自带的 Node 运行 main.mjs）
  main.mjs                  后端：提供面板页面与 /api/report、/api/quota、/api/history
  index.html, app.js, styles.css   面板前端
  context_report.py         单会话解析器（上下文、输出速度、本会话累计）
  history_scanner.py        多会话历史扫描器（带增量缓存）
tests/                      Python 与 Node 测试
```

- 面板通过 Antigravity 的 sidecar 桥获取当前会话 ID 与工作区，每 3 秒请求一次 `/api/report`。
- 后端仅在会话数据库（`~/.gemini/antigravity/conversations/<id>.db`，只读打开）发生变化时运行 `context_report.py --json`，否则返回缓存。
- `/api/quota` 通过应用交给 sidecar 的语言服务器地址与 CSRF 令牌，调用 `GetUserStatus` / `GetAvailableModels`；模型目录每 10 分钟刷新一次，获取失败时回退到内置的上下文窗口表。
- `/api/history` 运行 `history_scanner.py`，扫描 `~/.gemini/antigravity/conversations` 与 `~/.gemini/antigravity-cli/conversations`，结果增量缓存在插件的数据目录中。

## 隐私

- **100% 本地**：所有数据都来自本机文件，不上传任何内容，没有遥测。
- **只读**：会话数据库与会话摘要数据库均以只读方式打开。
- **唯一的网络请求**是发往应用自身的**本地**语言服务器，使用应用通过 sidecar 环境变量提供的地址与令牌；不访问任何外部服务。
- **不修改应用**：不修补 `app.asar`，不注入脚本，只使用官方插件 / sidecar 机制。
- 缓存（模型目录、额度原始响应（已脱敏）、历史扫描缓存）只保存在 sidecar 的数据目录中。

## 限制

- 额度数据来自应用语言服务器的非公开接口，字段与分组可能随应用更新而变化；语言服务器不提供限额窗口长度，限额类型（如 5 小时）是根据重置时间推断的。
- 费用为按公开单价估算的**参考价**，不代表实际账单；没有公开单价的模型不计入（以「≥」表示下限）。
- Token 统计依赖应用在会话数据库中记录的元数据，旧版本或损坏的数据库可能无法读取。

## 开发与测试

只需 Python 标准库与 Node.js：

```bash
# Python 测试（构造合成会话数据库并端到端检查）
python -m unittest discover tests

# Node 后端辅助函数测试（Node 18+）
node tests/test_main_helpers.mjs

# 语法检查
node --check sidecars/context/main.mjs
node --check sidecars/context/app.js

# 命令行单独运行解析器 / 扫描器
python sidecars/context/context_report.py                     # 最近活跃的桌面会话
python sidecars/context/context_report.py --conversation-id <uuid> --json
python sidecars/context/history_scanner.py --json
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)

## 致谢

Originally derived from [dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context) (MIT).

---

<a id="english"></a>

# English

A **Usage Dashboard** side panel for the **Antigravity 2.0 desktop app**: context window usage, output speed, model quota (5-hour limit), and per-conversation and historical token usage in one panel. Everything is read locally, and refreshing costs zero tokens.

## Screenshots

> Screenshots are coming soon and will live in [`docs/img/`](docs/img/).


| Overview                           | Quota                        | History                          |
| ---------------------------------- | ---------------------------- | -------------------------------- |
| ![Overview](docs/img/overview.png) | ![Quota](docs/img/quota.png) | ![History](docs/img/history.png) |

## Features

The panel has three tabs, and the UI switches between 中文 and English with one click.

### Overview

- **Context usage**, computed like the agy CLI's `/context` (accounting ported from the CLI binary) from the token breakdown Antigravity records for every model call, not estimated from characters.
  - Header: model name, used / limit tokens and percentage; model name and context window come from the app's live model catalog.
  - Usage grid: each dot is 1% of the context window.
  - Token usage by category: user messages, agent responses, tool calls, plus system prompt, system tools, system overhead, rules, skills, subagents, workflows, plugins, MCP tools when non-zero; free space and checkpoint buffer.
  - Request budget: past the per-request budget (usually 256,000 tokens) the app trims older history, and the panel says so.
  - Checkpoints, knowledge / artifact / skill files and auto-loaded system files.
  - **Copy as text** copies the report as the CLI prints it.
- **Output Speed**: streaming speed, end-to-end speed, time to first token (TTFT) and cache hit rate over the last calls, plus this reply's output tokens (thinking / response split); when a conversation uses several models (e.g. main agent and subagents), speed is also broken down per model.
- **This conversation**: input, output, cache-read and thinking tokens, calls, cache hit rate and reference cost summed over every model call of the open conversation, with a per-model breakdown.

### Quota

- Model quota from the app's language server, grouped by category: **Claude / GPT-OSS models**, **Gemini models**, **Tab completion**, other models.
- Each pool shows its limit kind (e.g. **5-hour limit**), used / remaining percentage and a reset countdown; other windows (daily / weekly) in the data get their own bar. A pool with no reset time and 100% left shows "Unlimited · no reset".
- Model chips are deduplicated by display name, internal models are tucked under "More", and the current plan is shown.

### History

- Scans every desktop and CLI conversation on this machine: input, output and cache-read tokens, calls and conversations for **Today / Last 7 days / Last 30 days / All time**.
- **By model**: usage and share per model.
- **By conversation**: recently active conversations (title or short ID, model, last active, tokens, reference cost); titles come from the app's own conversation summaries database.
- **Activity** heatmap: tokens and calls per day over the last year.
- **Reference cost** estimated from public list prices (see [Limitations](#limitations)).

## Installation

Requires the Antigravity 2.0 desktop app and Python 3.10+ on your `PATH` (`python`, `py` or `python3`).

1. Clone this repository into your Antigravity plugins folder:

   ```bash
   # macOS / Linux
   git clone https://github.com/<OWNER>/antigravity-usage-dashboard.git ~/.gemini/config/plugins/antigravity-usage-dashboard
   ```

   ```powershell
   # Windows (PowerShell)
   git clone https://github.com/<OWNER>/antigravity-usage-dashboard.git "$HOME\.gemini\config\plugins\antigravity-usage-dashboard"
   ```
2. Restart Antigravity, open **Customizations → Installed**, and turn **Usage Dashboard** on.
3. Open a conversation and open the panel in the right-side pane.

To update, run `git pull` inside that folder, then turn the plugin off and on again.

## How it works

```
plugin.json                 plugin manifest
sidecars/context/
  sidecar.json              registers the side panel (runs main.mjs with Antigravity's Node)
  main.mjs                  backend: serves the panel and /api/report, /api/quota, /api/history
  index.html, app.js, styles.css   panel front end
  context_report.py         per-conversation parser (context, output speed, this-conversation usage)
  history_scanner.py        multi-conversation history scanner (incremental cache)
tests/                      Python and Node tests
```

- The panel gets the open conversation's ID and workspace from Antigravity's sidecar bridge and asks the backend for `/api/report` every 3 seconds.
- The backend runs `context_report.py --json` on the conversation database (`~/.gemini/antigravity/conversations/<id>.db`, opened read-only) only when it has changed; otherwise it returns the cached report.
- `/api/quota` calls `GetUserStatus` / `GetAvailableModels` on the app's language server, using the address and CSRF token the app hands the sidecar. The model catalog refreshes every 10 minutes; if it fails, the parser falls back to a built-in context window table.
- `/api/history` runs `history_scanner.py` over `~/.gemini/antigravity/conversations` and `~/.gemini/antigravity-cli/conversations`, with an incremental cache in the plugin's data directory.

## Privacy

- **100% local**: all data comes from files on this machine. Nothing is uploaded, and there is no telemetry.
- **Read-only**: conversation and conversation-summary databases are opened read-only.
- **The only network traffic** goes to the app's own **local** language server, through the address and token the app provides to the sidecar. No external services are contacted.
- **No app patching**: no `app.asar` modification and no script injection; only the official plugin / sidecar mechanism.
- Caches (model catalog, redacted raw quota response, history scan cache) are stored only in the sidecar's data directory.

## Limitations

- Quota data comes from an undocumented language-server API, so its fields and grouping may change with app updates. The server does not report the window length; the limit kind (e.g. 5-hour) is inferred from the reset time.
- Costs are **reference** estimates from public list prices, not your actual bill. Models without a public price are not counted (shown as a "≥" lower bound).
- Token counts depend on the metadata the app writes to its conversation databases; old or damaged databases may not be readable.

## Development and testing

Only the Python standard library and Node.js are needed:

```bash
# Python tests (build synthetic conversation databases and check end to end)
python -m unittest discover tests

# Node backend helper tests (Node 18+)
node tests/test_main_helpers.mjs

# Syntax checks
node --check sidecars/context/main.mjs
node --check sidecars/context/app.js

# Run the parser / scanner on the command line
python sidecars/context/context_report.py                     # most recently active desktop conversation
python sidecars/context/context_report.py --conversation-id <uuid> --json
python sidecars/context/history_scanner.py --json
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [CHANGELOG.md](CHANGELOG.md) for release notes.
