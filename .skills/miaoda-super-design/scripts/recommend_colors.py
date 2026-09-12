#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
recommend_colors.py -- samples 3 palettes from data/colors.csv, cutting off the model's built-in
archetype associations.

**Why this must go through a script instead of letting the model pick colors**:
    The model has strong training priors on PRD keywords and maps them straight to a fixed
    archetype formula. A hue-spread check across the three drafts only blocks numeric
    similarity, not "complementary archetype combos". This script retrieves domain entities
    from the real brand-inspiration library in colors.csv, applies sampling constraints
    (hue family / lightness / Product Type spread), and outputs three genuinely random
    palettes. The model keeps only chroma/lightness fine-tuning rights; hue H is locked.

**Usage**:
    python3 scripts/recommend_colors.py "<3-6 English domain-entity keywords>" [--seed N] [--k 30]

**Prefer industry-entity names as keywords** that align with the Product Type column in
    colors.csv. When uncertain, list 2-3 synonymous industry names to widen the hit surface.
    Avoid product-feature words and generic suffixes (platform / app / system) — they pull
    hits toward unrelated rows that happen to share the suffix.

**Output**: JSON with 3 palettes, each carrying primary/accent/background/foreground/muted/
    border/source_product_type/source_notes. The hue_desc field states hue facts (e.g.
    "青绿 深底"), but the label shown in the questionnaire is named on the spot by the model
    from the PRD context (an evocative name, <=5 chars). These feed the P1 questionnaire options
    for the three drafts, and the default three-draft colors if the user skips.

**Hard sampling constraints**:
    - the three primaries are pairwise >=60 degrees apart (HSL color wheel)
    - at least 1 light-background draft (bg L >= 85%) + 1 dark-background draft (bg L <= 20%)
    - the three come from different Product Types (no repeats)
    - seed is controllable, defaults to time_ns (repeated runs on the same PRD differ)

**Fallback when BM25 returns nothing**: sample uniformly across the whole library (keeps
    diversity, gives up relevance).

**--hue-lock <band>** (only pass this when the user explicitly named a color direction, e.g.
    "pink-toned" / "blue-violet"; do not pass it otherwise):
    Restricts all 3 primaries to one hue band (red/orange/amber/yellow-green/green/teal/cyan/
    blue/violet/purple/magenta/neutral). The 60-degree hue-gap constraint is dropped (the point
    is same-family variation, not hue spread); instead the three primaries must pairwise differ
    in lightness by >=15% so the three options are visibly distinct light/mid/dark takes on the
    same hue. Falls back to the whole library filtered to that hue band when the BM25 pool is
    too small.
"""

import argparse
import colorsys
import csv
import io
import json
import re
import sys
import time
import random
from collections import defaultdict
from math import log
from pathlib import Path

DATA_CSV = Path(__file__).resolve().parent.parent / "data" / "colors.csv"

SEARCH_COLS = ["Product Type", "Keywords"]

# Hue bands for --hue-lock, in degrees on the HSL wheel. Kept in sync with _hue_name()'s
# 12-segment split so the lock names line up with the Chinese hue labels in hue_desc.
# "red" wraps around 0, hence two ranges.
HUE_BANDS = {
    "red": [(345, 361), (0, 15)],
    "orange": [(15, 40)],
    "amber": [(40, 65)],
    "yellow-green": [(65, 90)],
    "green": [(90, 150)],
    "teal": [(150, 185)],
    "cyan": [(185, 210)],
    "blue": [(210, 250)],
    "violet": [(250, 275)],
    "purple": [(275, 320)],
    "magenta": [(320, 345)],
}
HUE_LOCK_CHOICES = sorted(HUE_BANDS) + ["neutral"]
# Fuzzy margin so a primary sitting right on a band edge is not wrongly excluded.
HUE_FUZZ = 15
# A neutral primary (chroma below this) has no meaningful hue, so it is excluded from chromatic
# locks and is the sole member of the "neutral" lock.
NEUTRAL_CHROMA = 25


if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


# ---------------------------- hue-lock filtering

def _in_hue_band(hex_color, band_name):
    """Check if a hex color's primary hue falls within the named band (with fuzz)."""
    hsl = hex_to_hsl(hex_color)
    if hsl is None:
        return False
    h, s, l = hsl
    if band_name == "neutral":
        return s < NEUTRAL_CHROMA
    if s < NEUTRAL_CHROMA:
        return False  # neutral primaries are excluded from chromatic locks
    ranges = HUE_BANDS.get(band_name, [])
    for lo, hi in ranges:
        fuzz_lo = (lo - HUE_FUZZ) % 360
        fuzz_hi = (hi + HUE_FUZZ) % 360
        if fuzz_lo < fuzz_hi:
            if fuzz_lo <= h < fuzz_hi:
                return True
        else:  # wraps around 0
            if h >= fuzz_lo or h < fuzz_hi:
                return True
    return False


