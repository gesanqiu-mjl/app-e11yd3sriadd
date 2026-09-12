# 素材方向层（主文件）

> **强制路由**：§2 决定后续只读**一个** `asset-*.md` 分文件——同时载入多个会让不同风格的视觉语法互相污染。

---

## §0 品牌资产触发与优先级

**触发条件**：为具体品牌/客户做物料，或设计里点名/并列真实产品（对比 deck、多家 logo 并排最易漏判）。

**识别度金字塔**：Logo（任何品牌必需）＞ 产品图/官方渲染图（实体产品必需）＞ UI 截图（数字产品必需）＞ 色值 ＞ 字体清单（仅识别用，落地走 `search_fonts.py`）。

**红线**：只抽色值/字体不找 logo/产品图/UI = 违反；用 CSS 剪影/SVG 手画替代真实产品图 = 违反；资产缺失既不告知用户也不兜底、硬做 = 违反。logo 出现品牌名即必需，不适用素材质量门槛，6 分 logo 强过没有。

**采集**：按清单一次问全用户手上有哪些资料；没有的走 `image_search` 检索官方渠道。资产落 `tasks/design/brand-spec.md`，后续从这里取品牌事实。HTML 只 `<img>` 引用真实资产路径；CSS 变量从 spec 注入 `:root { --brand-* }`。

**兜底**：logo 找不到 → 停下问用户；产品图缺 → 生图兜底（§8）→ 索取用户 → 诚实 placeholder；UI 截图缺 → 索取账号截屏 → 演示视频截帧；色值缺 → 设计方向顾问模式给 3 个方向标 assumption。

**多切面**：官网营销色与产品 UI 色可能不同，两套都真，按交付场景选；产品截图里的第三方 demo 色不是本品牌色。

---

## §1 Asset Plan（先规划，再取材）

逐 section 判定，**写成计划再动手**：

| 判定 | 怎么定 |
|---|---|
| 这个 section 需要图吗？ | 问"去掉图，这个 section 还能完成它的工作吗？"—— 能，就不要图 |
| 需要 → 承担什么职责？ | `hook`（首屏抓住）/ `proof`（证明力：产品图/UI 截图/数据可视）/ `educate`（解释机制）/ `atmosphere`（气质定调）/ `convert`（转化前的信任锚） |
| 不需要 → 明确标注 | 写 `typographic only` 或 `geometric only`——省成本、防 filler、也是一种设计决策 |

**输出格式**（写在回复正文或稿内注释，不落单独文件）：
```
hero      → editorial-photo / hook / 16:9 / 全幅背景压文字
features  → typographic only（3 个 feature 用字阶 + 发丝线分组，不配图）
proof     → ui-crop / proof / 4:3 / 真实界面截图
story     → abstract-geometry / educate / 16:9 / 一个 convergence 事件
cta       → geometric only（色块 + 大字，不配图）
```

**不是每个 section 都要图**。"一 section 一张图必须生成"这类硬规则不采纳——成本不合适，且会产生大量 filler 图。规划后按需取材才对。

---

## §2 Asset Type 路由表（决定读哪个分文件）

| asset_type | 适用 | 读哪个 reference |
|---|---|---|
| `editorial-photo` | 真实摄影、人物、场景、氛围 | 本文 §3–§6 |
| `product-shot` | 实体产品、包装、硬件 | 本文 §3–§6（涉及具体品牌先读 §0） |
| `ui-crop` | 界面截图、Dashboard 片段、产品演示 | 本文 §3–§6 |
| `texture-material` | 纸/布/金属/陶瓷等材质表面 | 本文 §3–§6 |
| `editorial-poster` | 极简 zine、出版物气质、大留白海报 | **`asset-editorial-poster.md`** |
| `abstract-geometry` | AI/SaaS/infra/fintech 抽象概念图 | **`asset-abstract-geometry.md`** |

**互斥规则**：一次只 open 一个 `asset-*.md`。一稿的三个 section 若命中三种类型，就分三次读（读完一个用完再读下一个）——不要一次全部载入。

