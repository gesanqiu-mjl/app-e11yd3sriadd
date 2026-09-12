# 设计语言 / 骨架 / 构成 / 色彩 / 工艺

> **所有判据都是代码级的**：你看不到渲染结果，自检在动笔前对着要写的 class 做，不是出稿后观察效果。

---

## §0 用户指定优先于本文全部规则

本文规则仅在用户未指定时生效，不否决用户意图。

| 用户指定了 | 处理 |
|---|---|
| 骨架 / 布局方式 | 照做。即使命中 §1.1 的"不适合"判断也照做，把判断作为提醒告知 |
| 配色（色系方向 / hex / spec） | 照做。§3 只在该约束内做明暗/饱和度演绎，不跨色相 |

气质词等其余锁定轴的三稿演绎规则见 `SKILL.md §用户 query 最高优先级`；参考图与品牌资产走 `SKILL.md §分支决策`。

**锁定的具象材质/工艺词写完代码后必须回查可见性**：用户点名"液态渐变"/"磨砂玻璃"/"发丝线"这类具体材质，落地后不是"写了对应 CSS 就算完成"——它必须在首屏视口内实际可辨识。代码级自检：这个元素的 `z-index` 是否被同一 section 内更高 `z-index` 的不透明层（图片/纯色背景/遮罩）盖住？该元素的可见面积是否被裁切到只剩边角？三稿里只有一稿承担某个锁定材质时，那一稿必须实测可见，不能写了代码但被自己稿子里别的图层挡住。

**还要回查有没有落地降级**：拿掉这个材质，版面结构会不会塌？不塌 = 只是贴的底纹装饰，没真正承担锁定词该有的分量（`§sig` 里这算"及格"不算"越级"）。三稿可以在表现强度上分散，但不能三稿都停在最省事的一档。

**唯一不让位的**：核心操作可见、导航可达，以及 `SKILL.md §出稿纪律` 的可读性硬底线（字号 + AA 分档对比度）。冲突先按那一节的出路解（翻 `*-foreground` 一侧），仍无解才停下指出矛盾让用户选。

---

## §1 布局骨架

**骨架 = 结构签名**（导航位置 × 内容区构图 × 滚动方式），属 structure 层，永远从 PRD 长出。骨架名写进 stamp 的 `skeleton:` 段。

下表 12 族是常见起点，**不是选项清单**。模型看到表容易在里面选，导致三稿趋同。**自创骨架 = 一等公民**——满足三条即可：① 说得出导航位置/内容构图/滚动方式三要素 ② kebab-case 3–5 字英文命名 ③ 不复制表内任一族的核心结构。杂交（主骨架 + 局部借用别族要素）与自创同等鼓励。

| 骨架族 | 结构签名 | hero 形态 | 实现要点 |
|---|---|---|---|
| `full-bleed-scenes` 全幅分幕 | 每屏一幕（≈100vh）满幅画面，逐幕推进 | 全屏图/视频占满视口，文字压图 | 每幕 `min-h-screen` + `snap-align`；`snap-type` 用 `y proximity`（`mandatory` 会在后续非分幕 section 上劫持滚动）；snap 容器只包分幕本体 |
| `monumental-hero` 纪念碑首屏 | 首屏 100vh 单一巨物 + 极简文字，之后转常规滚动 | 全屏主体特写，nav 浮层无底 | hero `h-screen` + `object-cover`；nav `absolute` 透明浮在图上；文字 `absolute` 压图 |
| `cinema-scroll` 影院滚动 | 首屏满幅画面固定，内容层在画面上滚过 | 全屏画面为幕布 | 画面层 `sticky top-0 h-screen`，内容层 `relative z-10`；画面加暗场遮罩保文字可读 |
| `vertical-narrative` 竖排叙事 | 顶部导航 + 全宽 section 依序堆叠 | 灵活 | **AI 默认解**——选它必须在段内构图做出记忆点（错位/跨栏/非对称） |
| `split-screen` 分屏对峙 | 视口左右 5:5 或 4:6 两栏，一侧常驻 | 半屏图 + 半屏文 | 常驻侧 `md:sticky top-0 h-screen`；`md` 以下折为上下堆叠 |
| `sidebar-anchor` 侧栏锚点 | 固定侧栏 + 主区滚动，section 编号锚点高亮 | 主区内的图（非全屏） | 侧栏 `md:fixed` + 主区 `md:ml-*`；`md` 以下侧栏收顶部 |
| `bento-grid` 便当盒 | 首屏即大小不一的模块网格拼合 | 格子里一块图 | 显式 `grid-cols/rows` + 卡片跨行列；圆角与缝隙宽度全局统一 |
| `editorial-columns` 杂志多栏 | 多栏排印、rule line 分栏、大字标题跨栏 | 栏内配图 | `grid` + `border-l` 发丝分栏；标题 `col-span-full`；`md` 以下降单栏 |
| `masonry-curation` 瀑布流策展 | 不等高卡片瀑布流为主体，UI 退让 | 无独立 hero，作品即首屏 | `columns-2/3` + `break-inside-avoid`；间距即层级，禁重描边 |
| `canvas-collage` 拼贴画布 | 反网格：模块错位叠放/轻旋转 | 错位叠放的多张图 | `relative` + 负 margin/`translate` 错位、旋转 <5°；`md` 以下回落网格 |
| `feed-stream` 信息流 | 中央单列 feed（60–75ch）+ 两侧辅助栏 | 无独立 hero | 三栏 `grid`，侧栏 `md:sticky`；`md` 以下只留主列 |
| `dense-index` 高密度清单 | 表格/列表密度优先：发丝分割线、极小留白、行内操作 | 无 hero，直接进数据 | `divide-y` 发丝线、`tabular-nums`、hover 行高亮 |