# ---------------------------- tokenization + BM25 (kept in sync with search_fonts.py)
_STEM_SUFFIXES = [
    ("ational", 3), ("ation", 3), ("ional", 3), ("tion", 4), ("sion", 4),
    ("ment", 4), ("ness", 5), ("ful", 3), ("ing", 3), ("ous", 4),
    ("ive", 4), ("ity", 4), ("al", 4), ("ly", 4), ("er", 4),
    ("ed", 4), ("es", 4), ("s", 3),
]


def _stem(word):
    """Strip a common English suffix when the remaining stem stays long enough."""
    if len(word) <= 3:
        return word
    for suffix, min_stem in _STEM_SUFFIXES:
        if not word.endswith(suffix):
            continue
        stem = word[: -len(suffix)]
        if len(stem) < min_stem:
            continue
        if suffix in ("s", "es") and word[-len(suffix) - 1] == "s":
            continue
        return stem
    return word


def _tokenize(text):
    """English stemming as main path; colors.csv is an English library, Chinese query tokens are
    stripped (falls back to whole-library sampling when hits are insufficient)."""
    text = re.sub(r"[^\w\s-]", " ", str(text).lower())
    tokens = []
    # Allow hyphens (electric-vehicle as one token hits Keywords); split hyphenated phrases
    # and store both forms (improves recall)
    for seg in re.findall(r"[a-z0-9][a-z0-9-]*", text):
        if "-" in seg:
            tokens.append(seg)
            for part in seg.split("-"):
                if len(part) > 2:
                    tokens.append(_stem(part))
        elif len(seg) > 2:
            tokens.append(_stem(seg))
    return tokens


class BM25:
    """Minimal BM25 ranker over pre-tokenized documents (standard library only)."""

    def __init__(self, k1=1.5, b=0.75):
        """Store the BM25 hyper-parameters and initialize empty index state."""
        self.k1, self.b = k1, b
        self.corpus, self.doc_lengths = [], []
        self.avgdl, self.N = 0, 0
        self.idf = {}

    def fit(self, documents):
        """Tokenize and index the documents, computing per-term IDF."""
        self.corpus = [_tokenize(d) for d in documents]
        self.N = len(self.corpus)
        if not self.N:
            return
        self.doc_lengths = [len(d) for d in self.corpus]
        self.avgdl = sum(self.doc_lengths) / self.N
        dfreq = defaultdict(int)
        for doc in self.corpus:
            for word in set(doc):
                dfreq[word] += 1
        self.idf = {
            w: log((self.N - f + 0.5) / (f + 0.5) + 1) for w, f in dfreq.items()
        }

    def score(self, query):
        """Score every indexed document against the query; returns [(index, score)] descending."""
        qtokens = _tokenize(query)
        scores = []
        for idx, doc in enumerate(self.corpus):
            tf = defaultdict(int)
            for w in doc:
                tf[w] += 1
            s = 0.0
            for t in qtokens:
                if t not in self.idf:
                    continue
                num = tf[t] * (self.k1 + 1)
                den = tf[t] + self.k1 * (
                    1 - self.b + self.b * self.doc_lengths[idx] / self.avgdl
                )
                s += self.idf[t] * num / den
            scores.append((idx, s))
        return sorted(scores, key=lambda x: x[1], reverse=True)


