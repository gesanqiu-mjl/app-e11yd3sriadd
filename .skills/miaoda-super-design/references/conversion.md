# 选中转换与生成后设计（P4 / P5）

> **何时读**：P4 = 用户选中稿后生成应用；P5 = 应用生成后追加/重设计页面。

---

## §P4 选中转应用

**唯一前置硬门**：用户在三稿展示之后的**新一轮消息**里明确选定了某稿（产品侧 selectDesign 事件，或口头点名稿号/标题）。

- 这个信号来自**用户主动发的下一条消息**，不是本 skill 去问出来的。
- **禁 `ask_user` 追问"选哪稿"**——三稿交付后正常 finish 即止；用户不点名就永久停在三稿，不进 P4。只交付设计稿不生成应用是合规终态。
- **禁自行代选**——用户跳过、沉默、说"你决定"都不构成选稿授权（问卷的跳过只授权 vibe 决策，不授权替用户选稿转应用）。

有该信号后执行以下步骤。

### 1. 先生成 DESIGN.md

```bash
python3 <skill_dir>/scripts/apply_design_tokens.py --emit-designmd-tokens --html tasks/design/<选中稿>.html
```

- 脚本输出**三段**（`tokens` / `custom_tokens` / `section_blueprint`）整体粘入 `/workspace/{app_id}/docs/DESIGN.md` 的 front matter。`fonts` 不在里面——它和 `name` / `source_draft` 一样由模型手写，脚本既不生成也不校验（见 §1.1）。
- prose 从设计决策提炼——讲 why、讲边界，不复读值。**每条 prose 都要在写 React时被消费**（写不出如何被消费的条目 = 删，不为写而写）。
- 格式严格按下面的 §1.1。
- **用户上传的品牌 design spec 是最高优先输入**：已是 §1.1 模板格式 → 校验后直接落盘采用；其他形式（含 `tasks/design/brand-spec.md`）→ 走 `asset-direction.md §0` 提取规范化，向用户确认后落盘。

### 1.1 DESIGN.md 格式规范

**生命周期**：

- **只在 P4 generate**：落盘 `/workspace/{app_id}/docs/DESIGN.md`。**HTML 设计阶段（P1/P2/P3）绝不生成、绝不维护——此阶段唯一事实源是 html 本身。**
- **生成之后，任何设计变更必须同轮维护**：改应用视觉、新 tab 页稿选中转换、某页重设计——同轮更新对应 token/prose。
- **多选生成时**：tokens 取首页 route 的选中稿；其余选中页在同一 token 体系下转换，冲突以首页为准并向用户说明。

**模板骨架**——front matter 分两段来源：**上半段模型手写，下半段脚本原样粘贴**。

```md
---
# ── 以下 3 项模型手写 ──
name: <stamp title>              # 与 manifest title 一致
source_draft: 4                   # 生成来源的设计稿 id，可追溯
fonts:                            # 取自选中稿 FONT-FACE 块的 @font-face，来源 search_fonts.py
  heading: "Noto Serif SC"
  body: "Inter"

# ── 以下整块 = apply_design_tokens.py --emit-designmd-tokens 的 stdout，原样粘贴，禁手抄 ──
tokens:
  radius: "0.5rem"
  background: "0 0% 100%"
  primary: "221 83% 45%"
  primary-foreground: "0 0% 100%"
  # ……核心集（≈18 个）排在前，其后是该稿另外声明的 baseline token（如 success / sidebar）；
  # 未出现的 = 规则推导或铺底默认，不复读；稿件含 .dark {} 分支时脚本会追加 dark-<name> 前缀键
custom_tokens:                    # 该设计注册的自定义 token；无则脚本不输出此段
  brand-gold: "43 96% 56%"
section_blueprint:                # key = 区块根元素 id，value = 该元素必需 class（契约见 §3.5）
  hero: "bg-background text-foreground"
  menu: "bg-foreground text-primary-foreground border-b-2 border-foreground"
---

## Overview        # 气质定位 + signature element（1 段，说 why）
## Colors          # 60-30-10 分布用法、主色使用边界、暗色策略
## Typography      # 字体（库内款 + @font-face BOS URL）、字阶（5 级内）、字重、行高约定
## Layout          # 栅格/间距节奏、断点（只有 md）、导航模式
## Components      # ≤8 个关键组件的 token 用法（button-primary / card / input…含 hover 态）
## Do's and Don'ts # 本设计系统的禁忌（如禁渐变文字、每 section 一处 bg-primary）
```