---

## §3 Composition Anchor（构图锚点，逐 section 变化）

**`text-left / image-right` 是 AI 最泛滥的默认构图**。它合法，但**不能作为第一反应**。动笔前问自己："我是不是出于习惯在画默认布局？"

12 个变体，每 section 选一个：

| anchor | 描述 |
|---|---|
| `centered-statement` | 居中陈述，上下留白撑场 |
| `top-left-lead` | 左上引领 + 右下支撑 |
| `bottom-left-over-image` | 文字压在背景图左下 |
| `bottom-right-cta-cluster` | 右下 CTA 群组 |
| `left-third-caption` | 左 1/3 说明 + 右 2/3 视觉（经典款，**慎用、绝不连续两次**） |
| `right-third-caption` | 右 1/3 说明 + 左 2/3 视觉（反转经典） |
| `centered-low` | 文字在 hero 图下方 40% 区域 |
| `off-grid-editorial` | 反网格错位拉扯 |
| `stacked-center` | label/headline/sub/CTA 全居中，极简 |
| `image-as-canvas` | 图占满，文字浮在干净安全区 |
| `split-diptych` | 两个平色场相接（modernist） |
| `mini-minimalist` | 小 logo + 短陈述 + 细 CTA，几乎全是负空间 |

**跨 section 约束**：同一 anchor **不得连续出现超过 2 个 section**；整页至少出现 3 种不同 anchor。

---

## §4 Background Mode（背景模式，逐 section 变化）

背景是**主要设计工具**，不是风险。别默认退回纯白。

| mode | 用法 |
|---|---|
| `solid + inline asset` | 纯色底 + 内嵌素材（最安全） |
| `texture-field` | 纸/材质/网格作背景 |
| `full-bleed + overlay` | 满幅图 + 色调遮罩（文字必须仍高可读） |
| `editorial-side` | 50/50、60/40、40/60 侧图（可反转） |
| `flat-block + crop` | 平色块 + 小产品/细节裁切作点缀 |
| `tonal-gradient` | 低 chroma 同色系渐变（palette-matched，专业） |
| `duotone` | 双色调图片处理（palette-locked） |
| `radial-vignette + crop` | 柔和径向暗角 + 产品裁切（奢侈/editorial 感） |

**跨 section 约束**：同一 mode **不得连续超过 3 个 section**。非极简 brief 的多 section 页面至少出现一次 full-bleed / duotone / atmospheric 背景。极简 brief 豁免——克制本身就是设计。

---

## §5 Hero Scale（每稿选一档，不折中）

| scale | 特征 |
|---|---|
| `giant-statement` | 巨号字 + 大图，主宰首屏 |
| `mid-editorial` | 字与图平衡，电影感但不撑满屏 |
| `mini-minimalist` | 小 logo + 短陈述 + 细 CTA，几乎无图，大量负空间 |

`mini` ≠ 弱，是**有底气的克制**。三稿之间可用不同 scale 拉开差异。

---

## §6 Cross-Section Consistency（一稿内必须像一个网站）

变化的是构图与背景，**不变的是品牌世界**：

**必须一致**：调色板与 accent 逻辑 / 字体家族与字阶 / CTA 家族（样式变体可以，身份不能变）/ 圆角语言 / 图片处理（同一 grade / 材质词汇 / 取景方式）/ 文案语气

**允许变化**：构图 anchor（逐 section）/ 背景 mode（逐 section）/ section 尺寸与密度

**素材复用铁则**：三稿共享同一批素材 URL——差异化靠布局/气质/signature，不靠各配一套图。迭代新稿默认沿用源稿全部素材链接。唯一豁免：某稿主视觉方向与共享素材完全不同（气质差异靠图才成立），或用户明确要求换图。

---

## §7 Prompt Schema（结构化，不自由发挥）

生图/搜图前先填这个 schema，再压成 query：

