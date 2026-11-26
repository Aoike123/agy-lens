# 交接：分享卡片「小游戏化 + 像素美术」

状态：**半成品，全部未提交**。代码侧的素材处理流程可用、测试通过；美术素材只做出了一个角色的一部分；分享卡本身（UI、对战动画、PK 码）一行都还没写。

## 1. 需求（用户已拍板的部分）

- 分享卡做成微信里可传播的小游戏，只做两个玩法：
  1. **像素·角色卡 + 成就**（职业、等级、稀有度、六维、成就墙）
  2. **PK 码对战**（复制 PK 码 → 好友粘贴 → 生成对战；挑战书卡和战斗结果卡都可分享；对战要有动画）
- 明暗两个按钮合并成一个「风格」选择器：简约·深色、简约·浅色、像素·角色卡、像素·PK 对战。
- **全部横版**（1200×630）。简约卡也要重做，用户觉得现在发出去单薄、精细度不够。
- 换算文案（「≈ N 本小说」之类）要做成**文案库轮换**，不要 emoji。
- **按套餐换算六维**，否则不同套餐 PK 不公平（插件已有周额度美元估值 `weekly_value_usd`、套餐 `tier`，可用作分母）。
- 战绩写进**插件数据目录**；同一对手 PK 码只计一次；周期不同照样开打，卡上标注；支持可选昵称（写进 PK 码，需脱敏）。
- 成就名要有梗：12 个用量成就 + 8 个战斗成就（卷王、论战吧吧主、六边形战士、以下克上、端水大师、菜就多练、被按在地上摩擦…），完整列表见 `docs/share-art-prompts.md` 徽章部分和 v2 视觉稿。
- 美术标准：**按数字艺术标准的精品像素画**。画风已定为「精致写实比例（约 5.5 头身）、层次丰富服装、每材质 5–7 级冷暖明暗、彩色描边、暖主光 + 青色边缘光」。**不要宝可梦式 Q 版形象**。场景氛围参考 GBA 掌机 RPG 的现代自制重制，但必须是原创。
- 素材由**图像模型生成**（用户在 Google Flow 上有足够算力，可无限试错），代码负责清理、拼合、动画。用户要求场景**拆层生成再拼合**。
- 动作用**模型直接生成连续帧序列图**（用户明确否决了「拆部件 + 代码骨骼动画」和「一帧一帧单独生成整图」）。

## 2. 已完成的代码（未提交）

| 文件 | 作用 |
|---|---|
| `scripts/share-art/png.mjs` | 零依赖 PNG 读写 |
| `scripts/share-art/shade.mjs` | 「着色图层」：抠洋红背景（边缘泛洪 + 去溢色 `suppressSpill`）、按块投票对齐像素网格、锁定 17×9 色阶调色板、清理杂点/边缘、选择性描边；序列图切帧 `sliceGrid`（按行找最空列切分，支持 `@N` 横条和 `@CxR` 网格） |
| `scripts/share-art/build.mjs` | `npm run art`：按 `art-src/roster.json` 核对角色、待机与决斗场。`--shade`：`art-raw/inbox/*.png` → `art-out/`（对比预览、拼好的场景）→ `sidecars/agy-lens/web/views/share-assets.js`。素材尺寸规则在 `NAMED_SPECS` / `ASSET_SPECS` |
| `scripts/share-art/grab.ps1` | 把「下载」文件夹里最新的图转成 PNG 存进 `art-src\<Name>.png`（整理后请改存到 `art-raw\inbox\`）（Flow 下载的是 JPEG） |
| `tests/test_share_art.mjs` | 9 个测试；`npm test` 全部 87 项通过 |
| `docs/share-art.md` | 流程说明 + 素材清单（**已过时**，见第 5 节） |
| `docs/share-art-prompts.md` | 109 条拼好的提示词（**已过时**：还是 Q 版画风和横条布局） |
| `package.json` / `.gitignore` | 加了 `art` 脚本；忽略 `art-out/` |
| `art-raw/obsolete/ref-alchemist-master.png` | 旧画风炼金术士主图，已作废 |
| `docs/handoff/share-cards-mockup-v2.html` | v2 视觉稿（对战动画、角色档案、挑战书、横版简约卡、文案库）。像素部分是代码手绘的，用户认为太粗糙，**只当布局参考** |

v1 视觉稿已发布为私有页面：https://claude.ai/artifact/STGAvUCkgL3vcxUHQFDqXv （竖版，已被否决，仅供参考）。

角色素材原生尺寸目前设为 **192×128**（宽留给出拳/伸臂），立绘 128×128。

## 3. Google Flow 上已达标的素材

项目：https://flow.google.com/u/1/project/af387504-2e2f-4d22-831c-866727169d1a
炼金术士所有版本都在同一个编辑条目里：`/edit/2e996201-258a-4834-8b7f-4fa701c1c1fa`，在右侧 History 面板里选版本。下表的「key」是图片 URL 里 `/asb/` 后的前 40 个字符，可用来在页面里定位版本。

| 存为（art-src） | key | 说明 |
|---|---|---|
| 主图 / 风格基准（已下载为 `ref-alchemist-master.png`） | `ANqvLOZkh4vloXCfYugTRomFgp0w79gMp_bVDrbK` | 全身，面朝右，3:4 |
| `char-alchemist-idle@2x2.png` | `ANqvLOZJ5YhKXT3f8ARIb4iPcB4HXTFEdF3t0nWV` | 待机 4 帧，3:4 |
| `char-alchemist-attack@2x2.png` | `ANqvLOanw_B98VmS0m6wGHfoG_Z7c0bCCdd3DeqP` | 攻击 4 帧，4:3 |
| `char-alchemist-cast@2x2.png` | `ANqvLOalwSRwjedadi3moGMtcihQZD2n0h5MQ8-z` | 施法 4 帧，4:3 |
| `char-alchemist-hurt@2x2.png` | `ANqvLObwZD_Bb40w4YfoIVF5ndKPKGsY2oenmdb0` | 受击 4 帧，4:3 |

除主图外都**还没下载**。倒下（faint，16:9）已提交生成，被中断时尚未检查结果；胜利（victory）未做。其余 6 个职业、立绘、特效、场景图层、小镇、徽章全部未做。

## 4. 验证过的生成方法（照这个做）

1. **先定每个角色的主图**：3:4、全身、面朝右、洋红 `#FF00FF` 背景，用统一画风提示词（见第 1 节画风描述）。
2. **动作序列图在主图的编辑页里生成**：在 History 选中主图版本 → 底部「What do you want to change?」输入提示词 → 回车。以主图为底图，角色一致性最好。
   - 设置里选输出比例：攻击/施法/受击/胜利用 **4:3**，倒地用 **16:9**（用户建议统一用 16:9，空间更足）。待机用 3:4 也通过了。
   - 提示词要点（专业术语）：`game-ready sprite sheet`、`model sheet`、`2x2 grid of equal frame cells`、`consistent registration / same fixed camera / same ground line / feet anchored to the same pivot`、`pose-to-pose`（anticipation / action / strike / recovery 等）、`every element stays strictly inside its own cell, nothing crosses the center lines`、`unlit cut-out sprites: no cast shadow, no drop shadow, no contact shadow`。
   - 不让道具「飞出去」：投掷类动作让道具始终在手里，飞行物和拖尾由代码特效画。
