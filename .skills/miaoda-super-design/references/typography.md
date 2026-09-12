# Typography：排印推理系统

> **字体铁则**：只能用 `data/fonts.csv` 里的字体（BOS 自托管，`@font-face` 引入）+ 系统兜底链。**禁引 Google Fonts 或任何库外字体 CDN**。不翻 csv 原文，跑脚本：
>
> ```bash
> python3 scripts/search_fonts.py "<英文气质/场景关键词>" [--usage body|heading] [--lang zh|tc|ja|latin] [-n 5]
> python3 scripts/search_fonts.py --name "得意黑"   # 已知名字时精确查
> python3 scripts/search_fonts.py --list            # 浏览全库概览
> ```
>
> 有品牌字体规范时先 lift 用户自己的（`asset-direction.md §0`）；用户指定的字体不在库里，说明并给库内最近气质的替代。品牌字体清单只用于识别，落地一律走 `search_fonts.py` 找库内替代。

## 0. 排印决策顺序

拿到内容后按这个顺序推，每一步都由上一步决定，不许跳到「直接选个好看的字体」：

1. **内容类型** → 长文阅读 / 数据密集 / 营销大字 / UI 界面，决定音阶比例和正文字号
2. **语言构成** → 纯中文 / 中西混排 / 纯西文，决定 fallback 链写法和行高基准；**中文正文必须带 `--lang zh` 检索**
3. **风格温度** → 把气质定性成大胆/中性/安静，决定字体配对的对比度来源（见 §3 温度列）
4. **最后才是字体名** → 把前三步凝成 3-8 个气质词，跑 `search_fonts.py`，从候选里定 display + body——**拿到结果后先读每条候选的 `weights:` 和 `mood:` 再落笔**，不要只取 font-family 名字就走，字重列表和气质词决定了 §4.6 该走哪条技法

为什么：先选字体名的做法，会让「内容是什么」对排印零影响，这正是千人一面的病根。

## 1. 字号音阶（modular scale）

字号不是拍脑袋，是从正文字号乘一个固定比例逐级推出来的。比例决定页面的「戏剧性」：

| 比例 | 名字 | 性格 | 适用 |
|------|------|------|------|
| 1.2 | 小三度 | 平缓、层级多而不吵 | dashboard、文档站、信息密集 UI |
| 1.25 | 大三度 | 通用、安全 | 大多数网页、产品落地页 |
| 1.333 | 纯四度 | 标题明显跳出 | editorial 长文、营销页、报告 |
| 1.5 | 纯五度 | 戏剧性、层级极少 | 大字报、slides、hero 一屏一句 |

**推导规则**：正文定 16-18px（中文正文建议 17-18px，汉字笔画密、同字号比西文显挤），然后按比例上推标题、下推 caption。层级超过 5 档就是失控，砍掉。

| 档位 | 1.25 比例下的参考值 | 用途 |
|------|--------------------|------|
| caption | 12-13px | 图注、meta 信息、EXIF 式小字 |
| small | 14px | 辅助说明、表格 |
| body | 16-18px | 正文，一切的基准 |
| h3 | ≈1.25x | 小节标题 |
| h2 | ≈1.56x | 章节标题 |
| h1 | ≈1.95x | 页面标题 |
| display | 3x-8x，脱离音阶自由发挥 | hero 巨字，由版面而非音阶决定 |

**流式字号写法**（display 档必用，避免大屏死板小屏溢出）：

```css
/* clamp(最小值, 首选值, 最大值)：首选值 = 基础rem + 视口系数 */
h1 { font-size: clamp(2rem, 1.2rem + 3.5vw, 4.5rem); }
.display { font-size: clamp(3rem, 1rem + 9vw, 9rem); }
/* 正文不要 clamp 出大幅波动，16→18 的窄区间即可 */
body { font-size: clamp(1rem, 0.95rem + 0.3vw, 1.125rem); }
```

