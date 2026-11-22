# V2EX 发布帖

**节点：** 分享创造（/go/create）

**标题：** Agy Lens：给 Antigravity 2.0 做了个纯本地用量驾驶舱（精确上下文 / tok/s / 5h 与周额度缩水监测 / 子智能体汇总）

---

用 Antigravity 2.0 一段时间，最容易踩的坑有三个：不知道离 5 小时限额还有多远、上下文超出请求预算后被悄悄裁剪，以及开了多级子智能体后根本算不清一个项目到底烧了多少周额度（甚至不知道每周额度是不是暗中缩水了）。

于是写了 **Agy Lens**，一个开源的零依赖侧边栏插件 + 终端 CLI：

- **概览页（当前对话）**：和 `agy /context` 完全同口径的 Token 拆解 + 100 点占用图、请求预算裁剪预警、分模型流式 `tok/s` / 首字延迟 / 缓存命中率，以及当前主对话连同子智能体的累计花费与 `≈ 周额度 X%` 占比。
- **额度页（限额与缩水检测）**：直接读取本地语言服务器的官方 5 小时与每周额度及倒计时；并严格按官方固定 7 天重置周期 `[reset_time - 7d, reset_time)` 对齐本地估算费用，反推各模型池 **100% 周额度美元估值**并归档历周环比变化，方便对比每周额度波动。
- **历史页（全局与项目排行）**：桌面端 + CLI 全量统计（`今天 / 7 天 / 30 天 / 全部`）、自适应热力图、按当前时段精确切片的模型榜、自动保留已被 Antigravity 清理的旧会话用量、多级子智能体树汇总与单项目 `≈ 周额度 X%` 估值，以及一键导出脱敏分享卡片（SVG / PNG，不含标题与路径）。
- **终端命令**：`npx github:Aoike123/agy-lens`（支持 `--json`）。

技术栈极简：完全运行在 Antigravity 自带的 Node.js 24 上，用内置 `node:sqlite` 只读打开库并直接解码 protobuf；零 npm 依赖、不用装 Python、不调用任何模型、刷新零 Token、默认不联网。

截图：（贴 `docs/img/hero-zh.png`）

安装（Windows PowerShell）：

```powershell
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

GitHub：https://github.com/Aoike123/agy-lens （MIT 协议）

额度接口是非公开的，欢迎反馈不同套餐或模型的显示情况；如果帮到你了，顺手点个 Star 支持一下~
