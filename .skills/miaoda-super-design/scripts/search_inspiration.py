#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""search_inspiration.py — advanced design inspiration search (component-library ammo + template seeds).

Read-only. Emits inspiration text to stdout only. **Never writes to disk, never generates DESIGN.md.**

Usage:
    python3 search_inspiration.py "<3-8 English keywords>" \
        [--design-system] [--domain style|color|font|product|scenario] \
        [--theme-query "<user-language visual theme phrase, <=20 chars>"] [--seed N] [-n 3] [--lang Chinese]

Two ammo tracks:
  Component-library ammo (--design-system or default): Scenario motion baseline + Style DNA x3
      + Color directions x3 + Font directions x3 + Product Notes + Anti-Slop. Orthogonal parts;
      the agent assembles the spec itself.
  Template seeds (when --theme-query passes the theme.xlsx threshold): seed-random-sample <=3
      mature theme specs as starting points. On a miss this section is left empty with a hint
      to fall back to component assembly — no forced hit.

=== Language contract (wrong language => search is silently useless) ===
Each corpus's language has been verified column-by-column. The query language MUST match:

  positional query  -> **English**. Keywords columns in styles.csv (0/123 Chinese) /
      colors.csv (0/277) / scenarios.csv / products.csv are 100% English; a Chinese query
      hits ~0. Translate Chinese PRDs into English domain-entity words before passing.
  --theme-query     -> **Chinese** (user language) visual-mood phrase. theme.xlsx is searched
      over Chinese template rows only:
        English rows (Blueprint / Editorial / ...) are language-twins of an older batch —
          same concept as the Chinese row, not independent templates.
        The newer batch (30 rows with data.order empty) is entirely Chinese; that batch is
          the actively maintained canonical form.
      **Must be a visual-mood name, not an industry / product name / "XX official site":**
        Bad:  queries like "XX official site" / "some product page" always MISS.
        Good: 午夜奢华金箔 / 霓虹科技赛博 / 暗黑极简 / 复古胶片暗调 / 报纸美学高对比
      Extract vibe (mood / era / material / lighting) from the PRD, not industry.
  --lang            -> agenthub's lang_user ('Chinese' / 'Japanese' / 'English'). Only used
      for CJK body-font coverage checks and display-name selection; does not enter BM25.

Language conventions elsewhere (kept separate to avoid cross-contamination — see
references/asset-direction.md):
  search_fonts.py    -> **English** mood words (Mood_Keywords is fully English).
  recommend_colors.py-> **English** domain-entity words (the domain word decides search
                        scope; extra mood words are harmless).
  image_search tool  -> **follows the user / PRD language** (the image corpus is indexed in
      the corpus's own language; cross-language must rely on vector similarity, which has a
      low hit rate).
  Kling image-gen prompt -> **prefer Chinese** (empirical, not a hard rule): the kling-omni
      skill's prompt field itself is language-agnostic, but its SKILL.md examples are all
      Chinese and Kling is a domestic model trained mainly on Chinese data, so Chinese
      prompts are more reliable. asset-*.md is distilled from an English skill; translate
      its English composition plans to Chinese before feeding Kling.

Same query does not produce identical results: Style / Color / Font are seed-random-sampled
from a top-K pool, and so are template seeds. seed defaults to time_ns (different every
run); --seed N is reproducible.