为什么 display 脱离音阶：hero 巨字是版面元素不是文本层级，它的尺寸由「占视口几成」决定，用 vw 推导比用音阶推导更合理。

## 2. 行长与行高

### 行长（比字体选择更影响可读性）

| 语言 | 舒适区 | CSS 实现 |
|------|--------|----------|
| 西文正文 | 45-75 字符，最佳 66 | `max-width: 65ch` |
| 中文正文 | 一行 22-38 字，最佳 28-32 字 | `max-width: 36em`（em 随字号缩放） |
| 图注/侧栏 | 更短，中文 15-20 字 | 窄容器天然限制 |

为什么中文更短：汉字是无空格的致密方块字，同宽度下承载的信息量明显高于西文，同样的眼跳次数中文读进更多内容，行太长回行时找不到下一行开头。

### 行高随行长联动

行高不是常数，是行长的函数。行越长，眼睛回行距离越远，需要更大的行间距当「轨道」：

| 场景 | 西文 | 中文 |
|------|------|------|
| display 大字（1-2 行） | 0.95-1.1 | 1.1-1.25 |
| 标题（h1-h3） | 1.1-1.3 | 1.3-1.4 |
| 短行正文（<30 字/行） | 1.4-1.5 | 1.6-1.7 |
| 长行正文（接近上限） | 1.6 | 1.8-2.0 |

中文全线比西文高 0.2 左右：汉字是满格方块，没有西文小写字母之间的天然空隙，行距不足会糊成一片。

### text-wrap（2024+ 浏览器都支持了，白拿的排印质量）

```css
h1, h2, h3 { text-wrap: balance; }  /* 标题多行时各行长度均衡，消灭孤字行 */
p { text-wrap: pretty; }            /* 正文消灭行尾孤词（西文效果明显，中文轻微） */
```

balance 只用于 ≤4 行的标题（算法限制 6 行且有性能成本）；pretty 全局给正文无副作用。

## 3. 配对逻辑与库内示例（西文）

配对的三种对比度来源，配之前先想清楚用哪种，再拿对比度来源的词去检索：

- **形式对比**：衬线 display x 无衬线 body（最经典，但要 x-height 咬合，否则视觉字号跳）
- **同族/同气质咬合**：设计骨架接近的两款（零风险，代价是平淡）
- **时代对比**：古典字形 x 现代字形（谱系差 200 年以上才有张力，差 50 年只显得乱）

**西文 display 必须收紧字距**：大字号把字间空隙一起放大，`letter-spacing` 要往负值走（`-0.01em ~ -0.04em`）。加正值是 AI 的常见反向操作，标题会松垮得像临时占位。中文相反，禁负字距，见 §4.0 / §4.5。

下表全部来自可用字体库，是「配对逻辑长什么样」的示例，不是白名单——按同样逻辑检索出的其他库内组合同样合法：

| # | 配对（display + body） | 配对逻辑 | 温度 |
|---|------------------------|----------|------|
| 1 | Literata + Source Sans 3 | 形式对比：屏显阅读衬线 x Adobe 屏显 sans，长文/内容站零翻车 | 安静 |
| 2 | EB Garamond + IBM Plex Sans | 时代对比：16 世纪法国老衬线 x 2017 理性 grotesque，差 400 年的张力；Garamond x-height 低，同行混用需字号补偿（+8% 起，系统解法 `font-size-adjust`，见第 4 章） | 安静/文气 |
| 3 | Libre Baskerville + Karla | 形式对比：古典书籍衬线屏显复刻 x 小字高可读 grotesque | 安静 |
| 4 | Lora + Work Sans | 形式对比：笔刷感衬线中等反差 x 功能性 grotesque，屏显耐看 | 中性 |
| 5 | Sora + Inter | 同气质咬合：产品感 display x UI 工蜂正文，科技产品页安全解 | 中性/技术 |
| 6 | Zilla Slab + Open Sans | 反转结构：slab 衬线当 display，技术又友好，文档/开源项目感 | 中性 |
| 7 | Anton + Inter | 大字报结构：窄长超黑压场，Inter 只当 14-16px 正文工蜂（这是 Inter 的正确用法，作 display 见 `anti-slop.md` 硬约束 5） | 大胆 |
| 8 | Cormorant Garamond + Work Sans | 高反差奢侈感：Cormorant 笔画极细，**必须 ≥40px 才成立**，小字号笔画会断；时尚/图录风 | 大胆 |
| 9 | Syne + DM Sans | 先锋结构：Syne 非常规字形只做大字，配中性几何正文形成怪 x 稳 | 大胆 |
| 10 | 思源等宽（Source Han Mono SC）+ IBM Plex Sans | 等宽当配角：命令行感、工程感；等宽只用于标签/编号/代码，整段正文用等宽是灾难（行长膨胀 30%） | 中性/技术 |