章节**可省略不可乱序**。脚本输出的三段是连续 stdout，整块贴在 front matter 末尾，不要把手写字段插进中间。

**值格式（脚本说什么就是什么）**：颜色归一化成 **HSL 裸三元组**（`221 83% 53%`），带透明度时是 `H S% L% / A`（如 `221 83% 53% / 0.06`）。**非颜色值保持原样**：长度（`0.5rem`、`0`、`calc(0.5rem - 2px)`）、渐变、字体栈、缓动曲线（`cubic-bezier(.23, 1, .32, 1)`）、`url("data:…")`。

**"看起来不是三元组"不等于脚本出错**——设计稿里本来就有非颜色 token。禁止为了让它"像三元组"去手改、删条目或重写引号：手改会立刻违反"禁手抄"，且与 index.css 逐变量比对时必然报不一致。真正的非法只有一种：括号/引号不闭合，那时 `check_design_md.py` 会明确报 malformed。

**手写三项的口径**：`name` 与 manifest title 一致；`source_draft` 记来源稿 id；`fonts.heading` / `fonts.body` 从选中稿 FONT-FACE 块的 `@font-face` 抽 family 名，字体必须来自 `data/fonts.csv`（由 `search_fonts.py` 检索）。这三项脚本不生成也不校验，漏了不会报错。

**与编码期规则的衔接**：编码期 system prompt 规定「DESIGN.md is the single source of truth」并强制语义 token 类——本模板的 front matter 就是那个 truth 的机器可读层：改设计 = 改 front matter token（经脚本）+ 改 prose 边界，代码只消费 `bg-primary` 等语义类，永不感知具体 HSL 值。

### 2. token 注入必须跑脚本

```bash
python3 <skill_dir>/scripts/apply_design_tokens.py --html tasks/design/<选中稿>.html \
  --index-css src/index.css --tailwind-config tailwind.config.js
```

- 按铺底 schema 全量重建 token 区块 + 自定义 token 注入 + tailwind.config 扩展。
- **禁止手抄 token 进 index.css**。
- 脚本硬失败 → 停止转换、向用户说明，回 P3 补可用稿；绝不手抄兜底。

### 3. sig-CSS、字体与动效迁移

- `SIGNATURE-CSS` 块内的 `sig-` 类由模型拷到应用代码（属创作产物）。
- `@font-face` 的 BOS URL 一并拷贝（可用字体见 `data/fonts.csv`）。
- **CSS 动效**：选中稿 `KEYFRAMES` / `ANIMATIONS` 块的内容拷进 `tailwind.config.js` 的 `theme.extend.keyframes` / `theme.extend.animation`（同名同结构，直接搬）。
  - `intersect:` 变体与 `intersect-once` 在应用侧原生可用（`tailwindcss-intersect` 已在依赖内、`<IntersectObserver/>` 已在 `App.tsx` 挂载），JSX 里类名 1:1 照抄即可。
- **motion 动效**：`MOTION-SCRIPT` 块（预览时用 `inView`/`scroll`/`stagger` 的命令式调用）**不迁移**，改用 `motion/react` 声明式**重写**——`motion@12.23.25` 已在依赖内。这一步靠理解语义重写、不是逐行搬：
  - `animate(el, {opacity:[0,1], y:[40,0]}, {duration})` → `<motion.div initial={{opacity:0,y:40}} whileInView={{opacity:1,y:0}} viewport={{once:true, margin}} transition={{duration}}>`
  - `inView(el, cb, {margin})` 的 margin → `viewport={{margin}}`；`stagger` → 父 `transition={{staggerChildren}}` + 子 `variants`
  - scroll 联动进度 → `useScroll()` + `useTransform()`
- body 末尾三段 `data-preview-only` 脚本（intersect observer / motion import / MOTION-SCRIPT）**都是预览专用，全部不迁移**。
- 自行引入的其他 CDN 动效库（Swiper / lottie 等）要迁成 npm 依赖。

### 3.5 section 组件根元素契约（写代码时读 DESIGN.md）

DESIGN.md front matter 的 `section_blueprint` 是每个 section 根元素的 class契约（由脚本从选中 html 提取，禁手抄）。写每个 section 组件时：