Dependencies: pure standard library (theme.xlsx is read via a hand-written lightweight
parser; on parse failure it falls back to openpyxl, and if that is unavailable too the
template section degrades to empty with a hint — never raises).
The search engine reuses core.py's BM25.
"""

import argparse
import io
import random
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from core import BM25, _load_csv

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
REF_DIR = Path(__file__).resolve().parent.parent / "references"
THEME_XLSX = DATA_DIR / "theme.xlsx"
ANTI_SLOP_FILE = REF_DIR / "anti-slop.md"

_XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_COL_RE = re.compile(r"^([A-Z]+)")


def _col_to_index(cell_ref):
    """'C3' -> 2 (0-based column index)."""
    letters = _COL_RE.match(cell_ref).group(1)
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def _load_theme_rows_fast(path):
    """Read theme.xlsx's first sheet with pure stdlib -> [[cell, ...], ...] (header row included).

    3-4x faster than openpyxl (skips the whole package import plus style/formula parsing
    overhead) — this skill only needs cell values, not the formula evaluation or format
    rendering that openpyxl also does.
    Covers only the cell types actually observed in this file: inlineStr (inline string,
    no shared-string table) + n (number) + b (boolean), no merged cells. These three cover
    every cell type currently in theme.xlsx (verified by enumerating the `t=` attribute).
    If the file is ever converted to a shared-string table / formulas / a more complex
    format, this will fail to pick up values and return an empty table — the caller
    degrades along the existing "table is empty" path rather than crashing.
    """
    with zipfile.ZipFile(path) as z:
        xml_bytes = z.read("xl/worksheets/sheet1.xml")
    root = ET.fromstring(xml_bytes)
    rows_out = []
    for row_el in root.iter(f"{_XLSX_NS}row"):
        cells = {}
        max_idx = -1
        for c in row_el.findall(f"{_XLSX_NS}c"):
            idx = _col_to_index(c.get("r", "A1"))
            max_idx = max(max_idx, idx)
            t = c.get("t", "n")
            if t == "inlineStr":
                is_el = c.find(f"{_XLSX_NS}is")
                t_el = is_el.find(f"{_XLSX_NS}t") if is_el is not None else None
                cells[idx] = t_el.text if t_el is not None and t_el.text else ""
            elif t == "b":
                v_el = c.find(f"{_XLSX_NS}v")
                cells[idx] = bool(int(v_el.text)) if v_el is not None and v_el.text else False
            else:  # number (the default type, also this branch when there is no t= attribute)
                v_el = c.find(f"{_XLSX_NS}v")
                if v_el is None or v_el.text is None:
                    cells[idx] = None
                else:
                    txt = v_el.text
                    cells[idx] = float(txt) if "." in txt else int(txt)
        rows_out.append([cells.get(i) for i in range(max_idx + 1)])
    return rows_out

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

# -- Per-domain search columns (BM25 indexed fields) --
STYLE_SEARCH = ["Style Category", "Keywords", "Best For", "Type", "Design_DNA"]
COLOR_SEARCH = ["Product Type", "Keywords", "Notes"]
FONT_SEARCH = ["Font_Name_CN", "Font_Name_EN", "Category",
               "Mood_Keywords", "Best_For", "Best_For_CN"]
SCENARIO_SEARCH = ["Scenario", "Keywords"]
PRODUCT_SEARCH = ["Product Type", "Keywords"]

# top-K pool size: seed-random-sampled from the pool so the same query yields different results
STYLE_POOL, COLOR_POOL, FONT_POOL = 10, 8, 8

# theme.xlsx hit thresholds (both gates must pass)
#   THEME_MIN          : lower bound on the combined score
#   THEME_CONFIDENT_MIN: higher lower bound required when there is no strong title hit
# Why the second gate is needed: Chinese bigram tokenization lets generic bigrams from
# description / context inflate the score — completely unrelated industry rows can hit
# 4.x on desc noise alone. Only "score high enough" OR "non-generic title overlap"
# counts as a true hit; otherwise treat as a miss and fall back to component-library
# assembly.
THEME_MIN = 4.0
THEME_CONFIDENT_MIN = 5.0
THEME_TITLE_WEIGHT = 5.0
THEME_DESC_WEIGHT = 1.0
THEME_CONTEXT_WEIGHT = 0.25

# Generic tokens in theme.xlsx: if these appear only in description / context they cause
# false recalls; only when they hit in the title does the signal count as strong.
_THEME_GENERIC = frozenset({
    "主义", "风格", "界面", "工具", "专业", "现代", "简洁", "高端",
    "数字", "系统", "平台", "应用", "页面", "主题", "视觉", "设计",
    "功能", "管理", "数据", "问卷", "网页", "网站", "色调", "传统",
    "温暖", "清新",
    "style", "design", "modern", "clean", "tool", "app", "system",
    "platform", "page", "theme", "visual", "professional", "data", "digital",
})


# --- Generic search utilities ------------------------------------------------

def _load(filename):
    """Load a CSV from the data directory; empty list if it does not exist."""
    path = DATA_DIR / filename
    return _load_csv(path) if path.exists() else []


def _rank(rows, search_cols, query):
    """BM25 ranking; returns [(row, score), ...] in descending order (only score > 0)."""
    docs = [" ".join(str(r.get(c, "")) for c in search_cols) for r in rows]
    bm25 = BM25()
    bm25.fit(docs)
    ranked = bm25.score(query)
    return [(rows[i], s) for i, s in ranked if s > 0]


def _sample_pool(scored, pool_size, k, rng):
    """Randomly pick k rows out of the top-pool_size (the source of per-run variety).

    Returns everything when the pool is smaller than k; otherwise takes the
    top-pool_size, shuffles, and picks k.
    """
    pool = [row for row, _s in scored[:pool_size]]
    if len(pool) <= k:
        return pool
    idx = list(range(len(pool)))
    rng.shuffle(idx)
    return [pool[i] for i in sorted(idx[:k])]


def _truncate(text, limit):
    """Trim text to limit chars, preferring a sentence/clause boundary in the second half."""
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in ("; ", ". ", ", ", "，", "；"):
        p = cut.rfind(sep)
        if p > limit // 2:
            return cut[:p]
    return cut.rstrip() + "…"


def _load_anti_slop_hard():
    """Read the numbered bold lines inside the `## 硬约束` section of references/anti-slop.md.

    Only that section is parsed, so other numbered lists in the file (the blacklist table
    and friends) are not picked up.
    """
    if not ANTI_SLOP_FILE.exists():
        return []
    lines = ANTI_SLOP_FILE.read_text(encoding="utf-8").splitlines()
    rules, in_section = [], False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## "):
            in_section = "硬约束" in stripped
            continue
        if not in_section:
            continue
        m = re.match(r"^\d+\.\s*(.+)$", stripped)
        if not m:
            continue
        body = m.group(1)
        parts = body.split("**")
        rules.append(parts[1].strip() if len(parts) >= 3 else body.strip())
    return rules


# --- theme.xlsx inspiration seeds (BM25 top-K -> seed-random-sample <=3) -----

def _theme_tokens(text):
    """Tokenize text with the shared BM25 tokenizer and return the token set."""
    return set(BM25().tokenize(text))


def _title_overlap(query, title):
    """Non-generic token overlap between query and title — a generic-token-only title hit is not a strong signal."""
    overlap = _theme_tokens(query) & _theme_tokens(title)
    return {t for t in overlap if t not in _THEME_GENERIC}


def _bm25_scores(query, docs):
    """BM25-score the query against docs; returns {doc_index: score}."""
    b = BM25()
    b.fit(docs)
    return dict(b.score(query))


def _search_theme_seeds(query, seed, k=3):
    """BM25 + seed sampling of Chinese template seeds from theme.xlsx.

    Searches **Chinese templates only**:
      - The English templates in theme.xlsx (Blueprint / Editorial / Brutalism ...) are an
        older batch; each has a Chinese twin (工程蓝图 / ...) that is the same concept in
        another language, not an independent template.
      - The newer batch (`data.order=None`) is entirely Chinese — that is the actively
        maintained and still growing canonical set.
      - `--theme-query` is a user-language (Chinese) phrase, so searching only the
        Chinese-named rows aligns naturally and avoids recalling duplicate English twins.
    Hence: keep only rows whose title contains CJK; probe with the Chinese theme-query
    as a single probe.

    **Does not read `data.colors`**: that column is no longer maintained (all empty in the
    new batch). Palettes always go through recommend_colors.py; a template's color mood is
    described in the context body, which is enough.

    Returns {"seeds": [...], "reason": None} or {"seeds": [], "reason": "..."}.
    """
    if not THEME_XLSX.exists():
        return {"seeds": [], "reason": "theme.xlsx not found"}
    try:
        sheet_rows = _load_theme_rows_fast(THEME_XLSX)
    except Exception as e:
        # The hand-written parser only covers the cell types observed today (see
        # _load_theme_rows_fast's docstring). If the file switches to a more complex format
        # (merged cells / formulas / shared-string table) and parsing fails, fall back to
        # openpyxl (feature-complete but ~90ms slower — a cost paid only on this path).
        try:
            import openpyxl
            wb = openpyxl.load_workbook(THEME_XLSX, data_only=True)
            ws = wb.active
            sheet_rows = [[c.value for c in row] for row in ws.iter_rows()]
        except Exception as e2:
            return {"seeds": [], "reason": f"theme.xlsx parse failed (built-in parser: {e}; openpyxl fallback: {e2})"}
    if not sheet_rows:
        return {"seeds": [], "reason": "theme.xlsx has no data"}
    headers = sheet_rows[0]
    try:
        i_prod = headers.index("data.is_published_to_prod")
        i_title = headers.index("data.title")
        i_desc = headers.index("data.description")
        i_support = headers.index("data.support_app_types")
        i_ctx = headers.index("data.context")
    except ValueError as e:
        return {"seeds": [], "reason": f"theme.xlsx missing column: {e}"}

    titles, descs, ctxs, meta = [], [], [], []
    for row in sheet_rows[1:]:
        if len(row) <= max(i_prod, i_title, i_desc, i_support, i_ctx) or not row[i_prod]:
            continue
        support = "".join(str(row[i_support] or "").split()).lower()
        if "web" not in support:
            continue
        title = str(row[i_title] or "").strip()
        ctx = str(row[i_ctx] or "")
        if not title or not ctx:
            continue
        # "自动" is a CMS placeholder row; exclude it from matching
        if title in {"自动", "auto", "automatic"}:
            continue
        # Chinese templates only: English rows are language-twins of the old batch, skip (see docstring)
        if not re.search(r"[一-鿿]", title):
            continue
        titles.append(title)
        descs.append(str(row[i_desc] or ""))
        ctxs.append(ctx)
        meta.append({
            "title": title,
            "description": str(row[i_desc] or ""),
            "context": ctx,
        })
    if not meta:
        return {"seeds": [], "reason": "theme.xlsx has no Chinese Web-published themes"}

    probe = (query or "").strip()
    if not probe:
        return {"seeds": [], "reason": "no valid search term (--theme-query needs a user-language phrase)"}

    title_scores = _bm25_scores(probe, titles)
    desc_scores = _bm25_scores(probe, descs)
    ctx_scores = _bm25_scores(probe, ctxs)
    scored = []
    for i, m in enumerate(meta):
        overlap = _title_overlap(probe, m["title"])
        title_score = title_scores.get(i, 0) if overlap else 0
        s = (THEME_TITLE_WEIGHT * title_score
             + THEME_DESC_WEIGHT * desc_scores.get(i, 0)
             + THEME_CONTEXT_WEIGHT * ctx_scores.get(i, 0))
        if s < THEME_MIN:
            continue
        # Second gate: without a non-generic title overlap, require a higher score.
        # Chinese bigrams let generic bigrams in desc / context inflate scores to a fake
        # 4.x hit — those must be blocked.
        if s < THEME_CONFIDENT_MIN and not overlap:
            continue
        scored.append((m, s))
    if not scored:
        return {"seeds": [], "reason": "no strong hit for query against the Chinese template library"}
    scored.sort(key=lambda x: x[1], reverse=True)
    # Above-threshold pool -> seed-random-sample k (not top-1)
    rng = random.Random(seed)
    pool = scored[:max(k * 2, 6)]  # pool >= 6 or 2k to ensure diversity
    idx = list(range(len(pool)))
    rng.shuffle(idx)
    picked = sorted(idx[:k])
    seeds = []
    for j in picked:
        m, s = pool[j]
        seeds.append({
            "title": m["title"],
            "description": m["description"],
            "context": m["context"],
            "score": round(s, 2),
        })
    return {"seeds": seeds, "reason": None}


def _format_theme_seeds(result):
    """Render the theme-seed search result as output lines (hit list, or a MISS block with hints)."""
    seeds = result["seeds"]
    if not seeds:
        reason = result.get("reason") or "MISS"
        return [
            "## Template seeds (MISS)",
            f"- reason: {reason}",
            "- **Common mistake: `--theme-query` was written as an industry name / product name / "
            "'XX official site'** — the theme library indexes visual mood names, not industry names.",
            "  - Bad examples: 「XX 官网」/「某某产品站」/「某某工具页」 (industry / product names)",
            "  - Good examples: 午夜奢华金箔 / 霓虹科技赛博 / 暗黑极简 / 复古胶片暗调 / 报纸美学高对比",
            "  - How to write it: extract mood/era/material/lighting words (vibe) from the PRD, "
            "not industry (industry/product names). Retry once.",
            "- If no matching mood exists: fall back to component-library assembly (Style DNA + Scenario cross); "
            "for the 3rd draft, use a seconds roulette (`date +%S` % 20 + 1) to boldly pick a number from styles.csv.",
            "- If `--theme-query` is in English: the template library indexes only Chinese theme names, "
            "switch to Chinese and retry.",
            "",
        ]
    lines = [
        f"## Template seeds (seed-random sampled {len(seeds)}, vibe-layer ammo)",
        "**Seeds are non-color vibe starting points, not copy mandates.** Borrow the material / "
        "motion / font language that fits the PRD; drop the rest. Structure grows from the PRD.",
        "- **Palette never comes from the seed** — use recommend_colors.py + the questionnaire "
        "answer. The seed's color values are mood context only.",
        "- Seed font is a candidate; use if it fits, otherwise pick from Font directions or run "
        "`search_fonts.py`.",
        "- Every draft adds one PRD-specific signature to the stamp `sig:` line.",
        "- ≥3 hits: one seed per draft; 1-2 hits: hit drafts borrow from here, others lean on "
        "skeleton + emphasis-device diversity.",
        "",
    ]
    for k, s in enumerate(seeds, 1):
        lines.append(f"### Seed {chr(64 + k)}: {s['title']}  [score={s['score']}]")
        if s["description"]:
            lines.append(f"- vibe: {_truncate(s['description'], 200)}")
        lines.append("- spec (borrow material/motion/font language; Color and structure sections are "
                     "mood context only):")
        for line in s["context"].splitlines():
            lines.append(f"  {line}")
        lines.append("")
    return lines


# --- Color diversity (keeps the three candidates out of one hue band) --------

_COOL_DARK = frozenset({"neutral", "blue", "cyan", "green"})


def _color_bucket(hex_color):
    """Classify a hex color into a coarse hue bucket (or neutral/unknown)."""
    import colorsys
    h = str(hex_color or "").lstrip("#")
    if len(h) != 6:
        return "unknown"
    try:
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return "unknown"
    hue, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s < 0.15 or v < 0.2:
        return "neutral"
    deg = hue * 360
    if deg < 30 or deg >= 330:
        return "red"
    if deg < 75:
        return "orange"
    if deg < 150:
        return "green"
    if deg < 210:
        return "cyan"
    if deg < 270:
        return "blue"
    return "purple"


def _ensure_color_diversity(colors, all_scored, rng):
    """If every sample lands in a cool/dark band, or bands repeat, swap in a warm/other-band candidate."""
    if len(colors) < 3:
        return colors
    buckets = [_color_bucket(c.get("Primary")) for c in colors]
    if len(set(buckets)) >= 3 and not all(b in _COOL_DARK for b in buckets):
        return colors
    for row, _s in all_scored:
        if row in colors:
            continue
        b = _color_bucket(row.get("Primary"))
        if b not in _COOL_DARK and b not in buckets:
            colors[-1] = row
            return colors
    return colors


# --- Font coverage top-up (>=1 heading + >=1 body; a CJK app's body font must support the charset) ---

def _font_covers_lang(font, lang):
    """Can this font render the user's language? (stops a Latin-only font being used as CJK body text)"""
    font_lang = str(font.get("language", ""))
    low = (lang or "").lower()
    if "japanese" in low or low == "ja":
        return any(x in font_lang for x in ("日", "简", "繁", "中"))
    if "korean" in low or low in ("ko", "ko-kr"):
        return "韩" in font_lang
    return any(x in font_lang for x in ("简", "繁", "中"))