**已被用烂的字体清单 → `anti-slop.md §分类黑名单 / 字体`**（单一归属，本文不重复；那里列了 Inter/Space Grotesk/Playfair/Fraunces 当 display 的问题与库内平替）。

**表里是库内显示名，不是 CSS 值**：写进 `@font-face` 与 `font-family` 的必须是 `search_fonts.py` 输出的 `font-family:` 那一行，通常是去空格形式（`Source Sans 3` → `SourceSans3`、`EB Garamond` → `EBGaramond`、`IBM Plex Sans` → `IBMPlexSans`）。照表里的带空格名字写，`@font-face` 与引用处对不上，整页静默回落系统字体，`font-registration` 会拦。

## 4. 中文排印（本文最重的一章）

西文排印有百年成熟工具链，中文没有。AI 设计工具在中文上集体摆烂（默认交给系统字体、直接套西文规则），这里是差异化所在。

### 4.0 中文排版硬门槛（一句话版，细则见下）

中文是独立排印系统，**禁止直接套用西文参数**。以下是硬底线，违反即判失败、先重排再继续：

- **禁负字距**：中文标题与正文都不用 `letter-spacing` 负值（西文式 display 收紧对汉字是笔画打架）；display 巨字最多 `-0.02em`，见 §4.5。
- **行高按脚本分设**：中文标题 `line-height 1.12–1.30`，中文正文 `1.6–1.9`；比同场景西文高 ≈0.2。
- **字距按 script run 分设**：西文标签/数字的 `tracking`、窄行距 token **不许 cascade 到相邻中文**——混排时中西各设各的。
- **失败信号**：标题字形贴连、标点拥挤、行间粘连、必须缩小页面才读得清 = 硬失败。

### 4.1 中文字体选型（库内款一律走脚本检索）

库内简体可用款用 `search_fonts.py --lang zh` 取，角色/气质/字重看它输出的 `category` / `usage` / `mood` / `weights` 四行——**不要凭记忆写字体名，也不要照任何静态清单**，csv 会变，脚本不会漂。单字重字体做不出 §4.6 的字重对比，选它就要先想好用字号/字族/笔画密度承担对比。

选型推理：**正文只在黑/宋/圆/楷里选**（`search_fonts.py --usage body` 已自动排除 display/handwriting/pixel）；display 想要个性时才去动得意黑/老宋系/书法体。中文字体一个顶西文十个（单文件大），**一页最多两个中文字体家族**，为加载和统一性两个原因。

> 注意：思源黑体（Noto Sans SC）、霞鹜文楷**不在库里**（但思源宋体在），别凭记忆写进 @font-face；拿不准就 `--name` 查一下，查不到脚本会直接说 not found 并给 mood 词。

### 4.2 中西混排规则

**fallback 链是第一杠杆**：中文字体自带的西文字符普遍难看，把西文字体放在前面，拉丁字符和数字被它接住，汉字自动落到后面的中文字体：

```css
/* 西文在前，中文在后（两者都来自库、@font-face 引入），系统中文兜底，泛型收尾 */
font-family: "Inter", "MiSans", "PingFang SC", "Microsoft YaHei", sans-serif;
/* 衬线同理 */
font-family: "Literata", "Source Han Serif CN", "Songti SC", serif;
```

