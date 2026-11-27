# V2EX 发布帖（v2.8.0）

**节点：** 分享创造（/go/create）

**标题：** 给 Antigravity 2.0 做的本地驾驶舱 Agy Lens v2.8：多周期额度浪费统计、可选自动唤醒，还顺手塞了 6 套 WebGL 海报和像素 RPG 角色卡

**配图建议：** 先放 `docs/img/hero-zh.png`，再放 `docs/img/zh/share-card.png`

---

一直在重度用 Antigravity 2.0，顺手把之前写的开源侧边栏插件 **Agy Lens** 迭代到了 **v2.8.0**，主要解决四个日常痛点：

1. **实时防撞墙（概览页）**：与 `agy /context` 同口径的 100 点上下文拆解、请求预算裁剪预警、分模型流式 `tok/s` / 首字延迟 / 缓存命中，以及当前对话连同子智能体的花费与周额度占比。
2. **算清套餐到底有没有浪费 / 缩水（额度页）**：
   - 官方 5h / 周额度倒计时 + 多周期 `已用 / 总可用 · 本周期剩余 · 往期未用` 闭环统计（比如 4 个周期 400% 总量到底白白过期了多少）；
   - 基于真实相邻重置间隔反推每周期 100% 美元估值与缩水环比，点击柱子可展开周期内分段消耗速度下钻；
   - 针对 Antigravity 刷新满额后「发第一条消息才开始倒计时」的机制，做了**默认关闭的单池自动唤醒开关**（开启后用最便宜模型发 1 条禁工具短消息并自动删临时对话，内置单周期熔断锁 + 12h 硬冷却）。
3. **按项目算清真实成本（历史页）**：桌面端 + CLI 全量统计、按项目分组/筛选、自动归档被客户端删掉的旧会话、多级子智能体树按周期单价分段锁定 `≈ 周额度 X%`。
4. **脱敏分享卡片（6 风格 + 实况/动图导出）**：5 款 60fps WebGL 艺术海报 + 1 款像素 RPG 角色卡（13 职业 / 6 属性 / 12 成就），支持深浅双主题，全屏预览并一键复制/导出实况（`.jpg`）、MP4、GIF、PNG 或 SVG，不含任何对话标题与本地路径。

技术上继续坚持极简：完全跑在 Antigravity 自带的 Node.js 24 上，内置 `node:sqlite` 只读解库 + 零 npm 依赖 + 不用 Python + 支持面板内 SHA-256 校验一键原地升级；同时提供终端 CLI（`npx github:Aoike123/agy-lens`）。

**安装（Windows PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

GitHub（MIT）：https://github.com/Aoike123/agy-lens

欢迎试用反馈不同套餐池的显示效果，有想加的新卡片风格也欢迎提 Issue，顺手点个 Star 感谢！