def _lang_needs_cjk(lang):
    """Does this user language require a CJK-capable body font?"""
    low = (lang or "").lower()
    return ("zh" in low or "chinese" in low
            or "japanese" in low or low == "ja"
            or "korean" in low or low in ("ko", "ko-kr")
            or bool(re.search(r"[一-鿿ぁ-んァ-ン가-힣]", lang or "")))


def _ensure_font_coverage(fonts, all_scored, cjk_app, lang):
    """Samples must contain >=1 heading-capable font + >=1 body-capable font (CJK app body must cover the language)."""
    if len(fonts) < 2:
        return fonts

    def body_ok(f):
        if str(f.get("Usage", "")) not in ("body", "both"):
            return False
        return _font_covers_lang(f, lang) if cjk_app else True

    def heading_ok(f):
        return str(f.get("Usage", "")) in ("heading", "both")

    if any(heading_ok(f) for f in fonts) and any(body_ok(f) for f in fonts):
        return fonts
    extended = [row for row, _s in all_scored]

    def inject(role_ok, keep_ok):
        if any(role_ok(f) for f in fonts):
            return
        cand = next((c for c in extended if role_ok(c) and c not in fonts), None)
        if cand is None:
            return
        keepers = [i for i, f in enumerate(fonts) if keep_ok(f)]
        if len(keepers) == 1:
            i = next((j for j in range(len(fonts)) if j not in keepers), len(fonts) - 1)
        else:
            i = len(fonts) - 1
        fonts[i] = cand

    # body is scarcer for CJK apps, so top it up first; when topping up heading, don't overwrite the only body slot
    inject(body_ok, keep_ok=heading_ok)
    inject(heading_ok, keep_ok=body_ok)
    return fonts


