# 抽象几何素材 / One-Event Composition

> **何时读**：`asset-direction.md §2` 命中抽象几何 / AI / SaaS / dev tool / fintech / infra 类抽象素材。

---

## 1. One-Event 原则（核心约束）

**一张图只表达一个空间关系。** 选一个 transformation verb：

`orbit` / `convergence` / `divergence` / `compression` / `deflection` / `propagation` / `oscillation` / `filtering` / `enclosure` / `release`

Prefer abstract relations over illustrated nouns. Write one internal sentence describing what moves/changes/relates to what — if the sentence needs "and" to list unrelated objects, the concept isn't distilled yet.

**Reject the AI default**: "AI + robot + network + hologram + particles + dashboard" — this is not one event, it's five unrelated objects glued together.

## 2. Grammar Family（选一个主，最多加一个辅）

| Family | Best for | Primary marks |
|---|---|---|
| Orbital field | cycles, gravity, recurrence, scale, mutual influence | circles, arcs, radial ticks, loops, spherical meshes |
| Flow transformation | emergence, routing, filtering, pressure, change | streamlines, particles, arrows, gates, obstacles |
| Signal strip | rhythm, cadence, phases, comparison, accumulation | waveforms, lanes, bars, repeated measures, faint grids |
| Topology map | relationships, context, systems, dependencies | nodes, edges, frames, sparse modules |
| Layered field | tension, thresholds, overlap, latent depth | ruled planes, hatching, contours, wireframe surfaces |

## 3. Quiet Field（密度约束）

| Parameter | Value |
|---|---|
| Quiet background | **70%–95%** |
| Mark coverage (line/dot/hatch/mesh) | **2%–8%** |
| Contrast hierarchy | 3 tiers: faint scaffold → readable structure → very few bright anchors |
| Material surface | full-frame flat uncoated matte paper, fine irregular grain, no borders/mockup/edge-shadows/stains/tears |

## 4. Restrained Color

- Stay grayscale by default
- When color carries meaning: **ONE pin-sized coral / orange-red / cobalt accent covering <0.2% of canvas**
- Equal polarity: light mode (off-white stock) and dark mode (charcoal stock) treated as equal, not "dark is edgier"

## 5. Text Gate

**No text by default.** When explicitly necessary: exact user wording only, one short phrase or ≤3 micro-labels, ≤6 words total.

## 6. Nine-Axis Recipe（写 prompt 前逐一声明）

format / polarity / family / transformation / geometry (radial/bilateral/directional/paired/distributed/vertically-staged) / scaffold (open field/faint grid/framed region/baseline) / anchor (off-white endpoint/central node/contrast line/structural void/none) / accent (none/coral/orange-red/cobalt) / text (none/exact wording)

## 7. Critical Gates（生成后自检）

- Correct requested ratio, composition designed for that ratio
- ONE legible spatial event, ONE primary family
- Quiet background stays dominant even when motif spans most of the frame
- Matte paper grain visible up close, not distressed/decorative
- Fine marks stay coherent, separated, intentional
- Color (if used) is one tiny semantic event
- Text gate obeyed — no stray letters/numerals/watermarks/pseudo-text
- Reads at thumbnail size, rewards full-size inspection

**Reject** candidates resolving into: dashboard, infographic, product screen, sci-fi HUD, colorful data-viz, generic gradient blob, photographic scene, character illustration, collage, aged zine, glossy 3D render.

## 8. Repair Playbook（挂了哪个门就查这行）

| 失败信号 | 修正 |
|---|---|
| 背景显得扁平数字化 | 明确 full-frame uncoated matte stock、细不规则纤维、干燥暗淡的纹理，只在全尺寸可见 |
| 纸感做旧/脏/戏剧化 | 明确干净新纸、均匀色调、克制自然纹理、扁平正投影扫描；移除做旧措辞 |
| 太密 | 图元/路径数量减 40%–60%，删最弱的支撑族，恢复 70%–95% 安静背景 |
| 几个想法互相竞争 | 只保留最强的 transformation verb，删掉不参与该事件的所有形态 |
| 像 UI 或 infographic | 面板/坐标轴/图表转成无标注 topology，只留抽象框架/节点/路径/量度 |
| 像发光 HUD | 用干燥石墨灰发丝线、matte paper、off-white 锚点替换发光效果 |
| 颜色变成装饰 | 回到灰阶，只留一个针尖大小的强调色承载语义焦点 |
| 细线纠缠或断裂 | 减少交叉、少用路径、加宽间距、统一主线宽 |
| 缩略图尺寸下几何消失 | 放大主关系或强化一个锚点，同时保持标记密度低 |
| 出现杂散/伪文字 | 声明 `zero text, zero letters, zero numerals` 并移除标签状框架 |