轮播、跑马灯、视频循环、视差、canvas 绘制等**不在表内但完全合法**。三稿至少 1 稿应尝试表外骨架或明显杂交。

### 1.1 适用判断（用户未指定时）

**沉浸式三族**（`full-bleed-scenes` / `monumental-hero` / `cinema-scroll`）：

- 适合：单一主体能撑满一屏的品牌型内容
- 不适合：多功能并列的工具型、信息密集后台、文档、社区 feed、表单流程
- 判据：这个产品有没有一张图能占满一屏还让人想继续看？有 → 沉浸式；是一堆抽象功能点 → 分栏/网格

**并列入口型两族**（`bento-grid` / `dense-index`）——等权模块拼合，无单一视觉重心：

- 适合：入口本身就是内容的产品（工具集合、Dashboard 首页、控制台、功能索引）
- 不适合：landing page / 品牌官网 / 营销页——这类要讲一件事、要有唯一重心，等权格子把叙事拍平成菜单
- 移动端代价：`grid` 折成单列后并列关系消失，骨架签名归零；主视口是移动端时禁选

### 1.2 骨架分散

- 内容形态支持多种骨架 → 三族互异
- 只适合 1–2 类骨架 → 允许同族不同变体，但必须靠 section 权重 + hero 策略补足差异，stamp 用不同 skeleton 名标注（如 `full-bleed-scenes/day` 与 `/night`）
- **禁为凑"三族互异"选与内容形态不符的骨架**——硬套比同族变体更糟

### 1.3 骨架必须落到 class 层

stamp 换个名不算数。动笔前逐 section 确定**这个骨架决定了什么具体写法**：

- `full-bleed-scenes` → 每 section `min-h-screen` + `scroll-snap-align`；不是 `py-24 md:py-40`
- `monumental-hero` → hero `h-screen` + 内容 `absolute inset-x-0 bottom-*`；其余 section 常规 `py-*`
- `split-screen` → `grid md:grid-cols-2` 或 `md:sticky top-0 h-screen` 常驻侧；不是全宽 `container`
- `bento-grid` → 首屏 `grid grid-cols-* grid-rows-* gap-*` + 卡片跨行列；不是逐 section 堆叠
- `editorial-columns` → `grid md:grid-cols-12` + `col-span-*` + `border-l`；不是等宽单栏
- `masonry-curation` → `columns-2 md:columns-3` + `break-inside-avoid`；不是 `grid`
- `canvas-collage` → 容器 `relative` + 子元素 `absolute` 或负 margin；不是 flex/grid 排列

**图片容器同样受骨架约束，不默认统一矩形/圆角**：稿内已经选了 `clip-path` 斜切、不对称圆角或其他几何母题（`§2.1 边缘与切割`），图片容器的裁切形状延用同一母题，不要另起一套默认方形——容器形状是骨架签名的延伸，不是逐张图片单独判断。骨架本身不含异形母题（如 `editorial-columns`）时，图片保持规整矩形即可，不必强加形状。

