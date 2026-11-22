# Linux.do 发布帖

**分区：** 开发调优 / 资源荟萃

**标题：** 【开源】Agy Lens：Antigravity 2.0 上下文、tok/s、5h/周额度缩水监测与项目消耗一屏看清（纯 Node 24 零依赖）

**配图：** `docs/img/hero-zh.png`，文末附 `docs/img/zh/share-card.png`

---

佬友们好，平时重度用 Antigravity 2.0 时最痛的几个点：

1. 干到一半突然撞上 5 小时限额，没有任何预警；
2. 上下文超过请求预算被悄悄裁剪，模型开始“失忆”；
3. 开了多级子智能体后算不清单个项目花了多少周额度，旧对话被客户端清理后历史记录也跟着没了，还不知道每周额度到底有没有缩水。

所以做了个全功能本地插件 **Agy Lens**，装完直接在对话右侧边栏实时看：

- **概览（当前对话）**：和 agy CLI `/context` 完全同口径的 Token 拆解、请求预算预警、分模型流式 `tok/s` / 首字延迟 / 缓存命中，以及当前主对话 + 全部子智能体的花费和 `≈ 周额度 X%`。
- **额度（限额 + 周额度价值对比）**：直连本地语言服务器获取各模型池官方 5 小时与每周额度及倒计时；按官方固定 7 天重置周期 `[reset_time - 7d, reset_time)` 持久化周期账本，反算 **100% 周额度美元估值**并记录历周环比波动（带 5% 门槛与饱和前高水位锁，避免耗尽后 AI Credits 虚高），一眼看清额度有没有缩水。
- **历史（项目树 + 分享卡片）**：汇总桌面端与 CLI 全量历史，支持按 `今天 / 7 天 / 30 天 / 全部` 切换热力图与当期模型榜；自动归档已被 Antigravity 删掉的旧会话并保留多级子智能体父子关系；每个项目都带 `≈ 周额度 X%` 估值；支持一键复制脱敏分享卡片到剪贴板（PNG 图片 / SVG，只含聚合指标，绝无标题和本地路径）。
- **终端 CLI**：`npx github:Aoike123/agy-lens`（支持 `--json`）。

技术实现：直接跑在 Antigravity 内置的 Node 24 里，`node:sqlite` 只读打开数据库、手写轻量 protobuf 解码，**零 npm 依赖、不用 Python、不调模型、刷新零 Token**，默认完全不联网（只有手动点“同步官网价”才拉取公开 LiteLLM 价格表）。

**安装（Windows PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

装完重启 Antigravity，在 Customizations → Installed 里开启 Agy Lens 即可。

仓库：https://github.com/Aoike123/agy-lens （MIT）

不同套餐返回的额度池可能不一样，欢迎各位佬友提 Issue 反馈；觉得好用的话点个 **⭐ Star** 支持一下，感谢！