3. **判定标准**（每张都要过）：帧格不越界、无投影、与主图一致、面朝右、动作阶段可读、像素干净。
4. 在页面里选版本的稳妥办法：用 JS 按 key 找 History 缩略图并点击（坐标点击经常点错）。

## 5. 踩过的坑

- 横向一排 4 帧（4:1 或 16:9 单行）：模型不守间距，人物互相越界。改 2×2 网格后解决。
- 3:4 格子做攻击：伸臂和特效越过中线。改 4:3/16:9 解决。
- 单帧逐张编辑（眨眼、蓄力…）：单张都对，但帧间会抖，用户否决。
- 编辑模式下要求「平移角色」无效，模型不会移动构图。
- 模型会擅自加脚下投影，需在提示词里明确禁止。
- **下载**：内置浏览器每次下载都弹「另存为」对话框，需要用户点保存，不能静默批量；Flow 没有批量下载。文件是 JPEG，`grab.ps1` 负责转 PNG。可以考虑让用户装 Claude in Chrome 并关掉 Chrome 的「下载前询问保存位置」。
- 着色流程对精致画风：额外的「重新打光」会破坏原图明暗，已默认关闭（`lighting: false`），保留选择性描边；溢色抑制已加。
- 各动作序列图里人物大小不同；现在每个序列按其最高帧缩放，并把角色画布加宽到 192×128。**还没用真实序列图跑过**，需要验证不同动作之间身高是否一致。

## 6. 下一步（建议顺序）

1. 回 Flow 检查倒下序列图，补胜利序列图；把第 3 节的图逐个下载（选版本 → 右上下载 → 1K → 用户点保存 → `grab.ps1 -Name <文件名>`）。
2. `node scripts/share-art/build.mjs --shade`，打开 `art-out/preview.html` 检查切帧、缩放一致性、描边效果，必要时调 `shade.mjs`。
3. 用同样方法做狂战士（第一批对战需要两个角色），再做战斗场景图层（`layer-sky-day`、`layer-field`、两个平台）和 `fx-hit`、`fx-vs-burst`。
4. 按新画风和 2×2 网格方法**重写** `docs/share-art-prompts.md`，并更新 `docs/share-art.md` 的尺寸表。
5. 开始写分享卡代码：风格选择器、横版简约卡重做 + 文案库、像素角色卡、PK 码编解码（含套餐换算、昵称、校验位）、战绩存储（插件数据目录）、对战动画与战斗结果卡、导出 PNG（现在 `exportShareCardPng` 写死了 1200×630，横版正好可用）。现有分享卡代码在 `sidecars/agy-lens/web/views/share-card.js`，e2e 测试里点击了 `[data-share-theme="light"]`，换成风格选择器时要同步改。

## 7. 和用户协作的注意事项

- 用户希望先讨论设计再动手；重大方向变化先确认。
- 判断素材是否达标要**严格**，用户认为我之前放得太松。
- 用户授权：可自由在 Flow 提交生成、可下载（但下载会弹对话框，需要用户点保存）。