**判据**：遮住 stamp，只看三稿 section 的 grid/flex/padding 写法，还能分清谁是哪个骨架吗？分不清 = 骨架只停在命名层，三稿实际是同一个"竖排堆叠 + 相同 `py-*` 反复"。

### 1.4 fixed 元素必须让正常流留白

固定顶栏 → 内容顶部 padding ≥ 栏高；垂直居中的首屏内容若超一屏，居中会把顶部推到顶栏下。固定侧栏（竖排目录/进度）→ 主区 `md:ml-*` ≥ 栏宽 + 间距；居中 `container` 的 gutter 随视口收窄，不构成有效留白。

---

## §2 版面构成

骨架定"结构是什么"，构成定"有没有记忆点、眼睛往哪走"。PRD 给内容清单，**视觉重心、留白节奏、布局节奏由你规划**。

### 2.1 张力：每稿至少 3 项

**硬底线**（三条都是可数的）：

- **非对称网格 ≥2 处**：`grid-cols-[1.3fr_1fr]` / `[160px_1fr_1fr]` 等非等分值。禁全页 `grid-cols-N` 等分通天。
- **section 纵向 padding ≥2 档**：如 hero `py-32`、内容 `py-20`、CTA `py-12`。相邻 section 全同 padding = 节奏扁平。
- **display 用 `clamp()`**：hero 主标题 `clamp(min, vw, max)`，与最小元数据字号比 ≥10:1。离散 `text-Nxl` 在大屏撑不住。

**尺度对比**（最廉价的张力来源）：

| 手法 | 做法 |
|---|---|
| 极端字号跳档 | 相邻元素字号比 ≥4:1（display 8rem 紧挨 caption 12px）；常规 1.25 音阶太温和 |
| 单一巨物 | 一个元素占视口 ≥60%，视线有唯一落点而非均匀扫描 |
| 密度反差 | 极密区块（发丝线列表）紧挨极空区块（80% 留白）；疏密本身就是层级 |

**破格**（打破自己刚建立的网格，破格处即记忆点）——**只允许 1–2 处**，全篇都破 = 没有规则：

越界（负 margin / container 内 `w-screen`）/ 跨栏（`col-span-full`）/ 错位（相邻块基线不齐）/ 旋转（单元素 ±1.5°~4°）/ 叠压（图文互相压边而非并排）

**边缘与切割**：`clip-path` 承担结构（斜切分区）/ 满幅出血宣告新章节 / 发丝线与粗边框（0.5px vs 2-4px）不混用 / 不对称圆角（`rounded-tl-3xl rounded-br-3xl`）

**层次不靠阴影**（阴影最易 slop）：重叠 / 同色相不同明度色阶（暗场里 L 差 5–10% 就够，不必换成灰卡片）/ 外描边 / 背景 `blur` + 前景清晰 / 次要元素明显更小。

### 2.2 视觉重心与留白

留白的价值不在"留了多少"，在**它让谁先被看见**。

**每 section 一个主导入口点**——写这个 section 前先定："眼睛第一个落在哪？"

- 一个区块只能有一个主导元素。两个等权 = 没有重心。
- 主导元素靠 **≥2 个向量同向发力**才立得住。
- 其余元素**主动降级**，包括"感觉也很重要"的那些。

| 向量 | 方向 |
|---|---|
| 尺度 | 大 → 主 |
| 字重 | 重 → 主（刻意反转需信息流仍可读） |
| 留白 | **周围空间越大 → 权重越高**（不改字号也能升级） |
| 字距 | 紧 → 快，松 → 仪式感 |
| 对齐 | 打破对齐 = 宣告重要 |

**语义角色 ≠ 视觉角色**：`<h1>` 可以比旁边 `<p>` 更安静，正文可以当 display——条件是线性阅读仍能分辨主/次/附属。

**留白是层级向量不是剩余空间**：元素上方空间表达与前文的关系、下方表达与后文的关系；被大留白包围的孤立元素无论字号多小都读作 display 级；**所有间距一样 = 空间层级为零**（"匀"的直接来源）。

**接近性分组**：**组间距 ≥ 组内距 × 2**。能靠距离分组的不加容器（容器嵌容器是 slop）。

