# Anti-Slop

> **勿改格式**：`## 硬约束` 内的编号加粗行被 `search_inspiration.py` 解析注入检索输出。

---

## 硬约束

以下 8 条是**任何设计稿都必须过**的硬门；`check_design_quality.py` 用确定性规则覆盖第 2 条、第 4 条（只认 Tailwind class 形态，手写 CSS 渐变逃逸）与第 7 条的图片替代路径，其余靠模型自查。

1. **禁大面积纯色铺底做核心视觉**——Primary/Accent 仅小面积焦点（按钮/图标/激活态/边框），大面积（Hero/Banner/上传/操作/输入区）一律中性底、纹理、图像或分层
2. **禁 emoji 作图标**——例外仅两类：品牌本身使用 emoji（Notion/Slack 等），或受众为儿童/轻松社交场景；命中例外时写 `<!-- miaoda-design-disable no-emoji-icons: <理由> -->` 豁免。检查器只扫 `<body>` 里的 emoji 码位段（U+1F300–U+1FAFF 与 U+2600–U+27BF）：`★ ☆ ✓ ➜` 这些落在后一段里会被拦，`▶ ◀ ● ■ ◆`（U+25xx 几何符号）不在范围内，不用替换
3. **禁圆角卡片 + 左粗彩色 border accent**——2020-2024 烂大街组合；改用背景色对比、字重字号对比、发丝分隔线，或干脆不分卡片
4. **禁紫→粉→蓝激进渐变**——AI 生成网页的默认味道；紫蓝渐变组合是 AI slop 万能公式
5. **禁 Inter / Roboto / Arial / system font 作 display**——它们是 UI 小字工具，大字号下匀质无表情；display 字体必须有性格（衬线大字 / 压字重 display / editorial 感）。「作 display」只指标题与 hero 巨字：等宽数字读数、表格数字属数据层，不受本条限制，但同样必须是库内字体并注册 `@font-face`（`font-registration` 拦这条）
6. **禁 GitHub-dark 偷懒解**——均匀深蓝底（#0D1117）+ 通用青/紫霓虹 glow 只禁这一种烂大街组合，**有作者意图的暗色（电影级光影、暖色赛博、暗场叙事）不在禁区**
7. **禁 SVG 手画 imagery（人脸/场景/产品/抽象艺术）**——一眼 AI 味、幼稚廉价；用真图（image_search / 可灵）或**诚实 placeholder**（灰块+文字标签），一个诚实 placeholder > 一个拙劣 SVG 十倍。**涉及真实品牌时同条加严**：不得用 CSS 剪影/SVG 手画替代真实产品图或 logo
8. **禁原生下拉与系统弹窗**——`<select>` 的展开菜单、`alert()`/`confirm()`/`prompt()` 由 OS 绘制，CSS 管不到，一点开就跌回系统默认样式。下拉改 button + 绝对定位选项层（`appearance-none` 只能改收起态，不够）；提示改自绘 toast/modal。其余原生控件（text/tel/textarea/checkbox 等）正常用，只需按本稿视觉风格定制外观

---

## 分类黑名单（附"何时可用"）

### 视觉

| slop | 为什么烂 | 何时可用 |
|---|---|---|
| Mesh gradient 铺满背景 | AI 语料"科技感"万能公式 | 品牌本身用 mesh 视觉 |
| 每个标题配 icon | iconography slop，界面像 toy | 品牌本身是 icon-led，或功能真需要视觉区分 |
| 假 stats 装饰卡片（10,000+ / 99.9%） | 你都不知道有没有 = data slop | 有真实数据 |
| 编造用户 quote / 名人名言 | quote slop | 有真 quote |
| 三个等宽卡片一排（feature grid） | 用烂的 "hero + 3 feature + testimonial + CTA" 模板 | 内容形态真的对称 |
| 每个 card 长一样 | 缺设计感 | — 用不对称 card：不同大小/带图/跨列，才像真设计师做的 |

### 字体