def _mark_latin_heading_only(fonts, lang):
    """In a CJK app, a font that can't render the user's language can't be tagged body/both — demote it to heading."""
    for f in fonts:
        if not _font_covers_lang(f, lang) and f.get("Usage") in ("body", "both"):
            f["Usage"] = "heading"
    return fonts
# --- Per-section formatting --------------------------------------------------

FONT_URL_PREFIX = "https://resource-static.bj.bcebos.com/fonts-skill/"


def _clean_tech(text):
    """Strip CSS numeric values / hex from the csv — ammo gives design language, not code to copy."""
    t = str(text or "")
    t = re.sub(r"(box-shadow|text-shadow|border-radius|backdrop-filter):\s*[^;,]+[;,]?", "", t)
    t = re.sub(r"rgba?\([^)]+\)", "", t)
    t = re.sub(r"clamp\([^)]*\)", "", t)
    t = re.sub(r"(font-size|font-weight|letter-spacing|line-height):\s*[^;,]*[;,]?", "", t)
    t = re.sub(r"#[0-9A-Fa-f]{3,8}\b", "", t)
    t = re.sub(r"\d+(px|pt)\b", "", t)
    t = re.sub(r"\d+(\.\d+)?(rem|vw|vh|em)\b", "", t)
    t = re.sub(r"\s*[;,](\s*[;,])+", ";", t)
    return re.sub(r"\s{2,}", " ", t).strip(" ;,")