```yaml
use_case:      landing-hero | product-showcase | proof-section | atmosphere | concept-diagram
asset_type:    （§2 表里的一个）
scene:         backdrop 一句话
subject:       main 一句话（一图一主体，见分文件）
style_medium:  editorial photography | studio product | abstract geometry | texture scan | ui screenshot
composition:   framing（wide/medium/close） / subject_position / negative_space 位置
visual_energy: static | dynamic | dramatic（见下）
lighting:      type（soft natural / directional / flat scan） / mood
palette:       background / accent（与稿件 token 一致）
materials:     具体材质词（glass / brushed aluminum / uncoated paper …）
constraints:   no text / no logo / no watermark（图+字一体例外见下）
avoid:         generic SaaS illustration / floating UI cards / excessive gradients / cyberpunk（按 anti-slop.md 补）
```

**visual_energy（hero 不止能当静态铺底）**：视效烧进图里，比前端 CSS 叠效果真、便宜。
- `static`：干净背景，叠字底图 / `dynamic`：运动感、光影、景深 / `dramatic`：粒子、能量流、体积光等夸张视效（PRD 要"震撼/科技感"时）
- 三稿 energy 可拉梯度，本身是一支差异

**图+字一体 KV（可选，仅生图）**：强标题烧进图 = 库外字体的海报感。默认走叠字，仅当单一强主体词 + 文案 ≤6 中文字/≤5 英文词 + 无易变信息（日期/价格）时才用。
- 含中文/品牌名必复检字形（易出错字），错则重生；stamp 标 `hero-text-in-image: <文案>`
- 会变信息 / 需 SEO / 多语言 / 暗色反色 → 一律叠字

**语言规则（关键，语言不对效果一定差）**：

| 目标 | query/prompt 语言 | 依据 |
|---|---|---|
| **image_search 工具** | **跟随用户/PRD 语言（通常中文）** | 图库描述按语料语言索引；跨语言只能靠向量近似，命中率低，容易掉进"搜不到 → 触发生图兜底"的高成本链 |
| **可灵生图** | **倾向中文** | 可灵是国产模型、其 SKILL.md 示例 prompt 全中文。注意：`kling-omni-image-generation` 的 API 文档**未声明语言约束**（`prompt` 字段只限 2500 字符），所以这是经验判断而非硬规则 |
| 本文与 3 个 `asset-*.md` 分文件 | 英文（原味保留） | 蒸馏自英文 skill；**其英文构图方案喂给可灵前先转中文** |
| `search_fonts.py` / `recommend_colors.py` / `search_inspiration.py` | 英文 | 语料列全英文，中文命中率≈0 |
| `search_inspiration.py --theme-query` | 中文 | 模板库只索引中文主题名 |

**query 写具体名词堆叠，不写抽象效果词**：主体 + 场景 + 视角/光线 + 摄影类型。"高级感 科技感 未来感"这类词搜索引擎无从匹配实体，等于空 query。

---

## §8 取材路由（优先级从高到低，单一归属）

| 优先级 | 条件 | 动作 |
|---|---|---|
| 0 | **首轮 hero 主视觉** | 默认 `skill_action(skill="kling-omni-image-generation")` 生成，不需要用户 @ 标签或说"生成一张图"。张数按 §1 Asset Plan 定，不与稿数绑定 |
| 1 | 用户消息含 `<SKILL>某生图skill</SKILL>` 标签 | 用标签指定的 skill（覆盖优先级 0） |
| 2 | 用户明确要求"生成/画一张/做一张"（非 hero） | `skill_action(skill="kling-omni-image-generation")`，按其 `references/omni-image-api.md` 执行 |
| 3 | 其余素材（非 hero，用户未主动要求生成） | **image search 工具**默认检索 |
| 4 | 2/3 都不可用 | 诚实 placeholder（灰块 + 文字标签），明告"图待补" |

