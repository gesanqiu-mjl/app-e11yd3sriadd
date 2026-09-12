#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Visual Design Director Core — BM25 search engine for design system generation.
4 domains: style, color, font, product.
"""

import csv
import glob
import json
import os
import re
import sys
from pathlib import Path
from math import log
from collections import defaultdict

DATA_DIR = Path(__file__).parent.parent / "data"
MAX_RESULTS = 3

CSV_CONFIG = {
    "style": {
        "file": "styles.csv",
        "search_cols": [
            "Style Category", "Keywords", "Best For",
            "Type", "Design_DNA"
        ],
        "output_cols": [
            "Style Category", "Type",
            "Effects & Animation",
            "Signature_Elements",
        ]
    },
    "color": {
        "file": "colors.csv",
        "search_cols": [
            "Product Type", "Keywords", "Notes"
        ],
        "output_cols": [
            "Product Type", "Primary", "On Primary",
            "Secondary",
            "Accent", "On Accent",
            "Background", "Foreground",
            "Muted", "Border",
        ]
    },
    "font": {
        "file": "fonts.csv",
        "search_cols": [
            "Font_Name_CN", "Font_Name_EN",
            "Category", "Mood_Keywords",
            "Best_For", "Best_For_CN"
        ],
        "output_cols": [
            "Font_Name_CN", "Font_Name_EN",
            "Font_Family", "Category",
            "Mood_Keywords", "Best_For", "Best_For_CN",
            "Weights", "CDN_URL",
            "CDN_URL_Template", "Usage",
            "平台", "language"
        ]
    },
    "product": {
        "file": "products.csv",
        "search_cols": [
            "Product Type", "Keywords",
            "Primary Style Recommendation"
        ],
        "output_cols": [
            "Product Type", "Keywords",
            "Primary Style Recommendation",
            "Secondary Styles",
            "Color Palette Focus",
            "Key Considerations"
        ]
    },
    "scenario": {
        "file": "scenarios.csv",
        "search_cols": ["Scenario", "Keywords"],
        "output_cols": [
            "Scenario", "Layout_Rules", "Notes",
            "Motion_Baseline", "Animation_Constraint",
        ],
    },
}


_STEM_SUFFIXES = [
    ('ational', 3), ('ation', 3),
    ('ional', 3), ('tion', 4), ('sion', 4),
    ('ment', 4), ('ness', 5),
    ('ful', 3), ('ing', 3),
    ('ous', 4), ('ive', 4), ('ity', 4),
    ('al', 4), ('ly', 4),
    ('er', 4), ('ed', 4), ('es', 4),
    ('s', 3),
]


def _stem(word):
    """Strip a common English suffix when the remaining stem stays long enough."""
    if len(word) <= 3:
        return word
    for suffix, min_stem in _STEM_SUFFIXES:
        if not word.endswith(suffix):
            continue
        stem = word[:-len(suffix)]
        if len(stem) < min_stem:
            continue
        if suffix in ('s', 'es') and word[-len(suffix) - 1] == 's':
            continue
        return stem
    return word


class BM25:
    """BM25 ranking algorithm for text search."""

    def __init__(self, k1=1.5, b=0.75):
        """Store the BM25 hyper-parameters and initialize empty index state."""
        self.k1 = k1
        self.b = b
        self.corpus = []
        self.doc_lengths = []
        self.avgdl = 0
        self.idf = {}
        self.doc_freqs = defaultdict(int)
        self.N = 0

    def tokenize(self, text):
        """Library-free tokenizer: CJK char bigrams + stemmed Latin.

        Chinese has no spaces, so split() would turn a whole phrase into one
        token and break BM25 partial matching. Character bigrams give good
        CJK recall with no dictionary/library (jieba is absent in the sandbox)
        and are far faster than jieba (no dict load). Latin words keep the
        existing stem behaviour; English search is unaffected.
        """
        text = re.sub(r'[^\w\s]', ' ', str(text).lower())
        tokens = []
        # split into CJK runs (一-鿿 = U+4E00–U+9FFF) and latin/digit runs
        for seg in re.findall(r'[一-鿿]+|[a-z0-9]+', text):
            if '一' <= seg[0] <= '鿿':
                if len(seg) == 1:
                    tokens.append(seg)
                else:
                    tokens.extend(
                        seg[i:i + 2] for i in range(len(seg) - 1)
                    )
            elif len(seg) > 2:
                tokens.append(_stem(seg))
        return tokens

    def fit(self, documents):
        """Preprocess the documents to compute IDF and average document length."""
        self.corpus = [self.tokenize(doc) for doc in documents]
        self.N = len(self.corpus)
        if self.N == 0:
            return
        self.doc_lengths = [len(doc) for doc in self.corpus]
        self.avgdl = sum(self.doc_lengths) / self.N

        for doc in self.corpus:
            seen = set()
            for word in doc:
                if word not in seen:
                    self.doc_freqs[word] += 1
                    seen.add(word)

        for word, freq in self.doc_freqs.items():
            self.idf[word] = log(
                (self.N - freq + 0.5) / (freq + 0.5) + 1
            )

    def score(self, query):
        """Compute BM25 scores for the query against all documents."""
        query_tokens = self.tokenize(query)
        scores = []

        for idx, doc in enumerate(self.corpus):
            s = 0
            doc_len = self.doc_lengths[idx]
            term_freqs = defaultdict(int)
            for word in doc:
                term_freqs[word] += 1

            for token in query_tokens:
                if token in self.idf:
                    tf = term_freqs[token]
                    idf_val = self.idf[token]
                    num = tf * (self.k1 + 1)
                    den = tf + self.k1 * (
                        1 - self.b + self.b * doc_len / self.avgdl
                    )
                    s += idf_val * num / den

            scores.append((idx, s))

        return sorted(scores, key=lambda x: x[1], reverse=True)


def _load_csv(filepath):
    """Load a data table from a real CSV or an xlsx-saved-as-.csv file.

    Excel sometimes saves the workbook in xlsx format while keeping the .csv
    name (zip magic 'PK'). Detect that and read via openpyxl so the pipeline
    never silently breaks on a re-exported data file.
    """
    with open(filepath, 'rb') as fb:
        head = fb.read(2)
    if head == b'PK':
        import io
        import openpyxl
        with open(filepath, 'rb') as fb:
            wb = openpyxl.load_workbook(
                io.BytesIO(fb.read()), read_only=True, data_only=True
            )
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []
        headers = [
            str(h).strip() if h is not None else "" for h in rows[0]
        ]
        out = []
        for r in rows[1:]:
            if all(c is None or str(c).strip() == "" for c in r):
                continue
            out.append({
                h: ("" if v is None else str(v))
                for h, v in zip(headers, r) if h
            })
        return out
    with open(filepath, 'r', encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def _search_csv(
    filepath, search_cols, output_cols, query,
    max_results, min_score=0
):
    """BM25-search a CSV file over search_cols and return up to max_results rows projected to output_cols."""
    if not filepath.exists():
        return []

    data = _load_csv(filepath)
    documents = [
        " ".join(str(row.get(col, "")) for col in search_cols)
        for row in data
    ]

    bm25 = BM25()
    bm25.fit(documents)
    ranked = bm25.score(query)

    results = []
    for idx, score in ranked[:max_results]:
        if score > min_score:
            row = data[idx]
            results.append({
                col: row.get(col, "")
                for col in output_cols if col in row
            })

    return results


FONT_MIN_SCORE = -999


def search(query, domain=None, max_results=MAX_RESULTS):
    """Search design candidates based on the query and domain."""
    if domain is None:
        domain = "style"

    config = CSV_CONFIG.get(domain, CSV_CONFIG["style"])
    filepath = DATA_DIR / config["file"]

    if not filepath.exists():
        return {
            "error": f"File not found: {filepath}",
            "domain": domain
        }

    min_score = FONT_MIN_SCORE if domain == "font" else 0
    results = _search_csv(
        filepath,
        config["search_cols"],
        config["output_cols"],
        query,
        max_results,
        min_score
    )

    return {
        "domain": domain,
        "query": query,
        "file": config["file"],
        "count": len(results),
        "results": results
    }


# ---------------------------------------------------------------------------
# Draft status vocabulary (manifest.json `drafts[].status`)
#
# Single source of truth for the two checker scripts. The engineering side owns
# this state machine (third_party/hooks/design/design_manifest.py); mirroring it
# in one place here means an engineering rename is a one-file change, not a hunt
# through every script. It has already been renamed once (valid/invalid ->
# ready/failed) and extended once (+ stopped).
#
#   generating  written, no verdict yet -- the model may still edit it in place
#   ready       passed check_design_quality.py; the only status that counts as done
#   failed      checked and still failing, or the file went missing
#   stopped     the round was aborted (user cancel / error) before the draft was
#               ever checked. Sealed by the platform: read-only, and no later
#               round-end sweep picks it up, so it never gets a verdict. Continuing
#               such a draft means new_draft.py --from <it>, never editing it.
# ---------------------------------------------------------------------------

STATUS_GENERATING = "generating"
STATUS_READY = "ready"
STATUS_FAILED = "failed"
STATUS_STOPPED = "stopped"

# Read-side compat with manifests written before the engineering rename
STATUS_LEGACY_ALIASES = {"valid": STATUS_READY, "invalid": STATUS_FAILED}


STATUS_TERMINAL = (STATUS_READY, STATUS_FAILED, STATUS_STOPPED)


def normalize_status(status):
    """Canonical status string for a raw manifest value ('' when absent/unknown type).

    Case-folded on purpose: every consumer here is a guard rail, and a manifest that says
    `Ready` or `STOPPED` means the same thing to a human reader. Without folding, a casing
    drift on the platform side reads as an unknown status, which is the one input class
    where the guard rails behave differently from the intended value.
    """
    if not isinstance(status, str):
        return ""
    raw = status.strip().casefold()
    return STATUS_LEGACY_ALIASES.get(raw, raw)


def is_passed(status):
    """Whether this status means the draft passed the quality checker.

    A closed set: only `ready` counts as delivered. A new engineering status must never be
    silently treated as passing.
    """
    return normalize_status(status) == STATUS_READY


def is_stopped(status):
    return normalize_status(status) == STATUS_STOPPED


def is_sealed(status):
    """Whether the platform reached a verdict and the file is no longer editable.

    A closed set too, and this was originally written as an open set (anything but
    `generating`) -- an audit showed why that is wrong. The argument for the open set was
    that mistaking a non-terminal status for sealed merely "relaxes a guard rail". It does
    more than that: `--begin-round` excludes sealed drafts from its stray-draft ratchet AND
    folds them into the new baseline, so an unknown status would let a never-checked draft
    out of the ratchet permanently -- while `--check` still refuses it. That asymmetry makes
    "run --begin-round after --check blocked me" a working bypass, which is a plausible
    thing for the model to try.

    The cost of the closed set is that a future 5th terminal status deadlocks the same way
    `stopped` did. That is the better failure: it is loud, and it shows up as a blocked
    round rather than as a draft that quietly skipped validation.
    """
    return normalize_status(status) in STATUS_TERMINAL


# ---------------------------------------------------------------------------
# Round bookkeeping: manifest views + the one definition of "how many drafts
# has this round produced".
#
# This lives here because the count used to exist twice. check_draft_budget.py
# read the manifest and excluded `stopped` drafts; new_draft.py counted files on
# disk against the snapshot and never read the manifest at all. After a user
# cancel that divergence deadlocked the skill against itself: `--check` printed
# "continue such a draft with new_draft.py --from <it>" and new_draft.py then
# answered "3 already added, at most 0 more allowed" -- one script instructing an
# action the other refused. Observed in QA on app-e9tdhaaookxt: 13 refusals, then
# the model gave up on the scripts and started editing a write-protected draft.
#
# So: one function, three call sites (--begin-round, --check, new_draft.py). A
# rule about what counts toward a round can no longer be applied in one of them
# and forgotten in the others.
# ---------------------------------------------------------------------------

MANIFEST_FILENAME = "manifest.json"

STATE_FILENAME = "design-budget.json"


def html_set(design_dir):
    """Sorted basenames of every *.html file directly inside design_dir."""
    return sorted(os.path.basename(p) for p in glob.glob(os.path.join(design_dir, "*.html")))


def default_state_path(design_dir):
    """Round-state file path: a design-budget.json sibling of design_dir.

    Both scripts must derive the same path from the same design_dir, or one writes state to
    `tasks/design-budget.json` while the other looks for it in `tasks/design/` and they never
    see each other's rounds.
    """
    parent = os.path.dirname(os.path.abspath(design_dir.rstrip("/")))
    return os.path.join(parent, STATE_FILENAME)


def manifest_path(design_dir):
    """Path of the platform-written manifest.json inside design_dir."""
    return os.path.join(design_dir, MANIFEST_FILENAME)


def load_manifest(design_dir):
    """Read manifest.json; None if absent or structurally unusable.

    The manifest is written exclusively by the platform (the skill only reads it). Anything the
    readers below cannot walk -- unparsable JSON, a non-object document, a `drafts` field that is
    not a list -- is reported as unavailable rather than half-trusted. Returning None makes every
    caller fall back to "no status information", which is also the correct behaviour for
    standalone local runs where no manifest exists.

    The `drafts`-is-a-list check is not theoretical: without it `{"version": 1, "drafts": 5}` used
    to reach the view functions and raise TypeError, which took down new_draft.py -- a script that
    before it read the manifest at all was structurally immune to manifest damage.
    """
    path = manifest_path(design_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"WARN: manifest.json corrupted ({path}): {e}. Treating as unavailable.", file=sys.stderr)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("drafts"), list):
        print(f"WARN: manifest.json has no usable drafts list ({path}). Treating as unavailable.",
              file=sys.stderr)
        return None
    return data


def _draft_entries(manifest):
    """Draft entries of a manifest, tolerating any shape a caller may hand in.

    load_manifest already rejects a non-list `drafts`, but these views are also called with
    hand-built dicts (tests, and check_design_quality.py's own manifest reader), so the guard
    lives here too rather than relying on every caller having gone through the loader.
    """
    drafts = (manifest or {}).get("drafts")
    return drafts if isinstance(drafts, list) else []


def manifest_filenames_where(manifest, predicate):
    """Basenames of drafts whose status satisfies `predicate`."""
    out = set()
    for entry in _draft_entries(manifest):
        if not isinstance(entry, dict):
            continue
        if not predicate(entry.get("status")):
            continue
        path = str(entry.get("path") or "")
        if path:
            out.add(path.rsplit("/", 1)[-1])
    return out


def manifest_all_filenames(manifest):
    """Basenames of every draft the manifest knows about, whatever its status."""
    return manifest_filenames_where(manifest, lambda _status: True)


def manifest_valid_filenames(manifest):
    """Basenames of drafts whose status is ready (or the legacy valid)."""
    return manifest_filenames_where(manifest, is_passed)


def manifest_sealed_filenames(manifest):
    """Basenames of sealed drafts -- the platform already reached a verdict on them.

    Sealed is the closed set ready / failed / stopped (plus legacy valid / invalid): the draft
    can no longer be edited in place, so it has nothing left for --check to do and must not keep
    a new round from opening. `generating` -- and any status this skill does not recognise -- is
    still treated as actionable and keeps blocking, because letting an unknown status through
    here would also fold it into the new baseline and let a never-validated draft escape the
    ratchet for good.
    """
    return manifest_filenames_where(manifest, is_sealed)


def manifest_stopped_filenames(manifest):
    """Basenames of drafts the platform sealed as `stopped` (round aborted before any check).

    Such a draft was never checked and cannot be edited (the platform write-protects sealed
    drafts), so it is neither a deliverable nor a fixable one: it must not consume the round's
    quota and must not block --check. Continuing it means new_draft.py --from <it>.
    """
    return manifest_filenames_where(manifest, is_stopped)


def manifest_unchecked_filenames(manifest):
    """Basenames of drafts that are generating and were never handed to the checker.

    check_design_quality.py flips `check_failed` to true the first time it rejects a generating
    draft, so `generating` + `check_failed` false means "never checked" while `generating` + true
    means "checked, errors still unfixed". Re-running the checker without editing the file cannot
    change the latter, so the two need different advice.
    """
    out = set()
    for entry in _draft_entries(manifest):
        if not isinstance(entry, dict):
            continue
        if normalize_status(entry.get("status")) != STATUS_GENERATING:
            continue
        if entry.get("check_failed"):
            continue
        path = str(entry.get("path") or "")
        if path:
            out.add(path.rsplit("/", 1)[-1])
    return out


BEGIN_ROUND_COMMAND = "python3 check_draft_budget.py tasks/design --begin-round"


def continue_draft_command(filename):
    """Runnable command that carries work out of a sealed draft into a fresh copy.

    Three scripts print this instruction. It used to be prose -- `new_draft.py --from <it>` --
    which is not runnable: `--route` is required, so a model copying the line verbatim gets an
    argparse error and then improvises. Same failure family as the round count living in two
    places: an instruction that cannot be executed is worse than no instruction.
    """
    stem = filename[:-5] if filename.endswith(".html") else filename
    route = stem.rsplit("-", 1)[0] if "-" in stem else stem
    return f"python3 new_draft.py --route {route} --from {stem}"


def sealed_draft_advice(status, filename, need_begin_round=True):
    """What to tell the model about a draft the platform sealed: never "edit it".

    The one thing this must never say is "fix it in place". A sealed draft is write-protected, so
    that advice is unexecutable -- and it is exactly what the traces show the model looping on
    (71 rejected edits in one QA session) before it starts improvising around the guard rails.
    """
    lines = [f"`{filename}` is sealed (status={status}): read-only, and deleting or renaming it is "
             f"refused too. Carry the fix into a fresh copy instead:"]
    if need_begin_round:
        lines.append(f"  {BEGIN_ROUND_COMMAND}")
    lines.append(f"  {continue_draft_command(filename)}")
    lines.append("then edit the copy and re-run this script on it.")
    return "\n".join(lines)


def split_round_drafts(current, snapshot=(), stopped=frozenset()):
    """Split the drafts a round produced into (counted, skipped_stopped).

    `current` is this round's file list, `snapshot` the baseline --begin-round recorded, and
    `stopped` the manifest's stopped set. Order follows `current` so callers can print the names
    in a stable order.

    Pass an empty snapshot to ask the other question the budget policy needs: "of the first
    round's three promised proposals, how many already exist" -- that one counts everything on
    disk, because a first round reopened after an abort keeps a single quota of 3 across reopens.

    The only reason `stopped` is subtracted at all: the file exists but the user can never
    receive it and the model can never repair it, so charging the round for it silently shrinks
    the three promised proposals.
    """
    added = [f for f in current if f not in snapshot]
    counted = [f for f in added if f not in stopped]
    skipped = [f for f in added if f in stopped]
    return counted, skipped


# ---------------------------------------------------------------------------
# WCAG contrast on bare HSL triplets ("H S% L%" -- the token form both the draft's
# DESIGN-TOKENS block and DESIGN.md front matter use).
#
# Canonical implementation for the whole skill: the draft-time gate
# (check_design_quality.py) and the conversion-time gate (check_design_md.py) must
# agree to the decimal, otherwise a draft passes P2 and only fails at P4 -- where the
# draft is already sealed and the fix costs an extra draft file.
# ---------------------------------------------------------------------------

# Same acceptance set as apply_design_tokens.HSL_TRIPLET, on purpose: that module decides
# which token values are colors at conversion time, and a value this module reads as a color
# while that one does not (or vice versa) is exactly how the P2 and P4 verdicts drift apart.
# It also means the float() calls below cannot fail -- the pattern admits no malformed number.
HSL_TRIPLET_RE = re.compile(
    r"^\s*([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)%\s+([0-9]+(?:\.[0-9]+)?)%\s*$"
)

# The extremes a paired *-foreground may be flipped to, in preference order. White and
# near-black are the two design-sane choices and are compared on contrast alone. Pure black is
# a fallback for the backgrounds where NEITHER of them reaches 4.5:1.
#
# Measured, not reasoned (h step 3, s step 5, l step 0.1%): max(white, near-black) drops below
# 4.5 on a wide band -- lightness 24.1%-69.4% once saturation is in play, worst case 4.447:1 at
# `174 20% 41.6%`. It is NOT the narrow mid-grey sliver an earlier version of this comment
# claimed, and the "both curves cross at L~=0.179 with 4.58:1" line inherited from
# check_design_md.py was about pure black, not near-black. With pure black in the list the
# worst case over the same scan is 4.583:1 (`135 10% 43.8%`), so every parsable background has
# a mechanical repair. That is what lets the checker offer `--fix` unconditionally.
FOREGROUND_EXTREMES = (("white (0 0% 100%)", "0 0% 100%"), ("near-black (0 0% 4%)", "0 0% 4%"))
FOREGROUND_FALLBACK = ("black (0 0% 0%)", "0 0% 0%")
AA_TEXT = 4.5


def hsl_to_rgb(triplet):
    """Bare 'H S% L%' triplet -> (r, g, b) floats in 0-1, or None if it doesn't parse."""
    m = HSL_TRIPLET_RE.match(triplet or "")
    if not m:
        return None
    h, s, l = float(m.group(1)) / 360.0, float(m.group(2)) / 100.0, float(m.group(3)) / 100.0
    import colorsys
    return colorsys.hls_to_rgb(h, l, s)


def contrast_ratio(t1, t2):
    """WCAG contrast ratio between two HSL triplets, or None if either fails to parse."""
    def lum(rgb):
        def chan(c):
            return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        r, g, b = (chan(c) for c in rgb)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    c1, c2 = hsl_to_rgb(t1), hsl_to_rgb(t2)
    if c1 is None or c2 is None:
        return None
    l1, l2 = sorted((lum(c1), lum(c2)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


def _extreme_candidates(bg):
    """[(label, triplet, ratio)] for every extreme that parses against `bg`, best ratio first."""
    out = []
    for label, triplet in FOREGROUND_EXTREMES + (FOREGROUND_FALLBACK,):
        ratio = contrast_ratio(triplet, bg)
        if ratio is not None:
            out.append((label, triplet, ratio))
    return sorted(out, key=lambda c: c[2], reverse=True)


def _pick_extreme(bg):
    """(label, triplet, ratio) for the extreme to flip a paired *-foreground to, or None.

    White and near-black are preferred (they are the design-sane pair); pure black is only
    reached when neither of them clears AA, i.e. inside the grey dead band.
    """
    candidates = _extreme_candidates(bg)
    if not candidates:
        return None
    preferred = [c for c in candidates if c[1] != FOREGROUND_FALLBACK[1]]
    if preferred and preferred[0][2] >= AA_TEXT:
        return preferred[0]
    return candidates[0]


def best_extreme_foreground(bg):
    """Return (label, ratio) for the extreme a failing pair's *-foreground should flip to.

    Reported alongside a failing pair because the fix is essentially never "abandon the brand
    color": the brand hue is locked in `primary` / `background` while the paired `*-foreground`
    is a free variable. Traces show the model instead hand-editing tokens in src/index.css
    (which the conversion contract forbids) or darkening the locked brand color itself.
    """
    pick = _pick_extreme(bg)
    return (pick[0], pick[2]) if pick else None


def best_extreme_triplet(bg):
    """The bare triplet to flip to, but only when it actually clears AA; else None.

    Returning None is the signal that no mechanical repair exists for this pair, so the caller
    must not rewrite the token and pretend the defect is gone.
    """
    pick = _pick_extreme(bg)
    return pick[1] if pick and pick[2] >= AA_TEXT else None