def _motion_label(mb):
    """Map a 1-10 Motion_Baseline value to a human-readable intensity label."""
    try:
        v = int(str(mb).strip())
    except (TypeError, ValueError):
        return "unspecified"
    if v <= 2:
        return "ultra-minimal (loading/state feedback only)"
    if v <= 4:
        return "functional (restrained state transitions)"
    if v <= 6:
        return "moderate (entrance + hover)"
    if v <= 8:
        return "expressive (choreographed scroll reveals)"
    return "immersive (fully choreographed, motion as narrative)"


def _fmt_scenario(sc):
    """Render the Scenario section (layout rules + motion ceiling) as output lines."""
    if not sc:
        return []
    parts = []
    if sc.get("Layout_Rules"):
        parts.append(f"layout={_truncate(sc['Layout_Rules'], 160)}")
    mb = sc.get("Motion_Baseline", "")
    if mb:
        parts.append(f"motion={mb}/10 {_motion_label(mb)}")
    if sc.get("Animation_Constraint"):
        parts.append(f"anim={_truncate(sc['Animation_Constraint'], 200)}")
    return [
        f"### Scenario: {sc.get('Scenario', '?')}",
        "  " + " | ".join(parts) if parts else "",
        "  This is the ceiling for motion intensity; when the PRD does not specify a scenario, "
        "follow Official Website(4). "
        "Prefer what pure CSS can do (@keyframes/scroll-snap/<video>), pull in motion libraries only as needed.",
        "",
    ]