**兜底优先 CSS-only 工艺而非灰块**：优先级 4 触发前，先判断该 section 的主视觉能否用 `design-language.md §5.2` 的 CSS-only 装饰物件承担。能——按"签名级"标准（可辨识前后层、材质差异、主光方向、非均匀细节）做透，它就是合格装饰物件；做不到那个标准才退回诚实 placeholder。灰块只是最后兜底，不是首选。**注意**：首轮 hero 仍必须走优先级 0 生图，CSS 工艺不能替代 hero 主视觉——仅在 hero 生图失败后启用。

**重复卡片/网格容器优先 CSS 几何叠层**：一组卡片（书单/产品/案例…）需要逐卡视觉区分但没有逐卡生图预算时，默认走 `design-language.md §5.2` 的渐变叠层逐卡换配色/角度/形状——多张 image search 结果风格不统一，生图又要走异步预算，CSS 叠层零延迟且与色板同源。**前提是那个位置上的图是装饰不是内容**：PRD 点名了预览图/封面/实拍，或卡片语义本身就是"这东西长什么样"（商品、书封、案例截图、人像），那图就是内容，按优先级 3 走 image search，不能用色块叠层顶替——PRD 点名的素材同属锁定信号。

**非 hero 素材**：用户没 @ 生图 skill、也没说"帮我生成图" = 不生图，走image search。Hero 主视觉例外——见优先级 0，默认生成。

**hero 图前置**：hero `<img>` 在生图返回 succeed 前不落地；同 turn 可与 stamp / 非 hero section / 其他脚本并发。

**判定依据唯一**：用户消息里的 `<SKILL>name</SKILL>` 标签。用户只在文字里口头提到某工具名（无标签）不算指定。

**Hero 生图 prompt 写作路由**：优先级 0/1/2 落到 hero 生图前，先按 §2 asset_type 判断本稿 hero 方向——命中 `editorial-poster` / `abstract-geometry` 时，读对应 `asset-*.md` 再拼 prompt（不读会写出该风格的通用套路）；其余类型照 §7 Prompt Schema 直接拼。

**图片引用双轨制**（保证 html 稿与 React 应用都能正确用到）：
- **远程素材**（image_search 图库 / BOS URL / logo 聚合源）→ 直接 `<img src="https://…">` 热链，html 与应用同 URL
- **本地素材**（生图/下载产物）→ 统一落 `tasks/design/assets/`，文件名语义化（`hero-<主体>.jpg`），html 里写**完整绝对路径**：`<img src="/workspace/<app-id>/tasks/design/assets/hero-<主体>.jpg">`。生图脚本的 `--output-dir` 传 `tasks/design/assets`（本地文件不受生图服务 URL 过期影响）
  - **必须带 `/workspace/<app-id>` 前缀**——预览容器按完整绝对路径解析本地文件；`assets/x.jpg`（相对）和 `/tasks/design/assets/x.jpg`（站点根）都缺 app 定位信息，会图裂。app-id 从当前工作路径可得。
- **只有以上两种形式合法**：禁 base64 大图、禁引用 `assets/` 之外的本地文件
- **打包边界**：`tasks/`、`design/` **不参与应用打包**。P4 转换时选中稿的 `assets/` 图片会整批迁到应用的公开目录并 rewrite 路径——**出稿阶段无需关心迁移细节，只要守住上面两种引用形式，P4 就能无损迁移**。

**多张生图约束**：一次需要多张 → 必须走既有线上问询链路，不绕过、不静默批量生图；单张按优先级 2 直接生成。**优先级 0 的首轮 hero 是例外**——按 Asset Plan 定的张数（最多 3）直接生成，不受此约束拦截。

### 生图尺寸硬约束

生图必须显式传小档位分辨率（长边 ≤1600px 即够——画布 1440×900 / 375×812，更大只增体积不增清晰度）。