**平衡**：默认不对称（主视觉偏置 + 反侧留白承重）。**居中一切**（标题+正文+CTA 全居中）是最易识别的模板指纹，除非风格明确要求。

**F 型是要打破的**：F 型扫视是缺乏引导时的退化行为。主动给锚点——重要信息放前两屏、标题前两个词承载核心意思；用小标题/分组/粗体关键词把文字墙打断成 layer-cake；链接文案用信息性词（禁"点击这里"/"更多"）。

**两种失败模式**：

| 失败 | 症状 |
|---|---|
| 扁平 | 所有元素权重接近，整页像一面墙 |
| 噪声 | 太多元素争夺主导（全是粗体/大字/强调色） |

### 2.3 动笔前必须答出的两句话

写不出来就是构成没想清楚，不要开始写 class：

1. **"这稿的记忆点是什么？"** ——答"配色"= 张力太弱（配色是气质不是记忆点）；答某个具体构成事件（那个跨栏的巨字 / 那条斜切分割）= 过。
2. **"眼睛从哪进来，然后去哪？"** ——说不出第一落点 = 没有重心；能说出一条与 PRD 信息优先级一致的路径 = 过。

---

## §3 色彩推导

> 配色 base 来自 `recommend_colors.py` + 用户问卷答案。种子模板的色值不参与，只作气质参考。
> 微调权：**chroma ±10% / lightness ±15%**；**色相 H 锁死**（archetype 联想的根在色相）。

### 3.1 三步法

| 步骤 | 做什么 | 为什么 |
|---|---|---|
| **1. 采样** | 主色从三处取，不凭空发明：① 品牌资产吸色 ② 内容真图的主导色 ③ 文化语境（见 §3.3） | 凭空选色 = 从模型先验抽签，抽出来永远那几个网红色 |
| **2. 收敛** | 压到 **2–3 有彩色 + 1 组中性色**。中性色写成明度序列（L 0.15/0.35/0.65/0.92/0.98），有彩色之间 oklch 色相角 ≥60° 或明度差 ≥0.3 | 色多必乱；oklch 的 L 感知均匀，明度序列写出来就是层级系统 |
| **3. 论证** | 一句话写出"为什么是这个色"，落进稿内注释。例："主色取自 logo 赭石，压 chroma 到 0.08 模拟油墨" | **写不出这句 = 在抄配方**，论证是防 slop 的自检门 |

**oklch 只用于推色阶段**。落稿时换算成 **HSL 裸三元组**写入 DESIGN-TOKENS / CUSTOM-TOKENS 块（`apply_design_tokens.py --html <稿路径> --check` 校验）。

### 3.2 印刷色质感

| 用途 | oklch chroma | 效果 |
|---|---|---|
| 大面积底色 | 0.01–0.04 | 纸感、不刺眼 |
| 品牌主色/强调 | 0.08–0.15 | 油墨感，醒目但不塑料 |
| 小面积点睛（按钮/链接） | 0.15–0.22 | 保留活力，仅限小面积 |
| >0.25 满版铺 | 慎用 | 屏幕荧光感，只适合刻意"电子原生" |

### 3.3 文化语境：同一色相，不同坐标

| 色相 | 语境 A | 语境 B | 差在哪 |
|---|---|---|---|
| 红 | 朱红（偏橙带灰，低 L 低 C）→ 传统/庄重 | 高饱和正红 → 消费/兴奋 | chroma 一降，从货架跳到宫墙 |
| 蓝 | 蓝染/琉璃绀（深、偏紫灰）→ 手工/沉静 | 科技蓝 #0066FF 系 → 工具/效率 | 后者是模型最爱的默认蓝，用前先问是不是在抽签 |
| 绿 | 抹茶/苔绿（黄相、低饱和）→ 自然 | 荧光绿 #39FF14 → 终端/hacker | 同为绿，一个喝茶一个敲代码 |
| 黄 | 藤黄/芥末（带棕灰）→ 复古印刷 | 警示黄 → 醒目/玩味 | 灰度决定它是旧书页还是安全帽 |
| 白 | 奶油纸白 #F5F0E8 → 出版物/暖 | 纯白 #FFF → 实验室/瑞士 | 底色 2% 色温差就是气质分野 |

---

## §4 落地页规格