- 根元素**必须**是 `<section>`，并保留 `id="X"`（与 blueprint 的 key 对应）——它既是 nav `href="#X"` 的锚点目标，也是脚本识别 section 的依据。丢了 → 单页 nav 全失效跳页顶。
  - **blueprint 的 key 不一定来自稿件里的 `<section>`**：提取脚本收录稿件中任何带 `id` 的区块根元素（`<header>` / `<div>` 也算），但 `check_design_md.py --src` 只认 React 侧的 `<section id="X">`。所以稿件里是 `<header id="nav">` 的区块，转 React 时同样写成 `<section id="nav">`，否则校验会报"找不到"。
- 根元素 `className` **必须包含** `section_blueprint[X]` 列出的全部 class；可以叠加更多（响应式变体/hover 态），但不能缺。
- 这是编码时的**输入约束**，不是转换完了再挑错——写 `HeroSection.tsx` 前先读 blueprint.hero，直接写到根 `<section>` 上，杜绝"看 HTML 手抄漏 class"。

**首页视觉组件写完先跑一次 §6 check_design_md.py，别等全部业务页面写完才第一次跑**——此时改动范围小，报错好定位；业务页面写完后再跑一次完整校验收尾。

### 4. 资产迁移

| 场景 | 处理 |
|---|---|
| 远程 https URL | 原样沿用，不下载 |
| 本地 `tasks/design/assets/` 图片 | 全拷到 `public/images/design/`（同名） |
| React 代码引用路径 | `/images/design/<name>` |
| 路径 rewrite | html 里的 `/workspace/<app-id>/tasks/design/assets/x.jpg` → React 里的 `/images/design/x.jpg` |
| DESIGN.md 资产表 | 登记 `/images/design/<name>` 与远程 URL |

- **`tasks/design/` 不打包，React 代码禁引用其下任何文件。**

### 5. 双基准

- **视觉基准 = 选中 HTML**：像素级还原；禁加原型没有的视觉元素。
- **功能基准 = PRD**：验收点一个不少。
  - 稿没画的功能在 DESIGN.md token 体系内延展设计，不得砍功能。

### 6. 转换后自查

```bash
python3 <skill_dir>/scripts/check_design_md.py docs/DESIGN.md \
  --index-css src/index.css --src src/
```

- 逐 `id` 对照设计稿源码，核对结构 / token / 文案。
- 脚本本身校验：front matter 与 `index.css` 逐变量一致、值格式合法、章节顺序、**AA 对比度**（`foreground/background` 与 `primary-foreground/primary` 均须 ≥4.5:1，报错会点名该改哪个 `*-foreground`，锁定的品牌色不用动）。
- `--src` 校验 `section_blueprint`：每个 section 组件根元素的 className 是否覆盖 blueprint 列出的全部 class。报 warn = section 顶层视觉类丢失（背景/文字/边框），**视为必须修**（除非有意重设计且已同步更新 DESIGN.md）。

---

## §P5 生成后设计（应用已生成）

### 1. 必须先读现有体系

- 读 `docs/DESIGN.md` + `src/index.css`，新稿 token 与组件风格从中派生。
- **一致性硬约束**：不引入 DESIGN.md 之外的新主色/新字体。
  - 除非用户明确要求换风格（属重设计，转换时须同步更新 DESIGN.md）。

### 2. route 由文件名承载

- 命名 `tasks/design/{route-name}-{n}.html`（如 `/profile` 页 → `profile-1.html`），不另行申报。

### 3. 素材优先复用

- 优先复用应用内已有素材（`public/images/design/`）+ 已选中稿素材。
- 应用内图片在新稿中复用时：同名拷到 `tasks/design/assets/`，html 里以完整绝对路径 `/workspace/<app-id>/tasks/design/assets/<name>` 引用。
- 转换时按同名幂等迁回，不产生重复文件。

### 4. 同 P3 纪律

- 每稿新建文件（不覆盖旧稿）；stamp 写 title + skeleton + sig；交付前跑自检脚本。
- **每轮仅交付 1 稿**，交付后结束本轮并询问是否继续。

### 5. 设计变更必须同轮维护 DESIGN.md

- 无论改动来自设计侧还是应用侧，同一轮对话内更新对应 tokens / prose。

### 6. 交付形式

- 设计方案一律以 `tasks/design/{route-name}-{n}.html` 新稿交付。
- **禁止直接改应用代码来"呈现方案"**（如把多方案塞进同一 React 页面切换）。
- 改应用代码只发生在：P4 选中转换，或用户明确要求修 bug / 改功能时。