| 生图 skill | 必传参数 |
|---|---|
| `kling-omni-image-generation` | `--resolution 1k`（其 SKILL.md 示例写 2k，必须显式覆盖，禁 2k/4k） |
| `minimax-text-to-image` / `minimax-image-to-image` | `--width 1024 --height 1024`（按比例取等效小档，禁 ≥1536） |
| `image-generation-super` | 不传 `--size`，用默认 `1024x1024` |
| `image-generation-advanced` / `miaoda-imagegen-basic` | 无尺寸参数，不可控 |

---

## §9 QA（每张素材，失败 regenerate once）

**质量门槛 5-10-2-8**：搜 5 轮（多渠道交叉，非第一页直接用）→ 凑 10 个候选 → 精选 2 个 → 每个 ≥8/10。7 分素材是扣分项，不如留空或走生图兜底。

**8/10 五维**：分辨率（≥2000px，印刷/大屏 ≥3000）/ 版权清晰度（官方 > 公共领域 > 免费素材；疑似盗图 0 分）/ 品牌气质契合 / 光线构图风格一致（两张放一起不打架）/ 独立叙事力（能单独承担叙事角色，非装饰）。

| 检查 | 判据 |
|---|---|
| thumbnail 可读 | 缩到卡片尺寸，主体是否仍能辨认？辨认不出 = 主体太小或对比不足 |
| 与版面契合 | 放进设计稿实际位置，是否与文字/留白咬合？是否需要 overlay 才能读字？ |
| 风格一致 | 与同稿其他素材是否同一 grade / 同一材质词汇 / 同一取景逻辑？ |
| 无伪文字 | 图内有没有 AI 生成的乱码字符 / 假 logo / 水印？有就重生 |
| 无 slop | 对照 `anti-slop.md §硬约束` 第 4/6/7 条（紫蓝渐变 / GitHub-dark / SVG 手画） |
| 品牌资产真实性 | logo 是矢量/透明底真 logo（`file` + `head -c 90` 核对）、深浅两版齐；UI 截图无用户数据、是最新版；色值不是截图里的第三方色 |

失败 → 只修最大的那一个缺陷，收紧对应 prompt 字段，**regenerate 一次**。再失败 → 降级 placeholder 并如实告知，不无限重试。

---

## §10 动效强度基线（加不加、加多大）

> 落地机制（两条通道 / focal moment 名额 / 同屏循环上限 / 整屏 section 时机陷阱）全部在 `SKILL.md §动效落地`；本节只决定**强度**。

- **动效库按需引**（Swiper / anime.js / lottie 等），从 CDN 引入并锁固定版本；但**先问值不值**——纯 CSS（`@keyframes` / `scroll-snap` / `<video autoplay muted loop playsinline>`）能做的场景不引库。
- **动效强度由 `scenarios.csv` 的 `Motion_Baseline`(1–10) + `Animation_Constraint` 决定**，跑 `search_inspiration.py --domain scenario` 拿基线
- PRD 未明确场景时按 `Official Website`(motion=4) 走——**不花哨是正确的**，花哨需要场景许可
- **滚动入场不是每个场景都要**——按 `scenarios.csv` 的 `Motion_Baseline` + `Animation_Constraint` 判定：
  - `Animation_Constraint` 明确禁页面级入场/装饰动效 → **不加入场动效**，让内容加载即渲染
  - `Motion_Baseline ≤ 2` → 默认不加，除非 PRD 有明确的情感/氛围诉求
  - `Motion_Baseline ≥ 4` → 加入场动效
  - 边界情况（3）→ 按内容属性判：叙事型加、工具型不加
- **入场动效每稿自己定义**：`base.html` 的 `KEYFRAMES` / `ANIMATIONS` / `MOTION-SCRIPT` 三块都是空的，不预置任何默认入场——按本稿骨架的空间语言自选形式（侧向切入 / 蒙版揭示 / 模糊显影 / 尺度收放 / 多元素编排等）。**不预设"哪个骨架配哪个动效"的对应表**。三稿动效形式全同 = 放弃了一个差异化维度。
- P4 转 React 时引入的 CDN 库要同步迁移到 npm 依赖，成本记在心里
