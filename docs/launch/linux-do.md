# Linux.do 发布帖

**分区：** 开发调优 / 资源荟萃

**标题：** 【开源】Agy Lens：Antigravity 2.0 上下文、tok/s、5 小时 + 每周额度一个侧边栏全看清（零依赖、纯本地）

**配图：** `docs/img/hero-zh.png`，文末附 `docs/img/zh/share-card.png`

---

佬友们好，用 Antigravity 2.0 时最烦的两件事：

1. 干到一半突然撞上 5 小时限额；
2. 上下文超过请求预算后被悄悄裁掉，模型开始“失忆”。

所以做了个插件 **Agy Lens**，在对话右侧实时显示这些数字：

- **上下文按类别拆解**：和 agy CLI 的 `/context` 同一套统计口径，读取应用记录的真实 Token，不是按字数估算；快到请求预算会提醒
- **输出速度**：流式 tok/s、首字延迟、缓存命中率，按模型分开看
- **官方 5 小时 + 每周额度**：各模型池剩余百分比和重置倒计时
- **历史用量**：桌面端 + CLI 全部会话（含子智能体树汇总与旧对话归档），热力图、模型排行、按公开价估算的费用、按官方周期估算的 100% 周额度总价值与各项目占比，并可追踪每周额度是否缩水
- **分享卡片**：一键导出 SVG / PNG，只有聚合数字，不含对话标题和本地路径
- **终端命令**：`npx github:Aoike123/agy-lens`

技术上：直接用 Antigravity 自带的 Node 24（`node:sqlite`）只读解析本地会话库里的 protobuf，额度走应用本地语言服务器。**零 npm 依赖、不用装 Python、不调用任何模型、刷新零 Token**，默认不访问任何外网（只有手动点“同步官网价”才会拉公开价格表）。

**安装（Windows PowerShell）：**

```
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

**macOS / Linux：**

```
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

装完重启 Antigravity，在 Customizations → Installed 里打开 Agy Lens 即可。

仓库：https://github.com/Aoike123/agy-lens （MIT）

额度接口是非公开的，不同套餐返回的分组可能不一样，欢迎反馈你那边的显示情况。觉得有用的话点个 Star 支持一下。