| slop | 为什么烂 | 替代 |
|---|---|---|
| Inter / Roboto 当 display | UI 小字工具，大字号匀质 | Anton、Montserrat 大字重、Red Hat Display |
| Space Grotesk | "科技感"偷懒答案，加密/AI 落地页泛滥 | Sora、Syne、Unbounded |
| Playfair Display | "优雅"偷懒答案，婚礼请柬既视感 | Cormorant Garamond、Gilda Display、Fraunces |
| Fraunces 当 display | 2023-2025 AI 设计工具默认"有品位" | Literata、Libre Baskerville、Crimson Pro |
| 中文交给 `sans-serif` 系统默认 | Win/Mac 跨设备两张脸 | 用可用字体库的中文款（阿里巴巴普惠体 / MiSans / 江城黑体等） |
| 引 Google Fonts / 库外字体 CDN | 违反字体铁则、不在可用字体库内 | 只用 `data/fonts.csv` 库，跑 `search_fonts.py` |

### 色彩

| slop | 为什么烂 | 替代 |
|---|---|---|
| 凭空发明色板 | 通常不和谐 | 从品牌资产吸色 / 参考产品截图吸色 / 走 `recommend_colors.py` 采样 |
| 凭记忆猜品牌色 | 训练语料不是品牌真相 | 必须从实际资产验证；截图里的第三方色不是本品牌色 |
| dark mode 就是反色 | 需要重调饱和度、对比度、accent | 不想做就不做，别硬上 |
| 5 种以上有彩色 | 视觉混乱，品牌感弱 | 1 主 + 1 辅 + 1 强调 + 灰阶；有彩 token 收敛到 ≤5 个（目标 2–3，见 `design-language.md` §3.1） |

### 布局

| slop | 为什么烂 | 替代 |
|---|---|---|
| Bento grid 过度泛滥 | 每个 AI landing 都想 bento | 除非信息结构真适合，用其他 layout |
| 大 hero + 3-column features + testimonials + CTA | 落地页模板被用烂 | 想创新就真创新，见 `design-language.md` 12 骨架族 |

### 内容

| slop | 为什么烂 | 替代 |
|---|---|---|
| lorem ipsum | 出现即扣分（`no-lorem` 规则 error 级硬拦） | 从 PRD 抽真文案或诚实 placeholder |
| 通用营销词汇（unleash / elevate / revolutionize / next-gen / seamless / powerful solution） | AI 味浓 | 短、具体、有信息量的动词 |
| 假品牌名（Acme / Nexus / Flowbit / NovaCore） | 明显 AI 名 | 用真产品名或诚实占位 |

### 动效

| slop | 为什么烂 | 替代 |
|---|---|---|
| `hover:scale-105` + `hover:-translate-y-2` + `hover:brightness-*` 三件套 | 模型的默认 hover，不是设计 | 一稿一个 authored focal moment 就够 |
| 每 section 一个 fade-in | 没有 authored focal moment | 只让 hero 或一个关键 section 有编排式入场 |
| Dashboard 全屏入场动画 | 场景错配 | 数据刷新反馈 + 状态过渡；参考 `scenarios.csv` Motion_Baseline |

---

## 判断边界（防误杀）

**这些不是 slop，别一律禁**：
- **克制的渐变**：低 chroma 单色系（ink→graphite / cream→sand）、hero 摄影上的单色 grade、editorial 色洗——只禁彩虹/紫蓝/pink→orange 泛滥公式
- **场景要求的高密度**：Dashboard/Tracker/AI 工具本就该密——加的是**有内容的密度**（每屏 ≥3 处产品差异化信息），不是装饰密度

**判定原则：判"是不是最大公约数"而不是判"看起来不看起来干净"。** AI slop = 训练语料里的视觉最大公约数；反 slop 是替用户保护品牌识别度，不是审美洁癖。

**核心信号**：当你觉得"加一下会更好看" —— **那通常是 AI slop 的征兆**。先做最简版本，用户要求时再加。