# ---------------------------- color utilities
def hex_to_hsl(hx):
    """#RRGGBB -> (H deg 0-360, S% 0-100, L% 0-100). Returns None if parsing fails."""
    hx = (hx or "").lstrip("#").strip()
    if len(hx) != 6:
        return None
    try:
        r, g, b = [int(hx[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    except ValueError:
        return None
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return (h * 360, s * 100, l * 100)


def hue_gap(h1, h2):
    """Shortest angular distance between two hues in degrees (0-180)."""
    d = abs(h1 - h2) % 360
    return min(d, 360 - d)


def band(L):
    """Lightness band: deep <=20 / light >=85 / mid in between."""
    if L is None:
        return "unknown"
    if L <= 20:
        return "deep"
    if L >= 85:
        return "light"
    return "mid"


# ---------------------------- hue fact annotation (helps the model judge the color family; not
# used directly as the questionnaire title)
# Describes "how the color family reads" rather than borrowing from the source -- the source
# product is often unrelated to the target, and the source is already exposed via source_notes.
def _hue_name(h, s):
    """primary's HSL -> Chinese hue name. s<25% counts as neutral."""
    if s < 25:
        return "灰调"
    # 12-segment hue wheel -> Chinese color names (covers colors.csv's actual distribution)
    ranges = [
        (0, 15, "正红"), (15, 40, "橙"), (40, 65, "琥珀"),
        (65, 90, "黄绿"), (90, 150, "翠绿"), (150, 185, "青绿"),
        (185, 210, "青"), (210, 250, "靛蓝"), (250, 275, "蓝紫"),
        (275, 320, "品紫"), (320, 345, "品红"), (345, 361, "正红"),
    ]
    for lo, hi, name in ranges:
        if lo <= h < hi:
            return name
    return "彩色"


def describe_hue(row, bg_band):
    """Factual annotation of hue + background lightness, e.g. "青绿 深底"."""
    band_zh = {"deep": "深底", "light": "浅底", "mid": "中调"}[bg_band]
    p_hsl = hex_to_hsl(row.get("Primary"))
    hue = _hue_name(p_hsl[0], p_hsl[1]) if p_hsl else "彩色"
    return f"{hue} {band_zh}"


# ---------------------------- sampling constraints
def diverse_sample(candidates, seed, k=3, min_hue_gap=60, min_lightness_gap=0):
    """
    Greedily sample k rows from candidates, satisfying the hard constraints:
      - primary hues pairwise >= min_hue_gap (0 disables, used under --hue-lock)
      - primary lightness pairwise >= min_lightness_gap (0 disables; >0 under --hue-lock so
        the same-hue options read as distinct light/mid/dark takes)
      - at least 1 light background + 1 dark background
      - distinct Product Types
    Candidate order: the caller guarantees relevance sorting (top-K); this function shuffles
    then samples greedily, and the same seed reproduces the same result.
    """
    rng = random.Random(seed)
    pool = list(candidates)
    rng.shuffle(pool)

    picked = []

    def compatible(row, chosen):
        p_hsl = hex_to_hsl(row.get("Primary"))
        bg_hsl = hex_to_hsl(row.get("Background"))
        if not p_hsl or not bg_hsl:
            return False
        # Hue spread: neutral primaries (chroma<25%) are exempt (grays skip the hue check)
        if min_hue_gap > 0 and p_hsl[1] >= 25:
            for c in chosen:
                c_hsl = hex_to_hsl(c.get("Primary"))
                if c_hsl and c_hsl[1] >= 25 and hue_gap(p_hsl[0], c_hsl[0]) < min_hue_gap:
                    return False
        # Lightness spread (used under --hue-lock to keep same-hue options visibly distinct)
        if min_lightness_gap > 0:
            for c in chosen:
                c_hsl = hex_to_hsl(c.get("Primary"))
                if c_hsl and abs(p_hsl[2] - c_hsl[2]) < min_lightness_gap:
                    return False
        # Product Type must not repeat
        pt = (row.get("Product Type") or "").strip()
        for c in chosen:
            if pt and pt == (c.get("Product Type") or "").strip():
                return False
        return True

    # Phase 1: greedy pick to satisfy the hard constraints
    for row in pool:
        if len(picked) >= k:
            break
        if compatible(row, picked):
            picked.append(row)

    if len(picked) < k:
        return None, "candidate pool too small to satisfy the hue + Product Type diversity constraints"

    # Phase 2: lightness-spread check -- need at least 1 light + 1 dark
    bands = [band(hex_to_hsl(r.get("Background"))[2]) for r in picked]
    if "light" not in bands or "deep" not in bands:
        # Attempt a swap: find a row not yet picked whose band fills the missing lightness
        need = "deep" if "deep" not in bands else "light"
        for repl in pool:
            if repl in picked:
                continue
            r_hsl = hex_to_hsl(repl.get("Background"))
            if not r_hsl or band(r_hsl[2]) != need:
                continue
            # Try replacing one of the redundant bands in picked (deep-redundant or light-redundant)
            for i, cur_band in enumerate(bands):
                dup_band = "deep" if bands.count("deep") > 1 else ("light" if bands.count("light") > 1 else "mid")
                if cur_band != dup_band:
                    continue
                trial = picked[:i] + picked[i + 1:] + [repl]
                # Verify the trial still satisfies hue + lightness + Product Type constraints
                ok = True
                for a in range(len(trial)):
                    for b in range(a + 1, len(trial)):
                        h1 = hex_to_hsl(trial[a].get("Primary"))
                        h2 = hex_to_hsl(trial[b].get("Primary"))
                        if h1 and h2:
                            if (min_hue_gap > 0 and h1[1] >= 25 and h2[1] >= 25
                                    and hue_gap(h1[0], h2[0]) < min_hue_gap):
                                ok = False
                                break
                            if min_lightness_gap > 0 and abs(h1[2] - h2[2]) < min_lightness_gap:
                                ok = False
                                break
                    if not ok:
                        break
                pts = [(t.get("Product Type") or "").strip() for t in trial]
                if len(set(pts)) < len(pts):
                    ok = False
                if ok:
                    picked = trial
                    bands = [band(hex_to_hsl(r.get("Background"))[2]) for r in picked]
                    break
            if "light" in bands and "deep" in bands:
                break

    if "light" not in bands or "deep" not in bands:
        return None, f"candidate pool lightness bands incomplete: picked bands={bands}, need 1 light + 1 deep"

    # Reorder by bg lightness: dark -> mid -> light (three drafts read visually from dim to bright)
    picked.sort(key=lambda r: hex_to_hsl(r.get("Background"))[2])
    return picked, None


# ---------------------------- main flow
def to_palette(row):
    """Turn a csv row into the palette structure the model consumes."""
    return {
        "primary": row.get("Primary", ""),
        "on_primary": row.get("On Primary", ""),
        "secondary": row.get("Secondary", ""),
        "accent": row.get("Accent", ""),
        "on_accent": row.get("On Accent", ""),
        "background": row.get("Background", ""),
        "foreground": row.get("Foreground", ""),
        "card": row.get("Card", ""),
        "muted": row.get("Muted", ""),
        "muted_foreground": row.get("Muted Foreground", ""),
        "border": row.get("Border", ""),
        "destructive": row.get("Destructive", ""),
        "ring": row.get("Ring", ""),
        "source_product_type": row.get("Product Type", ""),
        "source_no": row.get("No", ""),
    }


def main():
    """CLI entry: retrieve, sample and print 3 palettes as JSON."""
    parser = argparse.ArgumentParser(
        description=(
            "Palette recommendation (cuts the direct PRD→archetype mapping; "
            "sampling constraints keep diversity)"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("query", nargs="?", default="",
                        help="3-6 English domain-entity keywords (automotive electric-vehicle showroom, etc.)")
    parser.add_argument("--seed", type=int, default=None,
                        help="random seed; defaults to time_ns, so repeated runs on the same PRD differ")
    parser.add_argument("--k", type=int, default=30,
                        help="BM25 top-K pool size, default 30")
    parser.add_argument("--n", type=int, default=3,
                        help="number of palettes to output, default 3")
    parser.add_argument("--min-hue-gap", type=int, default=60,
                        help="minimum pairwise hue distance, default 60°")
    parser.add_argument("--hue-lock", default=None, choices=HUE_LOCK_CHOICES,
                        help="Lock all primaries to this hue band (only when user explicitly specified)")
    args = parser.parse_args()

    if not args.query.strip():
        parser.print_help()
        return 2

    # Load colors.csv
    if not DATA_CSV.exists():
        print(json.dumps({"ok": False, "error": f"file_not_found: {DATA_CSV}"}), file=sys.stderr)
        return 1
    with open(DATA_CSV, "r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    # BM25 retrieval, top-K
    docs = [" ".join(str(r.get(c, "")) for c in SEARCH_COLS) for r in rows]
    bm25 = BM25()
    bm25.fit(docs)
    ranked = bm25.score(args.query)

    top_scored = [rows[i] for i, s in ranked[:args.k] if s > 0]
    fallback_used = False
    if len(top_scored) < args.n:
        fallback_used = True
        top_pool = rows
    else:
        top_pool = top_scored

    # --hue-lock: filter pool to only rows whose Primary falls in the requested hue band
    hue_locked = bool(args.hue_lock)
    if hue_locked:
        top_pool = [r for r in top_pool if _in_hue_band(r.get("Primary", ""), args.hue_lock)]
        # If filtered pool too small, expand to whole library filtered by hue
        if len(top_pool) < args.n:
            fallback_used = True
            top_pool = [r for r in rows if _in_hue_band(r.get("Primary", ""), args.hue_lock)]

    # Sampling constraints
    seed = args.seed if args.seed is not None else (time.time_ns() % (2 ** 31))
    if hue_locked:
        # Same-hue mode: drop hue-gap, require lightness spread instead
        picked, err = diverse_sample(top_pool, seed, k=args.n, min_hue_gap=0,
                                     min_lightness_gap=15)
        # Relax lightness gap if still failing
        if picked is None:
            picked, err = diverse_sample(top_pool, seed, k=args.n, min_hue_gap=0,
                                         min_lightness_gap=10)
    else:
        picked, err = diverse_sample(top_pool, seed, k=args.n, min_hue_gap=args.min_hue_gap)

    # Fallback: if the top-K pool cannot yield a constraint-satisfying pick, widen to the whole
    # library and try once more
    if picked is None and not fallback_used:
        fallback_used = True
        if hue_locked:
            wider = [r for r in rows if _in_hue_band(r.get("Primary", ""), args.hue_lock)]
            picked, err = diverse_sample(wider, seed, k=args.n, min_hue_gap=0,
                                         min_lightness_gap=10)
        else:
            picked, err = diverse_sample(rows, seed, k=args.n, min_hue_gap=args.min_hue_gap)

    if picked is None:
        print(json.dumps({
            "ok": False,
            "error": "sampling_failed",
            "reason": err,
            "seed": seed,
        }, ensure_ascii=False, indent=2))
        return 1

    # Output
    out_palettes = []
    for row in picked:
        bg_hsl = hex_to_hsl(row.get("Background"))
        bg_band = band(bg_hsl[2]) if bg_hsl else "mid"
        p = to_palette(row)
        p["hue_desc"] = describe_hue(row, bg_band)
        p["bg_band"] = bg_band
        out_palettes.append(p)

    print(json.dumps({
        "ok": True,
        "query": args.query,
        "seed": seed,
        "hue_lock": args.hue_lock,
        "top_k_pool": len(top_pool),
        "bm25_fallback": fallback_used,
        "palettes": out_palettes,
        "usage_hint": (
            "Authoritative color source (seeds never drive palette). Hue H is locked; "
            "chroma ±10% / lightness ±15% fine-tuning only. hue_desc is a hue-fact reference."
        ),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
