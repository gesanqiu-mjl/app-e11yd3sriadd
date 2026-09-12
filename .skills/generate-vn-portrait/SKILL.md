---
name: generate-vn-portrait
description: "Generate visual-novel portrait prompts first, then use the bundled GPT-Image-2 image generation reference to create raw images from those finalized portrait prompts, and postprocess the result: one character per image, default 3:4 portrait canvas, half-body/bust framing, transparent-ready flat chroma-key background, narrative-game character expression and pose direction. Use when Codex needs 人物立绘, visual-novel portraits, dating-sim character portraits, dialogue UI standees, or story-game character art. Use generate2dsprite for gameplay sprites, animation frames, sprite sheets, props, projectiles, and frame/grid extraction; use generate2dmap for backgrounds, locations, maps, stages, tilemaps, and scene art."
---

# Generate VN Portrait

Use this skill for visual-novel character portraits, not gameplay sprites or maps. Use `$generate2dsprite` for sprite sheets, animation frames, props, projectiles, and transparent gameplay assets. Use `$generate2dmap` for backgrounds, maps, location art, stages, and scene images.

Default output: **one character, one image, 3:4 vertical canvas, half-body/bust framing, flat chroma-key background**.

## THIS SKILL GENERATES REAL IMAGE FILES — DO NOT FAKE IT

This skill produces actual PNG art by calling an image-generation API through a bundled script. It is **not** a request to hand-code a portrait.

- **DO** run the two commands in the Required Steps below. Every portrait must end as a real transparent PNG under `assets/portraits/<character-id>/`.
- **DO NOT** substitute SVG, emoji, CSS gradients, colored `<div>`s, initials, canvas drawing, or any hand-authored placeholder for the portrait. That is a task failure, not an acceptable fallback.
- The generation capability is bundled locally and self-contained. You do **not** need to read any other file, call any external skill, or ask the user for API keys — the key is injected by the platform at runtime.
- If a step errors, fix the command and retry. Do not silently downgrade to a placeholder.

## Required Steps (single pass, no extra reading needed)

Everything you need — endpoint, auth, parameters, exact commands — is inline in this file. Do the following in order.

### Step 1 — Build the final portrait prompt

Inspect the request/narrative script and extract: story genre, period, region, tone, character role, age range, personality, emotional state, outfit, and any attached reference image role. If several characters are requested, produce **one prompt and one image per character**. If details are sparse, infer only practical portrait details that fit the genre. Optionally read `references/style-and-acting.md` for genre-specific style/expression cues (optional — not required to proceed).

Write the prompt in **English** (the model renders English far better than Chinese) using the Final Image Prompt Contract at the bottom of this file. Normalize wording into portrait language (e.g. replace "full body / standing" with "half-body / bust portrait").

### Step 2 — Generate the raw image (run this exact command)

```bash
python3 .skills/generate-vn-portrait/scripts/generate_image.py \
  --prompt "ENGLISH_PORTRAIT_PROMPT_HERE" \
  --output assets/portraits/raw/<portrait-id>-raw.png \
  --size 1024x1536
```

- **Set the Bash tool timeout to 600000 ms (600 s).** The default 120 s will cut off the request.
- The script calls GPT-Image-2, decodes the result, and writes the PNG to disk itself. **The API key is injected by the platform via `INTEGRATIONS_API_KEY` — you do not supply it.** Base64 image data never enters your context.
- On success the script prints one line of JSON: `{"file": "...", "revised_prompt": "...", "size": "..."}`. Read `file` and `revised_prompt` to confirm it worked.
- Create exactly one image per requested portrait. Also save the prompt text to `assets/portraits/raw/<portrait-id>.prompt.txt`.
- Use `--size 1024x1536` for the default vertical 3:4 canvas. (Endpoint/auth details, if ever needed for an in-app Edge Function, are in `references/guide.md` — but the script above needs nothing extra.)

### Step 3 — Remove the background (run this exact command)