为什么这个顺序：font-family 是逐字符匹配的，西文字体不含 CJK 码位，汉字自然穿透到中文字体。反过来写（中文在前）西文字符全被中文字体吃掉，等于白配。

**字号补偿**：同字号下西文小写视觉偏小（x-height 只占字身一半，汉字占满）。两种解法：

```css
/* 解法一：font-size-adjust 让 fallback 字体按 x-height 归一（Chrome 127+/FF/Safari 17+） */
:root { font-size-adjust: from-font; }
/* 解法二：选 x-height 高的西文体（Inter/Source Sans 3/Lato 都高），混排天然齐 */
```

**baseline 对齐**：中西 baseline 不一致时症状是英文单词在中文行里「下沉」。优先换 x-height 更高的西文体；个别 display 场景用 `vertical-align: -0.02em~-0.06em` 微调西文 span，正文别这么修（维护成本大于收益）。

**数字规则**：数字一律走西文字体（fallback 链已保证），数据表格必须加 `font-variant-numeric: tabular-nums`，否则 1 和 8 宽度不同，列会抖。

**中英之间不加空格**：靠 fallback 链的字体本身留白，不靠手动敲空格。

### 4.3 中文没有斜体

中文字形没有 italic 传统，浏览器遇到 `font-style: italic` 会机械倾斜汉字（faux italic），笔画变形、极丑。强调手段替换表：

| 西文习惯 | 中文替代 | CSS |
|----------|----------|-----|
| italic 强调 | 换字重 | `font-weight: 600`（前提：字体真有这档字重，看 csv 的 Weights 列） |
| italic 书名/引用 | 底色高亮 | `background: linear-gradient(transparent 60%, #FFE9A8 60%)` 荧光笔式 |
| italic 引文块 | 换字体 | 引文整段换楷体（方正楷体/江西拙楷），楷体本身就是中文的「引用语气」 |
| italic 专名 | 颜色/着重号 | `text-emphasis: dot`（着重号，中文原生强调，支持度已可用） |

保险丝：`font-synthesis: none;` 全局禁掉合成斜体和合成加粗，宁可不强调也不接受变形字。**尤其注意**：库里不少个性字体只有 Regular 一档（看 Weights 列），对它们写 `font-weight: 700` 只会得到合成加粗的墨团。

### 4.4 标点规范

| 规则 | 做法 | 为什么 |
|------|------|--------|
| 引号 | 直角引号「」『』，不用弯引号 "" | 弯引号在中文字体里是全角占位但形状是西文的，视觉漂浮 |
| 避头尾 | `line-break: strict;` | 禁止句号逗号出现在行首、开引号出现在行尾，这是中文排版的底线 |
| 标点悬挂 | `hanging-punctuation: first allow-end;`（仅 Safari）；跨浏览器用 `text-indent: -0.5em` 处理段首开引号 | 段首的开引号不悬挂会让首行看起来缩进了半格，视觉左边缘不齐 |
| 连续标点挤压 | `font-feature-settings: "halt";`（行尾挤压）或 `"palt"`（全比例宽度，需配合 letter-spacing） | 全角标点连排（如「）。」）会出现一个半字宽的空洞，halt 收窄它 |

### 4.5 中文 letter-spacing 区间

| 场景 | 区间 | 为什么 |
|------|------|--------|
| 正文 | 0 至 0.05em | 微加字距提升透气度；超过 0.05em 词的完形被打散，读速下降 |
| 标题（24-48px） | 0 | 汉字方块字距天然均匀，不需要西文式 tracking 调整 |
| display 巨字（>60px） | -0.02em 至 0 | 大字号下字面之间的空隙被放大，微收更紧凑；再负就笔画相撞 |
| 全大写西文小标签 | 0.08-0.15em | 唯一需要大正字距的场景，且只对西文大写生效 |

**中文永远不要用西文那套「display 收 -0.05em」**：汉字是满格设计，负字距直接笔画打架。

