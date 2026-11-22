# V2EX 发布帖

**节点：** 分享创造（/go/create）

**标题：** Agy Lens：给 Antigravity 2.0 做了个本地用量驾驶舱，上下文 / tok/s / 5 小时与每周额度一屏看清

---

用 Antigravity 2.0 一段时间了，发现自己总在两件事上踩坑：不知道离 5 小时限额还有多远，以及上下文超出请求预算后被悄悄裁剪。于是写了 **Agy Lens**，一个开源的侧边栏插件。

主要功能：

- 当前对话的上下文按类别拆解（与 agy CLI `/context` 同口径，基于真实 Token 记录），接近请求预算时提醒
- 流式输出速度、首字延迟、缓存命中率，按模型拆分
- 官方 5 小时与每周额度、重置倒计时
- 桌面端 + CLI 的历史用量：热力图、子智能体汇总排行、公开价费用估算、官方周额度 100% 估值与各项目占比（支持对比历周额度变化）
- 脱敏分享卡片（SVG / PNG），只含聚合数字
- 终端命令：`npx github:Aoike123/agy-lens`

实现上完全跑在 Antigravity 自带的 Node.js 24 里：`node:sqlite` 只读打开本地会话库，自己解 protobuf；额度通过应用本地语言服务器获取。没有 npm 依赖，不需要 Python，不调用模型，刷新不花 Token，默认不联网。

截图：（贴 `docs/img/hero-zh.png`）

安装（Windows）：

```
irm https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.ps1 | iex
```

macOS / Linux：

```
curl -fsSL https://raw.githubusercontent.com/Aoike123/agy-lens/main/scripts/install.sh | bash
```

GitHub：https://github.com/Aoike123/agy-lens

MIT 协议，欢迎提 Issue 和 PR。额度相关接口是非公开的，如果你的套餐显示不对，麻烦反馈一下。