```bash
python3 .skills/generate-vn-portrait/scripts/process_vn_portrait_sheet.py \
  --input assets/portraits/raw/<portrait-id>-raw.png \
  --output-dir assets/portraits/<character-id> \
  --rows 1 --cols 1 \
  --labels <portrait-id> \
  --key-color "#FF00FF" \
  --edge-contract 1 --edge-feather 0.25 \
  --trim --padding 24
```

- Use `--key-color "#FF00FF"` by default. Use `--key-color "#00FF00"` **only** when the character design is dominated by magenta/pink/purple and you intentionally generated on a green background.
- If a visible key-color fringe remains, retry with `--edge-contract 2`. If linework/hair erodes, go back to `--edge-contract 1` and set `--edge-feather 0`.
- Do **not** use `--auto-key border` on the normal path (it can mask a failed generation).

### Step 4 — QA and wire into the app

- Confirm the output PNG has an alpha channel, transparent corners, one character, half-body/bust framing, and no multi-frame sheet or key-color fringe.
- Before using the portrait in app/game code, **import the processed transparent PNG explicitly at the top of the file**. Do not reference the raw path or assume the bundler auto-discovers it.
- In a Phaser scene, scale the portrait to ~50–60% of canvas height: `targetHeight = cameraHeight * 0.55; scale = targetHeight / portrait.height`. Do not use the native pixel size as display size.

## Hard Requirements (image content)

- One character per image; vertical `3:4` canvas; half-body/bust framing (head to chest or waist) — no legs, feet, or full body unless explicitly asked.
- One expression, one pose. No multiple actions, frames, poses, or character sheets unless explicitly asked.
- Background is a perfectly flat solid `#FF00FF` magenta (or `#00FF00` green for magenta/purple-dominant subjects) filling the **entire** canvas. No scenic background, floor, cast shadow, gradient, texture, haze, lighting variation, UI, border, labels, text, or watermark.
- Do not use words like `sprite`, `sprite quality`, `sprite sheet`, `frame`, `grid`, `full body`, `standing full body`, `clear background`, or `simple gradient` in the final prompt unless the user explicitly requests it.

## Final Image Prompt Contract

Do not send a loose user request directly to image generation. Structure the final prompt like this:

```text
Use case: illustration-story
Asset type: visual novel character portrait / 人物立绘
Primary request: <one-sentence character role and story genre>
Subject: exactly one character, <age range>, <role>, <personality>, <outfit/accessories>
Expression and pose: <one expression>, <one subtle upper-body gesture or posture>
Style/medium: <genre-specific VN illustration style>, clean readable face, consistent linework, polished but not over-rendered
Composition/framing: vertical 3:4 canvas, half-body/bust portrait, head to chest or head to waist, no legs, no feet, no full-body view, character fills most of the canvas height, centered, generous padding around hair and shoulders
Background: perfectly flat solid <#FF00FF or #00FF00> chroma-key background filling the entire canvas
Constraints: one character only, one pose only, one expression only, no scenic background, no gradient, no floor, no shadow, no text, no watermark, no UI, no border
Avoid: sprite, sprite sheet, animation frames, action poses, full-body pose, legs, feet, multiple characters, multiple expressions, character sheet, clear background, simple gradient
```

## Genre And Acting

Use character acting words, not action-animation words. Prefer small, portrait-friendly acting:

- gaze direction, guarded smile, tired eyes, shy glance, confident half-smile, nervous hand near collar, notebook held to chest, one hand on backpack strap, folded arms, relaxed shoulders, clenched jaw, restrained grief.
- For youthful romance, keep the pose simple and readable.
- For mystery or historical drama, use more restrained expressions and period-specific clothing details.
- For stylized comedy, allow brighter expression and simpler shapes.

## Output Layout

```text
assets/portraits/
  raw/
    <portrait-id>-raw.png
    <portrait-id>.prompt.txt
  <character-id>/
    <portrait-id>.png
    sheet-alpha.png
    manifest.json
```

For narrative scripts, use `assets.portraits` ids as stable filenames.