def _fmt_styles(styles):
    """Render the Style DNA section as output lines."""
    lines = [f"### Style DNA (seed-random sampled {len(styles)} of 123 in library)"]
    for s in styles:
        name = s.get("Style Category", "?")
        dna = _truncate(s.get("Design_DNA", ""), 80)
        sig = _truncate(_clean_tech(s.get("Signature_Elements", "")), 220)
        comp = _truncate(_clean_tech(s.get("Composition_Rules", "")), 150)
        # Effects & Animation: what motion this style should carry — the direct source for
        # "why the first draft had no fitting motion". The csv is very specific here (e.g.
        # "staggered slide-up list reveal on load"); strip the numbers and the motion
        # semantics remain.
        motion = _truncate(_clean_tech(s.get("Effects & Animation", "")), 200)
        avoid = _truncate(s.get("Do Not Use For", ""), 120)
        lines.append(f"- **{name}**" + (f" — DNA={dna}" if dna else ""))
        if sig:
            lines.append(f"  sig: {sig}")
        if comp:
            lines.append(f"  comp: {comp}")
        if motion:
            lines.append(f"  motion: {motion}")
        if avoid:
            lines.append(f"  avoid for: {avoid} ← if it hits the PRD scenario, switch styles")
        lines.append("")  # blank line between candidates so multiple sig/comp/motion don't clump together
    return lines


def _fmt_colors(colors):
    """Render the Color directions section as output lines (mood context only)."""
    lines = [
        f"### Color directions ({len(colors)} entries, mood context only)",
        "  Actual palette comes from `recommend_colors.py` + the questionnaire answer.",
    ]
    fields = [("Primary", "P"), ("On Primary", "on"), ("Accent", "A"), ("On Accent", "on"),
              ("Secondary", "S"), ("Background", "BG"), ("Foreground", "FG"),
              ("Muted", "M"), ("Border", "B")]
    for c in colors:
        pt = c.get("Product Type", "")
        parts = [f"{lbl} {c.get(key)}" for key, lbl in fields if c.get(key)]
        if parts:
            lines.append(f"- {pt + ': ' if pt else ''}" + " | ".join(parts))
    lines.append("")
    return lines