- 主视口：H5 应用按 375px 宽设计，其余按 1440px 宽；内容区收口用 `container`（居中、padding 2rem、最大 1400px，`base.html` 已配好），响应至 320px，**断点只用 `md`**
- 内容节奏参考：问题 → 方案 → 证明 → 行动（**叙事顺序**，不规定版式）
- 配图规格：16:9（1200×675）最通用；1:1（800×800）适合强调；4:3（1200×900）适合信息密集。素材职责见 `asset-direction.md`

---

## §5 CSS 与创意工艺

### 5.1 现代 CSS 特性

```css
/* 排版：白拿的品质税 */
h1, h2, h3 { text-wrap: balance; }   /* 消灭标题孤字行，≤4 行有效 */
p          { text-wrap: pretty; }    /* 消灭正文行尾孤词 */

.glass { backdrop-filter: blur(20px) saturate(150%); }  /* 别叠加 */

/* 横向滚动带：默认滚动条破 vibe，但隐藏后必须补可滑提示，三选一 */
/* ① 改窄取 token 色 */
.sig-hscroll-thin::-webkit-scrollbar { height: 6px; }
.sig-hscroll-thin::-webkit-scrollbar-thumb { background: hsl(var(--border)); border-radius: 3px; }
/* ② 隐藏 + 右边缘渐隐（父容器 relative） */
.sig-hscroll { scrollbar-width: none; }
.sig-hscroll::-webkit-scrollbar { display: none; }
.sig-hscroll-fade::after {
  content: ""; position: absolute; inset-block: 0; right: 0; width: 5rem; pointer-events: none;
  background: linear-gradient(to left, hsl(var(--background)), transparent);
}
/* ③ 隐藏 + 首次入视口自滑一小段 */
```

`base.html` 是 Tailwind v3 CDN + 语义 token 类；上面这些原生 CSS 写在稿内 `SIGNATURE-CSS` 块（`sig-` 前缀类），不与 Tailwind 冲突。

**方案③**（`MOTION-SCRIPT` 块，一次性 hint 不占循环名额）：

```js
inView('.sig-hscroll', (el) => {
  const step = el.clientWidth * 0.4;
  el.scrollTo({ left: step, behavior: 'smooth' });
  setTimeout(() => el.scrollTo({ left: 0, behavior: 'smooth' }), 900);
}, { margin: '0px 0px -30% 0px' });
```

禁 `setInterval` 做成无限自动滚动——会和用户手动拖拽打架，且占 `SKILL.md §同屏持续循环 ≤1` 的名额。

### 5.2 CSS 装饰物件

用渐变叠层、伪元素、box-shadow 画**抽象/象征化的装饰物件**。禁画人物、真实产品外观、具体场景——那些走 image_search 或可灵（`anti-slop.md` 硬约束 7）。

| 手法 | 实现要点 |
|---|---|
| 渐变叠层色块 | `::before` 多层 `linear-gradient` + `radial-gradient`；`::after` 底部渐隐 |
| 实心偏移投影堆叠 | `box-shadow: 18px 12px 0 <color>`（无模糊）造厚度或叠放关系 |
| 陈列架 | 不等高子元素 + `::after` 当搁板（`background` + `box-shadow` 做板厚） |
| 拱形/异形裁切 | `border-radius: 180px 180px 24px 24px` 四角不对称；或四角百分比（如 `48% 52% 38% 62%`）+ 轻旋转，得有机弧形 |
| mark 拼装 | 一个基础形状 + 伪元素旋转 pill/圆 |
| 纸面纹理 | `repeating-linear-gradient` 画横格 + 旋转 `::before` 画装订线 |

**代码级达标判据**（三条全中才算装饰物件，否则是几何拼装）：

1. **≥2 个视觉层**：本体 + 至少一个伪元素或绝对定位子元素，且层间有尺寸或位置偏移
2. **光源方向一致**：全部渐变角度与投影偏移方向同向（如都从左上打光 → `linear-gradient(135deg,…)` + `box-shadow: 8px 8px 0`），不能一层左上一层右下
3. **尺寸非等分**：子元素宽高不是等分复制（等高等宽重复 = 图表不是物件）

**用途边界**：只做 sig 越级细节的载体或 section 内装饰。首轮三稿 hero 走 `asset-direction.md §8` 优先级 0 生图，CSS 物件不替代 hero。