### 4.6 中文 display 大字

中文没有西文那种 Ultra Thin 到 Black 的 display 字体生态，大字的戏剧性要靠推理制造：

- **字重对比是主武器，前提是字体真有多档字重**（核实动作见 §4.1）——单字重就改用下面两条技法
- **笔画密度决定可用字号下限**：笔画细/反差大的字体只在大字号成立；小于 24px 细笔画开始断笔，正文必须回到黑体/中等笔画
- **反向也成立**：笔画重的字在超大字号下墨量过大，密度不均的标题考虑换低一档字重
- **字号本身是情绪杠杆**：`mood:` 词是默认字号下的判断，放大到 display 尺度气质会漂移——克制字形放大到占满视口可能从"安静"读成"喧嚣"，运动感强的字体缩小又会显得单薄。落 `clamp()` 最大值前回头确认气质没跑偏
- **竖排是中文独有的 display 武器**：`writing-mode: vertical-rl` 做书脊式标题、诗词、目录，西文做不到；竖排里的西文和数字用 `text-orientation: upright` 或 `text-combine-upright: all`

## 5. CSS 实现要点

```css
/* 1. 字体引入：只用库内字体，@font-face + BOS URL（search_fonts.py 直接给这段） */
@font-face {
  font-family: "MiSans";
  src: url("https://resource-static.bj.bcebos.com/fonts-skill/MiSans_Regular.ttf") format("truetype");
  font-weight: 400;
  font-display: swap;   /* 中文字体文件大，白屏等字体是最差体验，必须 swap */
}
@font-face {
  font-family: "MiSans";
  src: url("https://resource-static.bj.bcebos.com/fonts-skill/MiSans_SemiBold.ttf") format("truetype");
  font-weight: 600;     /* 多字重款：每个字重一条 @font-face，URL 用 csv 的 {weight} 模板拼 */
  font-display: swap;
}

:root {
  /* 2. fallback 链：西文 → 中文 → 系统中文 → 泛型（顺序即规则，见 4.2） */
  --font-body: "Inter", "MiSans", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-display: "Literata", "Source Han Serif CN", "Songti SC", serif;

  /* 3. 禁合成：不接受浏览器伪造的斜体/加粗（中文场景必开） */
  font-synthesis: none;

  /* 4. 中文断行底线 */
  line-break: strict;        /* 避头尾 */
  overflow-wrap: break-word; /* 长 URL/英文串不撑破容器 */
}

body {
  font-family: var(--font-body);
  font-size: 17px;           /* 中文正文基准，见第 1 章 */
  line-height: 1.8;          /* 中文行高基准，见第 2 章 */
  /* 正文开启标准连字，关闭花哨特性 */
  font-feature-settings: "liga" 1, "calt" 1;
}

/* 数据场景：等宽数字 + 斜杠零（0 和 O 不混淆） */
.data, table { font-variant-numeric: tabular-nums slashed-zero; }

/* 西文小标签：全大写 + 大字距的唯一合法场景 */
.label { text-transform: uppercase; letter-spacing: 0.1em; font-size: 12px; }

/* 标点挤压：中文 display 大字里全角标点的空洞收窄 */
.display-cjk { font-feature-settings: "halt" 1; }
```

**加载预算**（库内字体是全量文件，没有子集化分片，靠数量克制控制预算）：

- 中文字体单文件大（数 MB 级），**一页最多 2 个中文家族**；display 中文字体只给标题层用，正文层交给正文黑/宋
- **全页字体家族总数（含西文）不超过 3 个**——再多，加载翻倍且风格会散
- 西文字体小得多，Variable 款一个文件覆盖全字重区间（Weights 列写 Variable 的），优先选它们
- 多字重需求收敛到 2-3 档：正文款拉 Regular + 一档强调（Medium/SemiBold），display 款一般只有 Regular
- 每条 `@font-face` 必带 `font-display: swap`；fallback 链保证字体到达前页面照样可读