def _fmt_fonts(fonts, lang):
    """Render the Font directions section as output lines."""
    lines = [
        f"### Font directions ({len(fonts)} entries)",
        f"  font_prefix={FONT_URL_PREFIX}",
        "  Use these directly when they fit — build @font-face from font_prefix + file. Run "
        "`search_fonts.py` only when none fit or you need another weight/lang; don't repeat a query.",
    ]
    low = (lang or "").lower()
    use_cn = "zh" in low or "chinese" in low
    for f in fonts:
        en = f.get("Font_Name_EN") or f.get("Font_Family", "?")
        cn = f.get("Font_Name_CN", "")
        name = (cn if cn and cn != en else en) if use_cn else en
        fam = f.get("Font_Family", en)
        head = f"- {name} ({f.get('Category', '')})"
        if f.get("Usage"):
            head += f" [{f['Usage']}]"
        lines.append(head)
        detail = [f"fam={fam}"]
        if f.get("Weights"):
            detail.append(f"w={f['Weights']}")
        if f.get("language"):
            detail.append(f"lang={f['language']}")
        lines.append("  " + " | ".join(detail))
        fit = _truncate(f.get("Best_For") or f.get("Mood_Keywords", ""), 90)
        if fit:
            lines.append(f"  fit: {fit}")
    lines.append("")
    return lines


def _fmt_product(prod):
    """Render the Product Notes section as output lines."""
    if not prod:
        return []
    lines = ["### Product Notes"]
    if prod.get("Key Considerations"):
        lines.append(f"- key points: {_truncate(prod['Key Considerations'], 300)}")
    if prod.get("Color Palette Focus"):
        lines.append(f"- palette focus: {_truncate(prod['Color Palette Focus'], 200)}")
    lines.append("")
    return lines


def _fmt_anti_slop(rules):
    """Render the Anti-Slop hard constraints section as output lines."""
    if not rules:
        return []
    return ["### Anti-Slop hard constraints"] + [f"- {r}" for r in rules] + [""]


# --- Main entry --------------------------------------------------------------

def _design_system(query, seed, lang="", n=3):
    """One-stop ammo pack: Scenario + Style x3 + Color x3 + Font x3 + Product + Anti-Slop."""
    rng = random.Random(seed)

    # Scenario (take top-1, no seed sampling — a scenario usually has a single match)
    scenarios = _load("scenarios.csv")
    sc_ranked = _rank(scenarios, SCENARIO_SEARCH, query)
    scenario = sc_ranked[0][0] if sc_ranked else None

    # Style DNA (seed-sample n out of top-POOL)
    styles_data = _load("styles.csv")
    # Keep Web-relevant entries only (filter out Mobile-exclusive ones)
    web_styles = [s for s in styles_data
                  if s.get("Type", "").strip() != "Mobile"
                  and "(Mobile)" not in s.get("Style Category", "")]
    style_scored = _rank(web_styles, STYLE_SEARCH, query)
    styles = _sample_pool(style_scored, STYLE_POOL, n, rng)

    # Color directions (seed-sample n out of top-POOL + diversity top-up)
    products = _load("products.csv")
    prod_scored = _rank(products, PRODUCT_SEARCH, query)
    prod = prod_scored[0][0] if prod_scored else None
    prod_type = prod.get("Product Type", "") if prod else ""
    color_query = f"{prod_type} {query}" if prod_type else query
    colors_data = _load("colors.csv")
    color_scored = _rank(colors_data, COLOR_SEARCH, color_query)
    colors = _sample_pool(color_scored, COLOR_POOL, n, rng)
    colors = _ensure_color_diversity(colors, color_scored, rng)

    # Font directions (seed-sample n out of top-POOL + coverage top-up)
    font_query = (
        f"{query} " + " ".join(s.get("Style Category", "") for s in styles[:n])
    ).strip()
    cjk = _lang_needs_cjk(lang)
    fonts_data = _load("fonts.csv")
    font_scored = _rank(fonts_data, FONT_SEARCH, font_query)
    fonts = _sample_pool(font_scored, FONT_POOL, n, rng)
    fonts = _ensure_font_coverage(fonts, font_scored, cjk, lang)
    if cjk:
        fonts = _mark_latin_heading_only(fonts, lang)

    # Anti-Slop
    anti_slop = _load_anti_slop_hard()

    lines = ["## Component library ammo (inspiration ammo)", ""]
    lines.extend(_fmt_scenario(scenario))
    lines.extend(_fmt_styles(styles))
    lines.extend(_fmt_colors(colors))
    lines.extend(_fmt_fonts(fonts, lang))
    lines.extend(_fmt_product(prod))
    lines.extend(_fmt_anti_slop(anti_slop))
    return "\n".join(lines)