**重复卡片网格的叠层写法**：`background` 逐卡换成不同角度/色块组合的 `linear-gradient` + `radial-gradient`（同色板取色，角度或断点错开），零延迟。

### 5.3 状态联动

`data-*` 属性 + CSS 属性选择器：JS 只改父节点数据，CSS 负责全部视觉状态。零动画库、可键盘访问、脚本失败时降级为默认态。

适用不限于 SVG 路径联动——任意"点选列表项 → 关联区域内容随之切换"的交互都走这套机制：`aria-pressed`/`aria-selected` 记录选中态，JS 只切属性和替换文本节点，不用状态管理库。

以下示例中 `--sig-muted`/`--sig-accent`/`--tilt` 是 CUSTOM-TOKENS 块里自声明的变量，取值与引用规则见 §5.5。

```html
<div class="sig-hub" data-active="2">
  <svg><path class="sig-route-1" d="..."/><path class="sig-route-2" d="..."/></svg>
  <button class="sig-node sig-node-1" aria-pressed="false">...</button>
  <button class="sig-node sig-node-2" aria-pressed="true">...</button>
</div>
```
```css
/* CUSTOM-TOKENS block */
:root { --sig-muted: hsl(var(--muted)); --sig-accent: hsl(var(--accent)); }

/* SIGNATURE-CSS block */
.sig-route-1, .sig-route-2 { stroke-dasharray: 4 6; stroke: var(--sig-muted); }
.sig-hub[data-active="1"] .sig-route-1 { stroke: var(--sig-accent); stroke-dasharray: 1 0; stroke-width: 2; }
.sig-hub[data-active="2"] .sig-route-2 { stroke: var(--sig-accent); stroke-dasharray: 1 0; stroke-width: 2; }
.sig-node-1 { --tilt: -1.5deg; }
.sig-node-2 { --tilt: 2deg; }
.sig-node:hover { translate: 0 -4px; rotate: var(--tilt); }  /* 独立属性，不与入场的 transform 抢 */
```

适用：关系图、流程步骤、功能切换演示、测评类交互。

### 5.4 张力手法的具体写法

| 手法 | CSS |
|---|---|
| 标题内关键词强调色 | `h1 em { font-style: normal; color: hsl(var(--accent)); }` |
| 1px gap 当发丝分割线 | 容器 `display: grid; gap: 1px; background: hsl(var(--border));` + 子元素 `background: hsl(var(--background));` |
| 无模糊硬阴影按钮 | `box-shadow: 4px 4px 0 hsl(var(--accent));` hover `translate(-2px,-2px)` + 阴影 `6px 6px 0` |
| 巨字溢出容器 | `width: max-content; white-space: nowrap; transform: translateX(-6%); font-size: clamp(50px,7vw,116px); letter-spacing: -.04em;`（仅西文，中文见 `typography.md §4.0`） |
| 竖排标题/页码 | `writing-mode: vertical-rl;`（中文独有的 display 武器） |
| 派生浅色不新增 token | `color-mix(in srgb, hsl(var(--accent)) 18%, hsl(var(--background)))` |

### 5.5 一稿内的共享 token

同一稿内跨 section 一致的是**最小 token 集** + `.eyebrow` 类微组件 + CTA 家族样式；允许逐 section 变化的是构图 anchor、背景 mode、section 尺度。

这些自定义变量声明在 CUSTOM-TOKENS 块里，**补充** base.html 的语义 token，不替换它们。`sig-` 类的颜色只从这里取，或直接写完整色值——**不直接 `var(--accent)` 引 base token**，那是裸三元组，放进 `stroke`/`fill`/`box-shadow` 的颜色位无效。

```css
/* CUSTOM-TOKENS block — values are complete colors, sig-prefixed classes引用它们 */
:root {
  --sig-paper: #f7f1e6;
  --sig-accent: #ba871d;
  --sig-ease-out: cubic-bezier(.23, 1, .32, 1);
}
```

`--sig-*` 定义值若已是完整色值（`hsl()`/`#hex`/`rgb()`），使用处直接 `var(--sig-xxx)`，禁再套 `hsl()`——套了展开成 `hsl(hsl(...))` 无效。只有值为裸三元组（如 `348 76% 45%`）时才需 `hsl(var(--sig-xxx))`。

**三稿不能只有这组 token 不同**——骨架必须另做差异，见 §1.2。
