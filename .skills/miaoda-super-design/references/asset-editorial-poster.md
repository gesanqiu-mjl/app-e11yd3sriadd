# 极简 zine / Editorial 海报素材 / Attention Geometry

> **何时读**：`asset-direction.md §2` 命中极简 zine / editorial poster / 出版物气质。

---

## 1. Attention Geometry（本文最值钱的一节）

Do not write "minimal editorial illustration". Write the numbers:

| Parameter | Value | Why |
|---|---|---|
| Plain field (paper/background) | **70%–90%** of canvas | Negative space is composition, not absence of content |
| Visual cluster | **8%–25%** of canvas | One small cluster; anything larger becomes a full-bleed scene |
| Cluster position | center / upper-middle / lower-middle / lower-left / upper-right | Pick one deliberately, vary across sections |
| Edge behaviour | **no edge-hugging** | Cluster must float in the field, not touch borders |

## 2. Image Anchor（一图一主体）

An image must revolve around **exactly one** visualizable subject. Choose one:

- one object / photo crop / specimen / cutout / silhouette
- old printed illustration / texture window
- one small conceptual relation

**Reject the AI default**: "lots of pretty things + lots of light + lots of gradient + lots of ornament". If two subjects compete, delete the weaker one.

## 3. Anchor Treatment

Make the anchor belong to the surface. Grayscale photos and paper fragments may use: low contrast, photocopy softness, torn edge, softened edge, halftone, scanline, risograph grain, xerox wear, ink bleed, slight misregistration.

**Do NOT apply low saturation / low contrast to the chosen color anchor** — that kills it.

## 4. Color Engine（受限高饱和锚点）

| Rule | Value |
|---|---|
| Chromatic anchor share | **0.8%–2.5%** of canvas, or **15%–35%** of the visual cluster |
| Hue count | ONE main high-chroma hue per image (a tiny secondary allowed only if it supports the subject) |
| Anchor form | the subject itself / flat silhouette / irregular cutout / substantial block / partial-color photo region / bold fragmented type |
| Banned wording | `pale` `muted` `faded` `pastel` `low saturation` `near-monochrome` — unless the user explicitly asks for muted output |
| Support layer | keep paper, grayscale photo, microtext and secondary marks subdued |

**Key insight**: color can carry the subject itself. Prefer a colored tree / fruit / shell / geometric cutout / window over a gray object with one colored registration tick.

## 5. Variation Engine（防批次趋同）

Pick one per axis before writing the prompt. If recent outputs used the same layout or anchor, choose a different one.

| Axis | Options |
|---|---|
| Layout family | center-fragment / lower-left-float / upper-right-block / dual-panel / irregular-cutout / type-led / dot-orbit / single-specimen |
| Image anchor | tiny faded photo / torn-paper clipping / flat silhouette / solid color block / old printed illustration / object specimen / translucent geometric overlay / abstract texture window |
| Typography mode | fragmented floating letters / short phrase pressed against image edge / archive microtext with date / diagonal scattered words / low-contrast ghost text / headline-as-object / text inside color block / almost textless |
| Texture mode | xerox softness / risograph grain / letterpress ink bleed / halftone degradation / film grain / scan noise + paper fibers / aged paper mottling |

**Do not default to "tiny photo + blue dots + microtext"** unless it truly fits.

## 6. Prompt Shape（四段式）

1. canvas + surface + negative space share + cluster size/location
2. subject metaphor + anchor type + anchor treatment
3. typography + accent strategy (exact hue, material form, approximate visual share) + print defects
4. flat-scan mood + avoid list

A concrete, imageable prompt beats a long style essay. **喂给可灵前把这四段转成中文**（asset-direction.md §7）。

## 7. Negative Constraints

Always avoid: full-bleed subject/scene / commercial poster headline hierarchy / product-ad layout / logo lockup / CTA / campaign feel / clean digital UI background / glossy paper mockup or heavy paper shadow / 3D rendering / cinematic lighting / hard shadows / depth of field / neon / cyberpunk / cute cartoon / kawaii / anime / fashion-editorial drama / too many objects, stickers, colors, captions, textures / high-resolution stock-photo realism / long perfectly-readable text blocks

## 8. Thumbnail QA（失败则 regenerate once）

Inspect the result **at thumbnail scale** before accepting:

- Does 70%–90% still read as plain field?
- Is the cluster still roughly 8%–25%?
- Is there ONE clear visual metaphor (not a whole illustrated scene)?
- **Is the high-chroma anchor clearly visible at thumbnail size?** If absent / washed out / reduced to an imperceptible mark → regenerate once with stronger color wording and a larger colored area.
- Are typography and microtext part of the composition (not pasted on top)?
- Free of full-bleed / commercial / 3D / neon / cinematic / cartoon / brand-template aesthetics?