def _single_domain(query, domain, seed, n=3, lang=""):
    """Single-domain search (style / color / font / product / scenario)."""
    rng = random.Random(seed)
    if domain == "scenario":
        data = _load("scenarios.csv")
        scored = _rank(data, SCENARIO_SEARCH, query)
        sc = scored[0][0] if scored else None
        return "\n".join(_fmt_scenario(sc)) if sc else "(no matching Scenario)"
    if domain == "style":
        data = _load("styles.csv")
        web = [s for s in data
               if s.get("Type", "").strip() != "Mobile"
               and "(Mobile)" not in s.get("Style Category", "")]
        scored = _rank(web, STYLE_SEARCH, query)
        styles = _sample_pool(scored, STYLE_POOL, n, rng)
        return "\n".join(_fmt_styles(styles)) if styles else "(no matching Style)"
    if domain == "color":
        data = _load("colors.csv")
        scored = _rank(data, COLOR_SEARCH, query)
        colors = _sample_pool(scored, COLOR_POOL, n, rng)
        colors = _ensure_color_diversity(colors, scored, rng)
        return "\n".join(_fmt_colors(colors)) if colors else "(no matching Color)"
    if domain == "font":
        data = _load("fonts.csv")
        scored = _rank(data, FONT_SEARCH, query)
        fonts = _sample_pool(scored, FONT_POOL, n, rng)
        cjk = _lang_needs_cjk(lang)
        fonts = _ensure_font_coverage(fonts, scored, cjk, lang)
        if cjk:
            fonts = _mark_latin_heading_only(fonts, lang)
        return "\n".join(_fmt_fonts(fonts, lang)) if fonts else "(no matching Font)"
    if domain == "product":
        data = _load("products.csv")
        scored = _rank(data, PRODUCT_SEARCH, query)
        prod = scored[0][0] if scored else None
        return "\n".join(_fmt_product(prod)) if prod else "(no matching Product)"
    return f"unknown domain: {domain}"


def main():
    """CLI entry: emit component-library ammo and/or theme template seeds to stdout."""
    parser = argparse.ArgumentParser(
        description="Advanced design inspiration search (read-only, stdout-only, never writes to disk)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("query", help="3-8 English keywords (BM25 search over style/color/font)")
    parser.add_argument(
        "--design-system", "-ds", action="store_true",
        help="one-stop component library ammo pack (Scenario+Style+Color+Font+Product+Anti-Slop)",
    )
    parser.add_argument(
        "--domain", "-d",
        choices=["style", "color", "font", "product", "scenario"],
        help="single-domain search (no template seeds)",
    )
    parser.add_argument(
        "--theme-query", "-tq", default="",
        help="Chinese visual theme phrase, max 20 chars, e.g. 暗黑极简 (triggers template seed search)",
    )
    parser.add_argument(
        "--seed", type=int, default=None,
        help="random seed; defaults to time_ns (different each run), a given value is reproducible",
    )
    parser.add_argument(
        "-n", "--max-results", type=int, default=3,
        help="samples per domain (default 3)",
    )
    parser.add_argument("--lang", default="", help="user language (e.g. Chinese)")
    args = parser.parse_args()

    seed = args.seed if args.seed is not None else (time.time_ns() % (2 ** 31))

    output = []

    # 1. Component-library ammo
    if args.domain:
        output.append(_single_domain(args.query, args.domain, seed, args.max_results, args.lang))
    elif args.design_system or not args.theme_query:
        # Default behaviour (no --domain, no --theme-query): also emit the ammo pack
        output.append(_design_system(args.query, seed, args.lang, args.max_results))

    # 2. Template seeds (appended when --theme-query is given; also appended for --design-system)
    if args.theme_query or args.design_system:
        # Chinese templates only; when --theme-query is missing, fall back to the positional
        # query (English usually just misses — that's expected, the model is meant to pass
        # a Chinese theme phrase).
        probe = args.theme_query.strip() or args.query
        result = _search_theme_seeds(probe, seed, k=args.max_results)
        output.append("\n".join(_format_theme_seeds(result)))

    print("\n".join(output))


if __name__ == "__main__":
    main()

