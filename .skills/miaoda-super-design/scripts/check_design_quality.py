#!/usr/bin/env python3
"""miaoda-super-design: deterministic design-draft quality check (format checker, pure stdlib).

Usage:
    python3 check_design_quality.py design/home-1.html [design/home-2.html ...]
    python3 check_design_quality.py --list-rules      # the complete enforced rule set
    python3 check_design_quality.py --fix design/home-1.html   # mechanical repairs, then check

Purpose: **only check deterministically judgeable format / contract / slop / readability hard floors**,
no aesthetic verdicts (taste questions like layout tension, font-size ratio, image density are left to
the references docs + differentiation engine to guide — no numeric thresholds forcing the model one way).

- Single file: runs all single-draft rules. Multiple files: additionally verifies structure / sig are
  pairwise distinct (first-round three-draft anti-reskinning).
- Violating any error rule or the multi-draft diversity gate → exit 1; the top-level `blocking` array lists
  the blocking reasons up front.
- Inline waiver (waivable rules only, for brand exceptions):
    <!-- miaoda-design-disable <rule-name>: <reason> -->
  Which rules are waivable is answered by `--list-rules`, not by a prose list here: the prose version
  drifted to covering 13 of the 22 non-waivable rules, and a draft author who cannot see the real set
  ends up inferring it from whichever sibling draft happened to pass.
- `--fix` exists because some violations come in dozens of identical occurrences, and the draft-editing
  red line allows only `str_replace_editor`. Without a legal bulk path, traces show the model talking
  itself into a banned `sed -i` / heredoc rewrite (which wipes concurrent edits). Only rules whose
  compliant output is uniquely determined are auto-fixable -- see MECHANICAL_FIXES.

stamp format (sig field required):
    <!-- miaoda-super-design | title: <style name ≤8 chars> | skeleton: <family> | sig: <unique signature> -->

Side effect: after printing the report, this script writes each verdict into
`manifest.json` in the drafts' own directory (`status` / `check_failed` only -- the
engineering side still owns designId, parent_ids, appType and the frontend signal).
Doing it in-process is deliberate: `check_draft_budget.py --check` reads the manifest,
so chaining the two in one shell command still sees this run's result.
Drafts the platform sealed as `stopped` (round aborted before they were ever checked) are
left untouched in both directions -- continuing one goes through `new_draft.py --from`.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

# Shared vocabulary and colour maths live in core.py: the draft-time gate and the
# conversion-time gate (check_design_md.py) must agree to the decimal, otherwise a draft
# passes P2 and only fails at P4 -- where it is already sealed. sys.path is amended so the
# import also works when this module is imported by tests rather than run as a script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (  # noqa: E402
    AA_TEXT,
    MANIFEST_FILENAME,
    STATUS_GENERATING,
    STATUS_READY,
    best_extreme_foreground,
    best_extreme_triplet,
    contrast_ratio,
    is_sealed,
    is_stopped,
    normalize_status,
    sealed_draft_advice,
)

CLASS_ATTR = re.compile(r'(?<![\w-])class=["\']([^"\']*)["\']')
DISABLE = re.compile(r"<!--\s*miaoda-design-disable\s+([a-z0-9-]+)\s*:\s*(.+?)\s*-->")
# The `|` (ASCII) separator is the current format; `·` (U+00B7) is the legacy format, still
# accepted on read so historical drafts do not break.
STAMP = re.compile(
    r"<!--\s*miaoda-super-design"
    r"\s*\|\s*title:\s*([^|]+?)"
    r"\s*\|\s*skeleton:\s*([^|]+?)"
    r"\s*\|\s*sig:\s*(.+?)\s*-->"
)

APP_ROOT_RE = re.compile(r"^app-[\w-]+$")


def _walk_up_for_app(start):
    """Walk up from `start` to the first `app-<id>` directory; None if there is none."""
    probe = os.path.abspath(start)
    while True:
        if APP_ROOT_RE.match(os.path.basename(probe)):
            return probe
        parent = os.path.dirname(probe)
        if parent == probe:
            return None
        probe = parent


def find_app_root():
    """Locate the current app root `app-<id>`: try CWD's ancestors, then this script's.

    CWD may be the app's parent (e.g. /workspace); the app-<id> dir would then be
    a child and unreachable by walking up. The script lives under
    <app-root>/.skills/miaoda-super-design/scripts/, so __file__'s ancestry always
    contains app-<id> — a more reliable anchor. Fall back to CWD for local debugging.
    """
    hit = _walk_up_for_app(os.getcwd())
    if hit:
        return hit
    hit = _walk_up_for_app(os.path.dirname(os.path.abspath(__file__)))
    if hit:
        return hit
    return os.path.abspath(os.getcwd())


def resolve_input_path(arg):
    """Keep absolute paths as-is; resolve relative paths against the app root."""
    if os.path.isabs(arg):
        return os.path.abspath(arg)
    return os.path.join(find_app_root(), arg)


def class_text(html):
    """Concatenate every class attribute value in the document into one string."""
    return " ".join(CLASS_ATTR.findall(html))


# ---------- checkers: each returns a list of problem descriptions ----------

def chk_tailwind_version(html):
    """Tailwind must be the v3 CDN build pinned to a fixed version."""
    out = []
    if "@tailwindcss/browser" in re.sub(r"<!--.*?-->", "", html, flags=re.S):
        out.append("Using Tailwind v4 @tailwindcss/browser (hard rule: v3 only)")
    m = re.search(r'(?<![\w-])src=["\']https://cdn\.tailwindcss\.com([^"\']*)["\']', html)
    if not m:
        out.append("Missing https://cdn.tailwindcss.com/3.4.16 script import")
    elif not re.match(r"^/3\.", m.group(1)):
        out.append(
            f"Tailwind CDN not pinned to a fixed v3 version"
            f" (current: '{m.group(1) or 'no version'}', should be /3.4.16)"
        )
    return out


def chk_local_refs(html):
    """Local images must use the full absolute path `/workspace/<app-id>/tasks/design/assets/<name>`;
    no sideloaded local css/js.

    Remote CDNs (https://...) are unrestricted -- motion libraries (Swiper / anime.js / lottie
    etc.) may be pulled from a version-pinned CDN. This rule only catches local path forms.

    The preview container resolves local files by full absolute path: neither the relative
    `assets/x.jpg` nor the site-root `/tasks/design/assets/x.jpg` carries app-locating
    information, so the image breaks.

    Strip <script> blocks before scanning (same treatment as chk_section_ids): the
    `` `<img src="${p.image}">` `` inside a list-rendering script is a template-literal
    interpolation evaluated at runtime into a real URL, not a local path reference in the HTML.
    Without stripping, it gets flagged as an illegal local reference -- and to silence the error
    the model rewrites the template literal into single-quote concatenation
    (`src="' + p.image + '"`), which, inside a backtick string, emits the concatenation
    operators literally into the HTML and guarantees a broken image. The false positive directly
    induces a real failure, so stripping is mandatory.
    """
    out = []
    html = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    full = re.compile(r"^/workspace/app-[\w-]+/tasks/design/assets/[\w.-]+$")
    site_root = re.compile(r"^/tasks/design/assets/([\w.-]+)$")
    relative = re.compile(r"^assets/([\w.-]+)$")
    for attr, url in re.findall(r'(?<![\w-])(src|href)=["\']([^"\']+)["\']', html):
        if url.startswith(("http://", "https://", "#", "data:", "mailto:", "tel:", "javascript:")):
            continue
        if attr == "src" and full.match(url):
            continue  # the only legal form for local assets
        m = site_root.match(url) or relative.match(url)
        if attr == "src" and m:
            out.append(
                f'Local reference src="{url}" is missing the `/workspace/<app-id>` prefix'
                f' (the image will break in preview) — change it to'
                f' src="/workspace/<current app-id>/tasks/design/assets/{m.group(1)}"'
            )
            continue
        out.append(
            f'Local reference {attr}="{url}" is illegal'
            ' (local images may only use src="/workspace/<app-id>/tasks/design/assets/<name>";'
            ' no sideloaded local css/js)'
        )
    return out


def chk_stamp(html):
    """The stamp comment must be present, parseable, and have title/sig both filled in."""
    m = STAMP.search(html)
    if not m:
        if "miaoda-super-design" in html:
            return [
                "stamp parse failed: a `|` character appears inside the title / skeleton field —"
                " `|` is the stamp's field separator and cannot appear inside a field value."
                " title should only contain a condensed style term (no brand name, no connectors)"
            ]
        return [
            "Missing stamp comment: <!-- miaoda-super-design | title: <title>"
            " | skeleton: <name> | sig: <draft-unique signature> -->"
        ]
    title = m.group(1).strip()
    sig = m.group(3).strip()
    out = []
    if not title or title.startswith("<"):
        out.append("stamp's title is not filled in: ≤8 chars condensing the design style,"
                    " the engineering scan registers the html based on this")
    else:
        # Count characters after removing spaces; connectors banned (models love pairing
        # "brand | style" which exceeds the limit)
        SEPARATORS = re.compile(r"[·\-—|/]")
        if SEPARATORS.search(title):
            out.append(
                f"stamp title '{title}' contains a connector (·—|/) — title should only contain"
                " a condensed style term, do not pair it with a brand name"
            )
        elif len(title.replace(" ", "")) > 8:
            out.append(f"stamp's title '{title}' exceeds 8 chars (condensed design style, ≤8 chars)")
    if not sig or sig.startswith("<"):
        out.append(
            "stamp's sig is not filled in: write a signature unique to this draft"
            " (an elevated craft detail grown from the PRD's business context, not in the template),"
            " and it must differ across drafts"
        )
    elif len(sig.replace(" ", "")) < 6:
        out.append(
            f"stamp's sig '{sig}' is too short (<6 chars): it must clearly convey what makes this draft's"
            " visual signature unique, not restate the style name"
        )
    return out


MARKER_PAIR_RE = re.compile(r"=====\s*([A-Z][A-Z0-9-]*):(BEGIN|END)\s*=====")


def chk_tokens_block(html):
    """DESIGN-TOKENS must exist, and every marker family present must stay exactly paired.

    The BEGIN/END comments are the anchors every downstream script parses blocks with
    (`apply_design_tokens.py` requires a matching pair, not just the BEGIN line). A large
    str_replace over a whole block easily rewrites or duplicates a marker line, which leaves
    the draft looking fine here while conversion later reports "missing DESIGN-TOKENS block" —
    by which point the draft is sealed. So pairing is verified at draft time.
    """
    out = []
    hits = [(m.group(1), m.group(2), m.start()) for m in MARKER_PAIR_RE.finditer(html)]
    families = list(dict.fromkeys(name for name, _kind, _pos in hits))
    if not any(name == "DESIGN-TOKENS" for name, _k, _p in hits):
        return ["Missing DESIGN-TOKENS block (derived from assets/base.html): copy the "
                "/* ===== DESIGN-TOKENS:BEGIN/END ===== */ pair from the template into the head "
                "<style> and put the :root token declarations between them"]
    for family in families:
        begins = [pos for name, kind, pos in hits if name == family and kind == "BEGIN"]
        ends = [pos for name, kind, pos in hits if name == family and kind == "END"]
        if len(begins) == 1 and len(ends) == 1 and begins[0] < ends[0]:
            continue
        if len(begins) != 1 or len(ends) != 1:
            out.append(
                f"{family} markers are unbalanced: {len(begins)} BEGIN / {len(ends)} END "
                "(exactly one of each is required). Restore the marker comment lines to the "
                "assets/base.html form — edit the block contents, never the marker lines")
        else:
            out.append(
                f"{family}:END appears before {family}:BEGIN — the block boundaries are crossed. "
                "Restore the marker order from assets/base.html")
    return out


def chk_html_integrity(html):
    """HTML structural integrity: deterministic interception of common truncation / leftover
    patterns from huge str_replace operations.

    When the model does a 12k+ character str_replace over a whole block, new_str can be cut off
    by the output limit, producing a draft with missing closing tags or a mutilated script body.
    Browsers raise no error on such drafts and the damage is hard to spot by eye.

    Checks:
      1. Missing key closers: at least one each of </body> / </html>
      2. <script> open and close counts must match
      3. The <body> opening tag must exist exactly once (missing or duplicated both invalid)
      4. No leftover content after </html> (see below)
      5. </head> / </body> must each appear exactly once, and <style> must be balanced.
         A whole-block str_replace that carries head's tail along drops a fragment
         ("} /* ===== CUSTOM-TOKENS:END ===== */ ... </style></head>") into the middle of
         the body. Every tail check above still passes, yet the browser renders the orphaned
         CSS as a visible text node.
      6. No token-block markers inside <body> (same failure as above, caught directly)
    """
    out = []
    body_close_tags = re.findall(r"</body\s*>", html, re.I)
    if len(body_close_tags) == 0:
        out.append("Missing </body> closing tag — the file may be truncated;"
                    " trailing body content / scripts may be lost")
    elif len(body_close_tags) > 1:
        out.append(
            f"</body> closing tag appears {len(body_close_tags)} times — a whole-block str_replace"
            " duplicated the document tail; delete the extra one"
        )
    m_html_close = re.search(r"</html\s*>", html, re.I)
    if not m_html_close:
        out.append("Missing </html> closing tag — the file may be truncated")

    head_close_tags = re.findall(r"</head\s*>", html, re.I)
    if len(head_close_tags) > 1:
        out.append(
            f"</head> closing tag appears {len(head_close_tags)} times — a whole-block str_replace"
            " pasted head's tail into the body; everything around the stray </head> renders as"
            " visible text. Keep exactly one </head>"
        )

    style_open = len(re.findall(r"<style(?:\s[^>]*)?>", html, re.I))
    style_close = len(re.findall(r"</style\s*>", html, re.I))
    if style_open != style_close:
        out.append(
            f"<style> open/close count mismatch ({style_open} open / {style_close} close) — the CSS"
            " before an orphaned </style> is not inside a style element, so the browser renders it"
            " as literal text on the page"
        )

    body_open_tags = re.findall(r"<body(?:\s[^>]*)?>", html, re.I)
    if len(body_open_tags) == 0:
        out.append(
            "Missing <body> opening tag — likely dropped by a whole-block str_replace;"
            " its bg-background/text-foreground classes are lost, text renders default black"
        )
    elif len(body_open_tags) > 1:
        out.append(
            f"<body> opening tag appears {len(body_open_tags)} times — invalid HTML, browser behavior is not"
            " guaranteed to be consistent; delete the extra one"
        )

    script_open = len(re.findall(r"<script(?:\s[^>]*)?>", html, re.I))
    script_close = len(re.findall(r"</script\s*>", html, re.I))
    if script_open != script_close:
        out.append(
            f"<script> open/close count mismatch ({script_open} open / {script_close} close) —"
            " a common truncation symptom of a whole-block str_replace; the script body may be incomplete"
        )

    # Take the last </html>, not the first: JS strings / template literals occasionally contain
    # the substring "</html>", and slicing trailing content from the first match would flag the
    # legitimate ending after the real closing tag as leftover. Using the last match handles
    # "a fake </html> literal appears once in the body but the document really closes only once";
    # for a genuine duplicate close (both in tag form) there is nothing after the last one either,
    # so the first case is still not missed.
    all_html_close = list(re.finditer(r"</html\s*>", html, re.I))
    if all_html_close:
        last_close = all_html_close[-1]
        trailing = html[last_close.end():]
        trailing_stripped = re.sub(r"<!--.*?-->", "", trailing, flags=re.S).strip()
        if trailing_stripped:
            out.append(
                "Trailing content after </html> — the browser re-parses it into <body> and it "
                "executes; leftover :root remnants silently override earlier tokens (page looks "
                "washed-out). Delete everything after </html>"
            )

    # CSS-block markers must live inside the head's <style>. Strip every style/script element
    # first, so a marker still enclosed in one does not count; whatever is left sits directly in
    # the markup and the browser paints it as text. MOTION-SCRIPT is excluded on purpose -- it
    # legitimately lives in a body <script>.
    stray_markers = sorted({
        m.group(1) for m in re.finditer(
            r"=====\s*(DESIGN-TOKENS|CUSTOM-TOKENS|SIGNATURE-CSS|KEYFRAMES|ANIMATIONS)"
            r":(?:BEGIN|END)\s*=====",
            _html_only(html),
        )
    })
    if stray_markers:
        out.append(
            f"Token-block marker(s) {', '.join(stray_markers)} sit outside <style>/<script> — a"
            " whole-block str_replace pasted a head fragment into the markup, and the browser"
            " renders those comments plus the CSS around them as visible text. Delete the"
            " misplaced fragment"
        )
    return out


SECTION_ID_RE = re.compile(r'(?<![\w-])id=["\']([^"\']+)["\']')


def _html_only(html):
    """Strip <script>/<style> so their contents (CSS url(...) data-URIs, JS strings)
    don't collide with HTML attribute regexes.
    """
    out = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    out = re.sub(r"<style\b.*?</style>", "", out, flags=re.S | re.I)
    return out


def chk_section_ids(html):
    """Verify <section id=...> presence and uniqueness of every id= on the page.

    The id doubles as the in-page anchor target for nav <a href="#X"> — a plain \\b
    won't work here (the hyphen ends a word), so a negative lookbehind for [\\w-]
    is used to keep `data-*-id=` / `aria-labelledby=` out.
    """
    html_only = _html_only(html)
    ids = SECTION_ID_RE.findall(html_only)
    out = []
    if not re.search(r"<section\b[^>]*(?<![\w-])id=", html_only, re.I):
        out.append('No <section id="..."> on this page. At least one is required — the id is the'
                   ' in-page anchor target for nav links. Add an id to a section the layout already'
                   ' has; do not insert a new section for this, and an id on <header>/<main>/<aside>'
                   ' does not satisfy the rule (it must be a <section> tag)')
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        out.append(f"Duplicate id: {sorted(dup)}")
    return out


# Token pairs whose contrast the conversion-time gate (check_design_md.py) enforces at the
# WCAG AA text tier. Kept identical here so the verdict cannot differ between P2 and P4.
CONTRAST_PAIRS = (("foreground", "background"), ("primary-foreground", "primary"))
# `--name: <value>;` inside any rule block, captured per declaring scope (:root and .dark both).
_CSS_SCOPE_RE = re.compile(r"([^{}]*)\{([^{}]*)\}", re.S)
_TOKEN_DECL_RE = re.compile(r"--([A-Za-z0-9-]+)\s*:\s*([^;}]+)")
_STYLE_BLOCK_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S | re.I)
# Closed comment first; the second branch swallows an unterminated `/*` to the end of the
# stylesheet, which is what a browser does too -- everything after it is dead CSS, so reading
# those declarations as live tokens produced a contrast error on tokens that never applied.
_CSS_COMMENT_RE = re.compile(r"/\*.*?\*/|/\*.*", re.S)

# HTML5 tree construction: inside foreign content (svg / mathml) these start tags are
# "not in foreign content" and force the parser to pop out of the SVG element entirely.
# Fixed, closed list from the spec's "any other start tag" breakout clause.
SVG_BREAKOUT_TAGS = frozenset({
    "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em",
    "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing",
    "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike",
    "sub", "sup", "table", "tt", "u", "ul", "var",
})
# `font` only breaks out when it carries one of these attributes (SVG 1.1 has its own <font>).
_FONT_BREAKOUT_ATTR_RE = re.compile(r"(?<![\w-])(color|face|size)\s*=", re.I)
# An unclosed <svg> runs to end of file -- exactly the shape that needs catching, so \Z is a
# legal terminator here rather than a parse failure.
_SVG_REGION_RE = re.compile(r"<svg\b[^>]*>.*?(?:</svg\s*>|\Z)", re.S | re.I)
# HTML inside <foreignObject> is legal and must not be flagged.
_FOREIGN_OBJECT_RE = re.compile(r"<foreignObject\b[^>]*>.*?(?:</foreignObject\s*>|\Z)", re.S | re.I)
_OPEN_TAG_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)(/?)>")


def _blank_css_comments(css):
    """Comment bodies replaced by spaces, keeping the text length and every newline.

    Length-preserving so offsets computed on the blanked copy still index the original: the
    fixer needs to match on comment-free text but splice into the real document. Without this
    a commented-out palette (`/* draft2 { --foreground: ...; } */`) reads as a live scope --
    it produced a contrast error on a draft that had no defect, reported at `` in `/* draft2` ``.
    """
def _blank_matches(text, pattern):
    """Every match of `pattern` replaced by spaces, keeping the text length and every newline.

    Length-preserving so offsets computed on the blanked copy still index the original: callers
    match on the masked text but splice into the real document.
    """
    return pattern.sub(
        lambda m: "".join("\n" if ch == "\n" else " " for ch in m.group(0)), text
    )


def _blank_css_comments(css):
    """CSS comment bodies masked out.

    Without this a commented-out palette (`/* draft2 { --foreground: ...; } */`) reads as a
    live scope -- it produced a contrast error on a draft that had no defect, reported at
    `` in `/* draft2` ``.
    """
    return _blank_matches(css, _CSS_COMMENT_RE)


def _iter_token_scopes(html):
    """(selector, {token: value}, (body_start, body_end)) per CSS rule block that declares tokens.

    Offsets are absolute in `html` and point at the rule body, so a caller can rewrite one
    scope without touching any other text in the document.
    """
    for style in _STYLE_BLOCK_RE.finditer(html):
        css = _blank_css_comments(style.group(1))
        base = style.start(1)
        for block in _CSS_SCOPE_RE.finditer(css):
            decls = {name: value.strip() for name, value in _TOKEN_DECL_RE.findall(block.group(2))}
            if not decls:
                continue
            # Whole selector list on one line: `.a,\n.dark` must not report as just `.dark`.
            selector = " ".join(block.group(1).split())
            yield selector, decls, (base + block.start(2), base + block.end(2))


def _token_scopes(html):
    """[(selector, {token-name: value})] for every CSS rule block in the document.

    Per scope rather than one flat dict: a draft with a `.dark {}` branch declares the same
    token names twice, and a pair that clears AA in light mode can fail in dark mode.
    """
    return [(selector, decls) for selector, decls, _span in _iter_token_scopes(html)]


def chk_token_contrast(html):
    """`foreground/background` and `primary-foreground/primary` must clear WCAG AA 4.5:1.

    Why this is a draft-time gate and not left to conversion: `check_design_md.py` already
    enforces both pairs at P4, but by then the draft is sealed, so the only legal repair is a
    whole extra draft file (new_draft.py --from the selected one) -- observed in ~10% of eval
    apps, each leaving an unfinished fourth draft on the canvas. Failing here instead costs one
    `--fix` call.

    The repair never touches the brand colour: the hue is locked in `primary` / `background`
    while the paired `*-foreground` is a free variable, and one of white / near-black / black
    always clears 4.5:1 against any parsable background (measured -- see core.py). Only when
    the user pinned BOTH sides is there no way out -- that is the one case that stops and asks,
    per design-language.md 0.
    """
    out = []
    for selector, decls in _token_scopes(html):
        for fg, bg in CONTRAST_PAIRS:
            if fg not in decls or bg not in decls:
                continue
            ratio = contrast_ratio(decls[fg], decls[bg])
            if ratio is None or ratio >= AA_TEXT:
                continue
            where = f" in `{selector}`" if selector and selector != ":root" else ""
            winner = best_extreme_triplet(decls[bg])
            if winner:
                best = best_extreme_foreground(decls[bg])
                hint = (f"; flip --{fg} to {best[0]} for {best[1]:.2f}:1 — run this script with "
                        "`--fix <draft>` to apply it")
            else:
                # Unreachable while FOREGROUND_EXTREMES keeps its pure-black fallback: the
                # measured worst case across the whole gamut is 4.58:1. Kept as a safety net so
                # a future change to the extremes surfaces as advice instead of a silent no-op.
                hint = (f"; no foreground extreme reaches 4.5:1 against --{bg}, so `--fix` cannot "
                        f"repair it: move --{bg}'s lightness toward either end, or if the user "
                        "pinned both sides, stop and ask them to choose")
            out.append(
                f"--{fg} / --{bg}{where} contrast {ratio:.2f}:1 < 4.5:1 (WCAG AA text tier — "
                f"a button label is text and does not drop to the 3:1 tier){hint}"
            )
    return out


def fix_token_contrast(html):
    """Flip each failing `*-foreground` token to whichever extreme clears AA on its pair.

    Rewrites one CSS scope at a time, splicing that scope's body back into the document. The
    first shape of this function substituted document-wide on a (token, old value) key, which
    was wrong in three ways:

    - `:root` and `.dark` routinely declare the same `--primary-foreground` over opposite
      backgrounds. Repairing the failing side also rewrote the passing side and broke it, and
      because every pass rewrote both, `--fix` ping-ponged between two states forever -- the
      draft never reached ok and the model was told by FIX_HINTS to keep rerunning `--fix`.
    - The substitution was not bounded to <style>, so the same literal in a `<pre>` sample or
      a template string in `<script>` was rewritten too.
    - The winning value was decided by whichever failing scope was visited last.
    """
    hits = []
    edits = []
    for _selector, decls, (start, end) in _iter_token_scopes(html):
        wanted = {}
        for fg, bg in CONTRAST_PAIRS:
            if fg not in decls or bg not in decls:
                continue
            ratio = contrast_ratio(decls[fg], decls[bg])
            if ratio is None or ratio >= AA_TEXT:
                continue
            winner = best_extreme_triplet(decls[bg])
            if winner:
                wanted[fg] = winner
        if not wanted:
            continue
        # Match on the comment-blanked copy (same length, so offsets still index `html`) and
        # splice the original, so a commented-out declaration inside this block is left alone.
        blanked = _blank_css_comments(html[start:end])
        # Only the LAST declaration of a token in this block is live (CSS last-wins), so only
        # that one is rewritten -- rewriting an overridden earlier copy is a no-op edit that
        # shows up in `replaced` as if a second defect had been repaired.
        live = {}
        for m in _TOKEN_DECL_RE.finditer(blanked):
            if m.group(1) in wanted:
                live[m.group(1)] = m
        pieces, cursor = [], 0
        for m in sorted(live.values(), key=lambda m: m.start()):
            new_value = wanted[m.group(1)]
            old_value = html[start + m.start(2):start + m.end(2)]
            hits.append(f"--{m.group(1)}: {old_value.strip()} -> {new_value}")
            pieces.append(html[start + cursor:start + m.start()])
            # Trailing whitespace is carried over verbatim: a declaration with no `;` ends at the
            # newline, and dropping it used to glue the closing brace onto the value (`0 0% 4%}`).
            pieces.append(f"--{m.group(1)}: {new_value}{old_value[len(old_value.rstrip()):]}")
            cursor = m.end()
        pieces.append(html[start + cursor:end])
        edits.append((start, end, "".join(pieces)))

    out, cursor = [], 0
    for start, end, body in edits:
        out.append(html[cursor:start])
        out.append(body)
        cursor = end
    out.append(html[cursor:])
    return "".join(out), hits


def _iter_svg_breakouts(html):
    """(tag_name, attrs, span, region_span, inside_text) per parser-breaking tag in an <svg>.

    `span` is absolute in `html`; `region_span` bounds the enclosing <svg> block. HTML nested in
    <foreignObject> is masked out first because it is legal there.
    """
    for region in _SVG_REGION_RE.finditer(html):
        masked = _blank_matches(region.group(0), _FOREIGN_OBJECT_RE)
        base = region.start()
        for tag in _OPEN_TAG_RE.finditer(masked):
            name = tag.group(1).lower()
            if name not in SVG_BREAKOUT_TAGS:
                if not (name == "font" and _FONT_BREAKOUT_ATTR_RE.search(tag.group(2))):
                    continue
            before = masked[:tag.start()]
            inside_text = len(re.findall(r"<text\b", before, re.I)) > len(
                re.findall(r"</text\s*>", before, re.I))
            yield (name, tag.group(2), (base + tag.start(), base + tag.end()),
                   (base, base + len(masked)), inside_text)


def chk_svg_foreign_content(html):
    """No HTML element inside an inline <svg> (outside <foreignObject>).

    This is not a tidiness rule. Such a tag makes the HTML parser leave foreign content and pop
    the <svg> off the stack, after which `</svg>` is discarded and every following `<path .../>`
    is parsed as an *HTML* unknown element -- where `/>` does not self-close. The rest of the
    document then nests inside that path. Observed on a delivered `ready` draft: one stray
    `<table>` in a sidebar icon put `<main>` under
    `ASIDE > NAV > A > PATH > RECT`, so the whole page inherited the 240px sidebar width.

    html-integrity cannot see this: it counts specific tags for truncation damage and a
    misnested document keeps every count balanced. The browser reports nothing either.
    """
    out = []
    for name, _attrs, span, _region, inside_text in _iter_svg_breakouts(html):
        line = html.count("\n", 0, span[0]) + 1
        advice = ("use `<tspan>` instead — `<span>` is not an SVG element"
                  if name == "span" and inside_text else
                  "delete it, or move the markup into a `<foreignObject>` if it is really needed")
        out.append(
            f"line {line}: `<{name}>` inside an inline <svg> — the HTML parser exits foreign "
            f"content here, drops the `</svg>`, and every following `<path/>` becomes a "
            f"non-self-closing HTML element, so the rest of the page nests inside the icon; "
            f"{advice}"
        )
    return out


def fix_svg_foreign_content(html):
    """Repair the two shapes whose correct output is uniquely determined; leave the rest.

    - `<span>...</span>` inside an SVG `<text>`: renamed to `<tspan>`, the SVG element that
      actually does "a differently styled run inside a text". Class attributes carry over.
    - An attribute-less start tag with no matching close tag in the same <svg> (the `<table>`
      typo): deleted. It contributes nothing, and deleting it restores the intended parse.

    Anything else (a tag with attributes, or a container with real content) is left for the
    author: whether to drop it or wrap it in <foreignObject> depends on intent, and guessing
    would silently change what the page shows.
    """
    edits = []
    for name, attrs, span, region, inside_text in _iter_svg_breakouts(html):
        region_text = html[region[0]:region[1]]
        close_re = re.compile(rf"</{name}\s*>", re.I)
        close = close_re.search(region_text, span[1] - region[0])
        if name == "span" and inside_text and close:
            edits.append((span, f"<tspan{attrs}>", f"line-{html.count(chr(10), 0, span[0]) + 1} "
                                                   "<span> -> <tspan>"))
            edits.append(((region[0] + close.start(), region[0] + close.end()), "</tspan>", None))
        elif not attrs.strip() and not close:
            edits.append((span, "", f"line-{html.count(chr(10), 0, span[0]) + 1} "
                                    f"removed stray <{name}>"))

    hits = [note for _span, _new, note in edits if note]
    out, cursor = [], 0
    for (start, end), new, _note in sorted(edits, key=lambda e: e[0][0]):
        out.append(html[cursor:start])
        out.append(new)
        cursor = end
    out.append(html[cursor:])
    return "".join(out), hits


def chk_color_fn_double_wrap(html):
    """A custom token already holding a complete color must not be re-wrapped.

    Two legal patterns exist and are easy to mix up:
      A) base token holds a bare triplet   --muted: 220 9% 64%    -> use hsl(var(--muted))
      B) custom token holds a full color   --sig-accent: #ba871d  -> use var(--sig-accent)
    Mixing B's definition with A's usage yields hsl(hsl(...)) / rgb(#...), which is
    invalid CSS: the declaration is dropped and the element falls back (transparent
    background, inherited text color).

    Only variables whose own definition starts with a color function or # are flagged,
    so pattern A keeps passing untouched.
    """
    full_color_vars = set()
    for block in re.findall(r"CUSTOM-TOKENS:BEGIN(.*?)CUSTOM-TOKENS:END", html, re.S):
        for name, value in re.findall(r"--([\w-]+)\s*:\s*([^;}]+)", block):
            if re.match(r"\s*(?:#|hsla?\(|rgba?\(|oklch\(|color-mix\()", value):
                full_color_vars.add(name)
    if not full_color_vars:
        return []
    out = []
    for fn, name in re.findall(r"(hsla?|rgba?|oklch)\(\s*var\(\s*--([\w-]+)\s*\)", html):
        if name in full_color_vars:
            out.append(f"--{name} already holds a complete color value, but it is wrapped again"
                       f" as {fn}(var(--{name})) — this expands to {fn}({fn}(…)) and is invalid CSS"
                       f" (the element falls back to transparent/inherited)."
                       f" Use var(--{name}) directly")
    return sorted(set(out))


def chk_inline_hex(html):
    """No arbitrary hex value in class or inline style — colors must use semantic tokens."""
    out = []
    if re.search(r"\[#[0-9a-fA-F]{3,8}\]", class_text(html)):
        out.append("Arbitrary hex value in class (e.g. bg-[#123456]) — colors must use semantic token classes only")
    for style in re.findall(r'(?<![\w-])style=["\']([^"\']*)["\']', html):
        if re.search(r"#[0-9a-fA-F]{3,8}\b", style) or re.search(r"rgba?\(", style):
            out.append(f"Inline style contains a direct color value: '{style[:60]}…'")
    return out


def chk_direct_palette(html):
    """No Tailwind direct-palette utility classes — colors must go through semantic tokens."""
    pal = r"(?:bg|text|border|from|to|via|ring|fill|stroke|decoration|divide|outline|shadow|accent|caret)"
    color = (r"(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald"
             r"|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)")
    hits = sorted(set(re.findall(pal + "-" + color + r"-\d{2,3}", class_text(html))))
    return [f"Direct palette classes (forbidden, use semantic tokens): {hits[:8]}"] if hits else []


def chk_gradient_text(html):
    """Flag gradient text (bg-clip-text + text-transparent) — a hard slop rule."""
    c = class_text(html)
    if "bg-clip-text" in c and "text-transparent" in c:
        return ["Gradient text (bg-clip-text + text-transparent) = slop hard rule"]
    return []


def chk_purple_gradient(html):
    """Flag the purple/blue-family gradient combo — a universal AI slop formula."""
    c = class_text(html)
    if (re.search(r"from-(?:purple|violet|indigo|fuchsia)-", c)
            and re.search(r"to-(?:blue|purple|violet|indigo|pink|fuchsia)-", c)):
        return ["Purple/blue-family gradient combo = AI slop universal formula"]
    return []


def chk_lorem(html):
    """No lorem ipsum placeholder text."""
    if re.search(r"lorem\s+ipsum", html, re.I):
        return ["lorem ipsum present — use an honest placeholder or real content"]
    return []


ASSET_URL_RE = re.compile(
    r"""(?:https?://[^\s'"()]+|/workspace/[^\s'"()]+)"""
    r"""\.(?:jpe?g|png|webp|gif|avif|svg|mp4|webm|mov|m4v|ogv|ogg)""",
    re.I,
)

# `const el = document.getElementById('x')` -- binds a variable to a markup id
GET_BY_ID_BINDING = re.compile(
    r"""(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*="""
    r"""\s*document\s*\.\s*getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)"""
)
# Emptying an element: `x.textContent = ''` / `x.innerHTML = ""` (also `.innerText`)
CLEAR_ASSIGN = re.compile(
    r"""([A-Za-z_$][\w$]*(?:\s*\.\s*[\w$]+)*|"""
    r"""document\s*\.\s*getElementById\s*\(\s*['"][^'"]+['"]\s*\))"""
    r"""\s*\.\s*(?:textContent|innerHTML|innerText)\s*=\s*(?:''|""|``)\s*;"""
)
GET_BY_ID_INLINE = re.compile(
    r"""document\s*\.\s*getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)"""
)
# Opening tag carrying id="x", used to read that element's markup content
ELEMENT_BY_ID = r"""<([a-zA-Z][\w-]*)\b[^>]*\bid=["']{id}["'][^>]*>"""


def _markup_content_of(html, element_id):
    """Text/markup inside the element declaring `id=element_id`; None when absent.

    Nested same-tag children would break a naive scan, so the closing tag is matched by
    depth counting. Only the element's own opening tag needs the id.
    """
    m = re.search(ELEMENT_BY_ID.format(id=re.escape(element_id)), html)
    if not m:
        return None
    tag = m.group(1)
    open_re = re.compile(rf"<{tag}\b", re.I)
    close_re = re.compile(rf"</{tag}\s*>", re.I)
    depth = 1
    pos = m.end()
    while depth:
        nxt_open = open_re.search(html, pos)
        nxt_close = close_re.search(html, pos)
        if not nxt_close:
            return html[m.end():]
        if nxt_open and nxt_open.start() < nxt_close.start():
            depth += 1
            pos = nxt_open.end()
            continue
        depth -= 1
        pos = nxt_close.end()
        if not depth:
            return html[m.end():nxt_close.start()]
    return ""


def chk_no_clearing_markup(html):
    """A script must not empty an element that carries content in markup.

    `el.textContent = ''` removes every child node, so the copy written in markup is gone --
    and so is anything the same script appended a moment earlier (the classic ordering slip:
    build the per-character spans, append them, *then* clear the parent). The page ends up with
    a blank headline while the HTML looks correct in source. Content must survive in markup:
    clear before building, or use `replaceChildren(...)`.

    Clearing an element that is empty in markup is legitimate (a container the script fills)
    and is not reported.
    """
    scripts = re.findall(r"<script\b[^>]*>(.*?)</script>", html, flags=re.S | re.I)
    if not scripts:
        return []
    markup = _html_only(html)
    hits = []
    for body in scripts:
        bindings = dict(
            (var, el_id) for var, el_id in GET_BY_ID_BINDING.findall(body)
        )
        for m in CLEAR_ASSIGN.finditer(body):
            target = m.group(1)
            inline = GET_BY_ID_INLINE.search(target)
            el_id = inline.group(1) if inline else bindings.get(target.strip())
            if not el_id:
                continue
            content = _markup_content_of(markup, el_id)
            if content and content.strip():
                hits.append((el_id, content.strip()[:24]))
    if not hits:
        return []
    detail = "; ".join(f'#{i} ("{c}")' for i, c in hits[:3])
    more = "" if len(hits) <= 3 else f" +{len(hits) - 3} more"
    return [
        f"Script empties element(s) that hold markup content: {detail}{more}. Clearing removes "
        "every child node — including nodes the same script just appended — so the copy written "
        "in markup disappears from the page. Clear before building the replacement children, or "
        "use `replaceChildren(...)`"
    ]


def chk_assets_in_markup(html):
    """Media paths must live in markup attributes, never in JS strings.

    The preview rewrites workspace paths to data URLs by walking parsed DOM nodes: the
    attributes in `img/src`, `source/src`, `script/src`, `link/href`, `video/poster`,
    `video/src`, `audio/src`, plus `url()` inside inline `style` and `<style>` blocks. Script
    text is never scanned, so a path a script holds as a string stays the raw workspace path
    and resolves to nothing inside the sandboxed srcDoc iframe -- the image breaks even when
    markup elsewhere references the same file. Build the elements in markup and let the script
    operate on those nodes instead of carrying URLs.
    """
    orphans = set()
    for m in re.finditer(r"<script\b[^>]*>(.*?)</script>", html, flags=re.S | re.I):
        orphans.update(ASSET_URL_RE.findall(m.group(1)))
    if not orphans:
        return []
    ordered = sorted(orphans)
    sample = ", ".join(ordered[:3])
    more = "" if len(ordered) <= 3 else f" +{len(ordered) - 3} more"
    return [
        f"Media path(s) held in JS strings: {sample}{more}. The preview only rewrites paths found"
        " on DOM attributes, so a script-carried path stays a raw workspace path and the image /"
        " video breaks. Write the elements in markup (`<img src>` / `<video src>` / `<source src>`"
        " / `<video poster>` / `<audio src>` / inline `style=\"background-image:url(...)\"` /"
        " `url()` in `<style>`) and have the script drive those nodes"
    ]


def chk_base64_img(html):
    """No large base64-inlined images — use an https URL or a local assets path."""
    for m in re.finditer(r'(?<![\w-])src=["\'](data:image/[^"\']+)["\']', html):
        if len(m.group(1)) > 2048:
            return ["Large base64-inlined image (use an https URL or a full absolute path"
                    " /workspace/<app-id>/tasks/design/assets/<name> for images)"]
    return []


def chk_emoji_icons(html):
    """Flag emoji used as icons in the body (slop, unless brand/kids context)."""
    body = html.split("</head>", 1)[-1]
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    hits = re.findall(r"[\U0001F300-\U0001FAFF☀-➿]", body)
    if hits:
        return [f"{len(hits)} emoji found in body (emoji as icons is slop, unless brand/kids context)"]
    return []


FONT_LIB_PREFIX = "https://resource-static.bj.bcebos.com/fonts-skill/"
# The one directory whose inventory is fully defined by a file we ship (`data/fonts.csv`), hence the
# only one whose filenames can be judged. The theme library's `/fonts/` is deliberately NOT here:
# `data/theme.xlsx` is a partial snapshot (bucket listing is 403, so it cannot be completed), and on
# the draft corpus every dead URL sat under `/fonts-skill/` while `/fonts/` produced only false
# positives. Its addresses still feed the suggestion index -- they are known-good, just not
# exhaustive.
BOS_FONT_DIR_RE = re.compile(r"^https?://resource-static\.(?:bj|cdn)\.bcebos\.com/fonts-skill/")
# Trusted font domains: bj.bcebos.com (fonts.csv default) + cdn.bcebos.com (legacy, in some
# theme.xlsx specs). Trust the domain, not the filename — the two sources aren't cross-validated.
TRUSTED_FONT_HOSTS = (
    "resource-static.bj.bcebos.com",
    "resource-static.cdn.bcebos.com",
)
FONT_CDN_HOSTS = (
    "fonts.googleapis.com", "fonts.gstatic.com", "fonts.bunny.net",
    "use.typekit.net", "fonts.loli.net",
)


DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_FONT_REGISTRY = None


def _stem_of(url):
    """Filename of a font URL without its extension, lowercased."""
    return url.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()


def _loose_key(text):
    """Lowercase and drop separators, so `HarmonyOS_Sans_Regular` == `HarmonyOSSans-Regular`.

    Case and separator slips are the most common way a hand-assembled filename misses: `MiSans_
    Semibold` for `MiSans_SemiBold`, `vivoSans-Bold` for `vivoSans_Bold`. They have one obviously
    correct answer, so matching on this key lets the checker hand it over instead of telling the
    author to go search again.
    """
    return re.sub(r"[^a-z0-9]", "", text.lower())


def font_registry():
    """Every font URL a legal source can produce, plus the indexes used to suggest the right one.

    Two registries are read because two independently maintained sources are both legal: `fonts.csv`
    (served from `/fonts-skill/`, one row per typeface with an optional `{weight}` template) and the
    theme library snapshot `theme.xlsx` (served from `/fonts/`, often the `.woff2` sibling of the
    same typeface). Host, directory and extension all differ between them, so a draft author who
    takes the filename from one and the path from the other lands on a URL that exists in neither --
    measured in production as a page silently falling back to system fonts.

    Returns a dict with `urls`, `by_stem`, `by_loose` (separator/case-insensitive stem) and
    `families` (typeface name -> a representative URL, for the nearest-name suggestion). Empty on
    any read failure, which turns the rule into a no-op rather than blocking drafts because a data
    file is missing from a deployment.
    """
    global _FONT_REGISTRY
    if _FONT_REGISTRY is not None:
        return _FONT_REGISTRY
    urls, families = set(), {}
    try:
        import csv as _csv
        with open(DATA_DIR / "fonts.csv", encoding="utf-8-sig") as f:
            for row in _csv.DictReader(f):
                direct = (row.get("CDN_URL") or "").strip()
                if direct:
                    urls.add(FONT_LIB_PREFIX + direct)
                template = (row.get("CDN_URL_Template") or "").strip()
                weights = (row.get("Weights") or "").split()
                if template and "{weight}" in template:
                    for weight in weights:
                        urls.add(FONT_LIB_PREFIX + template.replace("{weight}", weight))
                pick = direct or (template.replace("{weight}", weights[0]) if template and weights else "")
                if not pick:
                    continue
                for label in (row.get("Font_Family"), row.get("Font_Name_EN"), row.get("Font_Name_CN")):
                    if label and label.strip():
                        families.setdefault(label.strip(), FONT_LIB_PREFIX + pick)
    except Exception:
        pass
    try:
        import zipfile
        with zipfile.ZipFile(DATA_DIR / "theme.xlsx") as z:
            for name in z.namelist():
                if not name.endswith((".xml", ".rels")):
                    continue
                text = z.read(name).decode("utf-8", "replace")
                urls |= set(re.findall(r"https?://[^\s\"'<>]+?\.(?:ttf|otf|woff2?)", text))
    except Exception:
        pass
    urls = {_canonical_font_url(u) for u in urls}
    by_stem, by_loose, by_family = {}, {}, {}
    for url in urls:
        stem = _stem_of(url)
        by_stem.setdefault(stem, set()).add(url)
        by_loose.setdefault(_loose_key(stem), set()).add(url)
        by_family.setdefault(_loose_key(re.split(r"[-_]", stem)[0]), set()).add(url)
    _FONT_REGISTRY = {"urls": urls, "by_stem": by_stem, "by_loose": by_loose,
                      "by_family": by_family, "families": families}
    return _FONT_REGISTRY


def suggest_font_urls(url, reg, limit=3):
    """Best available replacements for a dead font URL, nearest first.

    Tiers, each more speculative than the last, so the message can say how much to trust it:
    `exact`  - the same filename, published somewhere else (wrong host/directory/extension) or
               differing only in case and separators; there is one right answer.
    `family`  - the typeface exists but not in that weight; the answer is one of its real weights.
    `nearest` - only the name resembles something in the library; a judgement call.

    Doing this here is the point: otherwise the report can only say "go run search_fonts.py" and the
    author has to guess which query resurfaces a font they have already named.
    """
    def dedupe(seq):
        return list(dict.fromkeys(seq))[:limit]

    stem = _stem_of(url)
    for index, key in ((reg["by_stem"], stem), (reg["by_loose"], _loose_key(stem))):
        hit = sorted(index.get(key, ()))
        if hit:
            return dedupe(hit), "exact"
    base = _loose_key(re.split(r"[-_]", stem)[0])
    same_family = sorted(reg["by_family"].get(base, ()))
    if same_family:
        return dedupe(same_family), "family"
    import difflib
    lowered = {name.lower(): name for name in reg["families"]}
    near = difflib.get_close_matches(base, list(lowered), n=limit * 2, cutoff=0.6)
    return dedupe(reg["families"][lowered[n]] for n in near), "nearest"


def chk_font_library(html):
    """Fonts may only come from a trusted domain -- no third-party font CDN, no self-hosted guess."""
    out = []
    for host in FONT_CDN_HOSTS:
        if host in html:
            out.append(
                f"References a non-approved font CDN {host} (fonts must come from the data/fonts.csv"
                " available font library; search via scripts/search_fonts.py)"
            )
    for url in _font_face_urls(html):
        host_m = re.match(r"https?://([^/]+)/", url)
        host = host_m.group(1) if host_m else ""
        if host not in TRUSTED_FONT_HOSTS:
            out.append(
                f"@font-face references domain '{host}' which is not a trusted font domain"
                f" (URL: {url[:80]}) — use search_fonts.py to find the correct address"
            )
    return out


def _canonical_font_url(url):
    """Percent-decode so the two spellings of a variable-font filename compare equal.

    The registry stores `EBGaramond_EBGaramond[wght].ttf`; a draft may write `...%5Bwght%5D.ttf`,
    which is the same file. Nothing else is normalised -- in particular `resource-static.bj` and
    `resource-static.cdn` are treated as the distinct hosts they are, so a draft is expected to use
    whichever one the registry publishes for that file rather than swapping them.
    """
    from urllib.parse import unquote
    return unquote(url)


def _font_face_urls(html):
    """Absolute URLs appearing in the src of an @font-face rule."""
    return [
        m.group(1)
        for m in re.finditer(r"@font-face[^{}]*\{[^}]*?url\(\s*['\"]?([^'\")\s]+)", html, re.S)
        if m.group(1).startswith(("http://", "https://"))
    ]


def chk_font_url_published(html):
    """A `/fonts-skill/` address must be a filename `data/fonts.csv` publishes.

    Scope is one directory on purpose (see BOS_FONT_DIR_RE): that is the only inventory we hold in
    full, so it is the only one where "not listed" safely means "does not exist". Everything else --
    the theme library's `/fonts/`, other paths, other hosts, third-party CDNs -- is out of remit.

    Inside that directory the failure is invisible without this check. Every font 404 measured in
    production sat on the right host with an assembled filename: right typeface, wrong extension;
    right family, a weight it does not ship; or `_`/case slips. The page just renders in a system
    font, and no other rule notices.

    Waivable purely as a snapshot escape hatch: fonts.csv is maintained by hand, so a font could be
    uploaded before the copy shipped here lists it.
    """
    reg = font_registry()
    if not reg.get("urls"):
        return []
    out = []
    for raw in _font_face_urls(html):
        url = _canonical_font_url(raw)
        if not BOS_FONT_DIR_RE.match(url):
            continue
        if url in reg["urls"]:
            continue
        if "{weight}" in url:
            out.append(
                f"@font-face still contains the literal placeholder: {url[:100]} — replace"
                " {weight} with one of the weight names search_fonts.py listed for that font"
            )
            continue
        picks, kind = suggest_font_urls(url, reg)
        if kind == "exact" and picks:
            out.append(
                f"@font-face URL does not exist: {url} — the published address for this file is"
                f" {picks[0]}. Copy it verbatim, host included; host, directory and extension all"
                " differ between the font library and the theme library, so they cannot be mixed"
            )
        elif kind == "family" and picks:
            out.append(
                f"@font-face URL does not exist: {url} — that typeface is published, but not in"
                f" that weight/format. Available: {', '.join(picks)}. Use one of these verbatim"
                " (search_fonts.py lists the family's full weight set)"
            )
        elif picks:
            out.append(
                f"@font-face URL is not in the font library: {url} — fonts.csv publishes no such file. The"
                f" nearest library entries by name are {', '.join(picks)}; use one only if it is"
                " actually the typeface you want, otherwise run search_fonts.py (add --lang zh for"
                " a Chinese page, or the candidates come back Latin-only)"
            )
        else:
            out.append(
                f"@font-face URL is not in the font library: {url} — fonts.csv publishes no such file"
                " and nothing in it resembles the name. Run search_fonts.py and copy an address"
                " from its output (add --lang zh for a Chinese page). Only /fonts-skill/ addresses"
                " are checked; fonts served from elsewhere are not this rule's business"
            )
    return out



GENERIC_FONT_FAMILIES = {
    "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
    "inherit", "initial", "unset", "revert", "revert-layer",
}


def chk_font_face_required(html):
    """Every font-family used must have an @font-face registered; otherwise it falls back silently."""
    stripped = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    registered = set()
    for block in re.findall(r"@font-face\s*\{([^}]*)\}", stripped, re.S):
        m = re.search(r"font-family:\s*(['\"]?)([^;'\"]+)\1", block)
        if m:
            registered.add(m.group(2).strip())
    if not registered:
        return [
            "No @font-face registered — every font-family falls back to system fonts silently. "
            "Register the fonts this draft uses"
        ]
    missing = set()
    for stack in re.findall(r"font-family:\s*([^;}]+)", stripped):
        first = stack.split(",", 1)[0].strip().strip("'\"")
        if not first or first.startswith("var(") or first.lower() in GENERIC_FONT_FAMILIES:
            continue
        if first not in registered:
            missing.add(first)
    if not missing:
        return []
    return [
        f"font-family used but not registered: {sorted(missing)}. The browser silently falls back "
        "to system fonts. Add an @font-face rule for each (source it from the font library). "
        "Removing a font-family is only correct when the draft genuinely does not use that font — "
        "swapping in a generic family to stop this rule from matching is not a fix"
    ]


def chk_tiny_text(html):
    """Flag any arbitrary font size below 12px — a hard readability floor."""
    hits = sorted(set(re.findall(r"text-\[(\d+)px\]", class_text(html))))
    bad = [h for h in hits if int(h) < 12]
    if not bad:
        return []
    return [f"Font size <12px: text-[{'/'.join(bad)}px]"
            " (readability hard floor, not waivable for any style)"]


# Integer steps of Tailwind v3's default spacing scale (the full scale also has px / 0.5 / 1.5 /
# 2.5 / 3.5; fractional and px steps are naturally excluded by the regex, so only integers are
# checked). Steps like 13/15/17/18/19/22/26... **do not exist**: the scale jumps from 12 to 14,
# and after 16 it increments by 4.
TW_SPACING_STEPS = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40,
    44, 48, 52, 56, 60, 64, 72, 80, 96,
}
# Only utility prefixes driven by the spacing scale; longer prefixes come first so `gap-x-13` is
# not truncated to `gap` and misjudged. Deliberately excludes families with their own separate
# scales such as grid-cols / z / order / leading / duration.
SPACING_PREFIXES = sorted(
    ["gap-x", "gap-y", "space-x", "space-y", "inset-x", "inset-y",
     "translate-x", "translate-y", "gap", "inset", "size",
     "px", "py", "pt", "pr", "pb", "pl", "ps", "pe", "p",
     "mx", "my", "mt", "mr", "mb", "ml", "ms", "me", "m",
     "top", "right", "bottom", "left", "start", "end", "w", "h"],
    key=len, reverse=True,
)
SPACING_CLASS = re.compile(
    r"(?:^|[\s:])-?(" + "|".join(re.escape(p) for p in SPACING_PREFIXES) + r")-(\d+)(?=$|\s)"
)
# Object names under theme.extend that may declare custom steps; on a hit, their integer keys
# join the whitelist.
SPACING_THEME_KEYS = (
    "spacing", "width", "height", "minHeight", "maxHeight", "minWidth", "maxWidth",
    "padding", "margin", "gap", "inset", "space", "size", "translate",
)
# Only accept keys whose value carries a length unit, so keyframes entries like '0%': {...} are
# not mistaken for scale declarations.
SPACING_THEME_STEP = re.compile(
    r"""(?:^|[{,\s])(['"]?)(\d+)\1\s*:\s*['"]?[^,}]*?(?:rem|px|em|%|vh|vw|ch|ex|calc)"""
)


def _balanced_body(text, brace_pos):
    """Return the full object body (nesting included) up to the `{` at text[brace_pos]'s match.

    `\\{[^{}]*\\}` cannot be used to grab the theme object -- `spacing: { ... }` may nest, and an
    adjacent `keyframes: { 'x': { ... } }` makes a non-nesting regex slip and capture a different
    object body.
    """
    depth = 0
    for i in range(brace_pos, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[brace_pos + 1:i]
    return ""


def _declared_spacing_steps(html):
    """Collect integer spacing steps declared in the page's own tailwind.config theme extensions."""
    steps = set()
    for key in SPACING_THEME_KEYS:
        for m in re.finditer(r"\b" + key + r"\s*:\s*\{", html):
            for km in SPACING_THEME_STEP.finditer(_balanced_body(html, m.end() - 1)):
                steps.add(int(km.group(2)))
    return steps


def chk_spacing_scale(html):
    """Catch steps that do not exist on the Tailwind spacing scale (`h-13` / `mt-15` / `gap-17`...).

    Such classes compile to no CSS at all: Tailwind only generates steps that are on the scale,
    so `h-13` silently does nothing and the element falls back to a content-driven height. No
    error, no trace -- absolutely positioned children inside it (icon buttons and the like) end up
    misaligned. The symptom is a control with off proportions that just looks undesigned, and it
    is very hard to trace by eye back to a class that does not exist.

    The whitelist comes from the page's own `tailwind.config`: an integer key declared in
    `spacing`/`height`/`gap` etc. (with a length-unit value) is allowed through -- wanting a step
    of 13 is legitimate, provided it is declared first. Arbitrary values (`h-[52px]`), fractional
    steps (`w-1/2`), and keyword steps (`h-full`/`h-screen`) do not match this rule's shape and
    are unaffected.
    """
    allowed = TW_SPACING_STEPS | _declared_spacing_steps(html)
    bad = sorted({
        f"{prefix}-{num}"
        for prefix, num in SPACING_CLASS.findall(class_text(html))
        if int(num) not in allowed
    })
    if not bad:
        return []
    return [
        f"Tailwind spacing step does not exist: {bad[:8]} — compiles to no CSS, so the size "
        "silently fails and absolutely-positioned children misalign. Use an adjacent valid step, "
        "an arbitrary value (`h-[3.25rem]`), or declare it in tailwind.config spacing first"
    ]


KEYFRAMES_BLOCK = re.compile(r"KEYFRAMES:BEGIN(.*?)KEYFRAMES:END", re.S)
KEYFRAMES_NAME = re.compile(r"""['"]([\w-]+)['"]\s*:\s*\{""")
NATIVE_KEYFRAMES_NAME = re.compile(r"@keyframes\s+([\w-]+)")
ANIMATION_PROP_REF = re.compile(r"animation(?:-name)?\s*:\s*([\w-]+)")
# The same reference written from JS: `el.style.animation = 'name 0.6s ...'`,
# `style.animationName = "name"`, or `setProperty('animation', 'name ...')`
ANIMATION_JS_REF = re.compile(
    r"""(?:style\s*\.\s*animation(?:Name)?\s*=|setProperty\s*\(\s*['"]animation(?:-name)?['"]\s*,)"""
    r"""\s*['"`]\s*([\w-]+)""",
)

# `'name': {` / `name: {` heading a keyframe definition inside the KEYFRAMES block
KEYFRAMES_ENTRY = re.compile(r"""['"]?([\w-]+)['"]?\s*:\s*\{""")
# A CSS property assignment inside a keyframe step: `opacity: '0'` / `clipPath: "inset(...)"` /
# `'clip-path': 'inset(...)'`. All three spellings are legal in a Tailwind config object and the
# model writes all three; matching only the unquoted one parsed zero properties out of a quoted
# keyframe, which dropped it from the map entirely and made the start-state check below skip it.
# Percentage step keys (`'0%': {`) do not match -- their value is `{`, not a quote, and the name
# must start with a letter.
KEYFRAMES_STEP_PROP = re.compile(r"""['"]?([A-Za-z][\w-]*)['"]?\s*:\s*['"]""")
# Elements wired to the CSS entrance channel via the `intersect` variant. Deliberately still
# prefix-only: the observer library is required by this form alone.
INTERSECT_ANIMATE = re.compile(r"intersect:animate-([\w-]+)")
# Any entrance animation, with or without the variant. A load-time `animate-<name>` strands the
# element in its start state exactly the same way, and it is the more common shape of this bug.
# Other variants (`md:` / `hover:`) are left out: there the utility is a breakpoint or hover
# state rather than the resting start state.
START_ANIMATE = re.compile(r"(?<![\w:-])(?:intersect:)?animate-([\w-]+)")
# The observer library that flips `no-intersect` off; without it every start state is permanent
INTERSECT_OBSERVER_REF = re.compile(r"tailwindcss-intersect")
# `intersect` is a variant (`&:not([no-intersect])`), not a class -- adding it triggers nothing
INTERSECT_CLASS_ADD = re.compile(
    r"""classList\s*\.\s*add\s*\(\s*['"]intersect['"]"""
)
# Opacity start states that hide the element until the animation raises opacity again. The
# lookbehind rejects a variant-scoped utility (`group-hover:opacity-0`, `md:opacity-0`): that is a
# hover or breakpoint state, not the resting start state this rule reasons about.
OPACITY_START = re.compile(r"(?<![\w:-])opacity-(0|5|10|20)(?![\w-])")
# A bare opacity utility that leaves the element visible. When one sits alongside `opacity-0` the
# resting opacity is decided by stylesheet order, not by the class list, so the rule stays out.
OPACITY_VISIBLE = re.compile(r"(?<![\w:-])opacity-(?:2[5-9]|[3-9]\d|100)(?![\w-])")


def _keyframe_animated_props(html):
    """Map each keyframe name in the KEYFRAMES block to the CSS properties it animates.

    Property names are normalised by dropping `-`, so the two spellings of one property
    (`clipPath` and `'clip-path'`) land on the same key and cannot be mistaken for two
    different properties -- or, worse, for a keyframe that animates nothing.
    """
    block = KEYFRAMES_BLOCK.search(html)
    if not block:
        return {}
    body = block.group(1)
    out = {}
    for m in KEYFRAMES_ENTRY.finditer(body):
        name = m.group(1)
        if name.endswith("%"):
            continue
        steps = _balanced_body(body, m.end() - 1)
        props = {p.lower().replace("-", "") for p in KEYFRAMES_STEP_PROP.findall(steps)}
        if props:
            out[name] = props
    return out


def _motion_opacity_classes(html):
    """Classes whose opacity a motion `animate()` call raises from 0.

    The two channels can legitimately split the work: a CSS keyframe drives the pulse or the wipe
    while motion does the fade-in, so `opacity-0` on such an element is restored by the JS, not by
    the keyframe. Those elements belong to `motion-fill-forwards`, which knows the real question
    (is `fill: 'forwards'` set?) and prints the fix that matches it -- telling the author to "add
    opacity to the keyframe" instead would be wrong advice.

    Deliberately scanning the whole document, not the MOTION-SCRIPT block: drafts exist whose
    motion code sits in a plain `<script data-preview-only>` with no block markers, and there the
    exemption still has to hold. Only classes named in a quoted selector count, and only when
    something animates opacity from 0, so the exemption cannot reach elements no script mentions.
    An `opacity-*` utility is never taken as a selector class -- `animate('p.opacity-0', ...)`
    would otherwise exempt every element this rule looks at, the rule's own start state included.
    """
    if not MOTION_OPACITY_FROM_ZERO.search(html):
        return frozenset()
    out = set()
    for literal in re.findall(r"""['"]([^'"\n]{1,120})['"]""", html):
        out.update(re.findall(r"\.([A-Za-z][\w-]*)", literal))
    return frozenset(c for c in out if not re.fullmatch(r"opacity-\d+", c))


def chk_intersect_start_state(html):
    """The CSS entrance channel only works when the start state and the keyframe touch the same
    property, and when the observer that clears `no-intersect` is actually loaded.

    Three silent runtime failures, all of which leave every other rule green:

    1. Start state on a property the keyframe never animates. `opacity-0` plus a keyframe that
       only moves `clipPath`/`transform` means opacity stays 0 for good -- the element (and its
       whole subtree) never becomes visible. Observed symptom: a draft that renders blank because
       the section wrapping the page's body content carried `opacity-0`, and -- 7 corpus drafts --
       a hero headline that never appears because a clip-path wipe was given an `opacity-0` start
       state. Both spellings of the property (`clipPath` and `'clip-path'`) and both trigger forms
       (`intersect:animate-*` and a plain load-time `animate-*`) are checked; each of those four
       shapes was, at some point, a hole this rule failed open through.
    2. `intersect:` classes with no `tailwindcss-intersect` script. Nothing ever removes the
       `no-intersect` attribute, so every start state is permanent.
    3. `classList.add('intersect')`. `intersect` is a Tailwind variant compiled to
       `&:not([no-intersect])`, not a class; adding it changes nothing. This is the shape a
       hand-rolled IntersectionObserver replacement takes when it replaces the real library.
    """
    out = []
    used = sorted(set(INTERSECT_ANIMATE.findall(html)))
    if used and not INTERSECT_OBSERVER_REF.search(html):
        out.append(
            f"intersect:animate-* is used ({', '.join(used[:4])}) but the tailwindcss-intersect "
            "script is missing — nothing ever clears the `no-intersect` attribute, so each start "
            "state (opacity-0 and friends) becomes permanent and the elements never appear. "
            "Restore the observer script from assets/base.html"
        )
    if INTERSECT_CLASS_ADD.search(html):
        out.append(
            "classList.add('intersect') does nothing — `intersect` is a Tailwind variant compiled "
            "to `&:not([no-intersect])`, not a class. Use the tailwindcss-intersect script from "
            "assets/base.html instead of a hand-rolled observer"
        )

    animated = _keyframe_animated_props(html)
    motion_opacity = _motion_opacity_classes(html)
    mismatched = []
    for m in re.finditer(r'class="([^"]*)"', html):
        cls = m.group(1)
        if not OPACITY_START.search(cls) or OPACITY_VISIBLE.search(cls):
            continue
        if motion_opacity.intersection(cls.split()):
            continue
        # Every animation on the element gets a say: one of them raising opacity is enough to
        # bring the element back, so a single geometry-only keyframe among several is not a bug.
        known = [(name, animated[name]) for name in START_ANIMATE.findall(cls) if name in animated]
        if not known or any("opacity" in props for _, props in known):
            continue
        name, props = known[0]
        mismatched.append((name, sorted(props)))
    if mismatched:
        detail = "; ".join(
            f"animate-{n} only animates {', '.join(p)}" for n, p in mismatched[:3]
        )
        more = "" if len(mismatched) <= 3 else f" (+{len(mismatched) - 3} more)"
        out.append(
            f"Start state `opacity-0` paired with a keyframe that never animates opacity — "
            f"{detail}{more}. Opacity stays 0 after the animation finishes, so the element and "
            "everything inside it stay invisible for good. Take the start state from the "
            "keyframe's own 0% properties (a clip-path wipe needs no opacity-0 — the clip already "
            "hides it, so `[clip-path:inset(0_100%_0_0)]` is the start state), or add opacity to "
            "the keyframe"
        )
    return out


def chk_keyframes_wired(html):
    """The KEYFRAMES block is a Tailwind config object (feeding `animate-<name>` utility classes),

    not a native CSS `@keyframes` rule; the two look similar but are not interchangeable. Naming
    one of those keyframes in a CSS `animation:` property, or assigning it from JS
    (`el.style.animation = 'name ...'`), leaves the browser with no such animation name: it
    silently ignores the declaration and the element stays in its initial state forever. Typical
    symptom -- entrance-animated elements never appear and the page looks half-loaded, or a
    per-character title built by script stays fully transparent.
    """
    m = KEYFRAMES_BLOCK.search(html)
    if not m:
        return []
    kf_names = set(KEYFRAMES_NAME.findall(m.group(1)))
    if not kf_names:
        return []
    native = set(NATIVE_KEYFRAMES_NAME.findall(html))
    referenced = set(ANIMATION_PROP_REF.findall(html)) | set(ANIMATION_JS_REF.findall(html))
    broken = sorted(
        name for name in referenced if name in kf_names and name not in native
    )
    if not broken:
        return []
    names = ", ".join(broken)
    return [
        f"`animation` references {names} from the KEYFRAMES block, but that name only exists in "
        "the Tailwind config, not as a native @keyframes rule — the browser silently ignores it "
        "and the element stays in its initial state. Trigger it via the generated class instead "
        "(`intersect:animate-<name> intersect-once`, or add the class from JS)"
    ]


TAILWIND_CONFIG_ASSIGN = re.compile(r"tailwind\.config\s*=\s*\{")
_NODE = shutil.which("node")

# Innermost array literals: bare strings are legal inside arrays
# (fontFamily: ['Jost', 'sans-serif']), so they must be stripped wholesale before scanning,
# otherwise a `, 'x' ,` between elements is misread as a missing key.
ARRAY_LITERAL = re.compile(r"\[[^\[\]]*\]", re.S)

# A bare string in object position: `{ 'x', y: 1 }` / `, 'x' ,` -- the residue of a deleted key.
# A legitimate string value is always preceded by `key:`, so the colon is the decisive anchor.
# Here we require `{` or `,` immediately before and `,` or `}` immediately after; normal code
# never lands in this shape.
ORPHAN_STRING_VALUE = re.compile(r"""[{,]\s*(['"])((?:\\.|(?!\1).){1,120})\1\s*(?=[,}])""", re.S)


def chk_config_integrity(html):
    """Regex fallback for `tailwind.config` validity, used only when node is unavailable.

    config-js-syntax parses the block with a real JS parser and is a strict superset of this rule,
    so running both would report one defect twice. This one covers the single most common broken
    shape without any external dependency: `sed 's/lg://g'` used to bulk-strip breakpoint prefixes
    also deletes the key in `borderRadius: { lg: '…' }`, leaving `{ '…', md: … }` -- a bare string
    in object position.

    Either way the consequence is the same: one syntax error makes the whole config throw, so
    colors / keyframes / fontFamily / borderRadius never register, `bg-primary` and `animate-*`
    silently emit nothing, and the page collapses to browser defaults while the HTML stays intact
    and every other rule stays green -- the hardest class of false pass to diagnose.

    Array literals are stripped first, since bare strings inside arrays are legal
    (fontFamily: ['Jost', 'sans-serif']).
    """
    if _NODE:
        return []  # config-js-syntax covers this and more
    m = TAILWIND_CONFIG_ASSIGN.search(html)
    if not m:
        return []
    body = _balanced_body(html, m.end() - 1)
    if not body:
        return ["tailwind.config = {...} has unbalanced braces — the config throws at runtime and no "
                "custom color / keyframe / font / radius registers."]
    prev = None
    while prev != body:
        prev, body = body, ARRAY_LITERAL.sub(" ", body)
    orphans = [v[:40] for _, v in ORPHAN_STRING_VALUE.findall(body)]
    if not orphans:
        return []
    sample = ", ".join(f"'{s}'" for s in orphans[:4])
    more = "" if len(orphans) <= 4 else f" +{len(orphans) - 4} more"
    return [
        f"tailwind.config has {len(orphans)} bare string(s) with no key ({sample}{more}) — "
        "JS syntax error, all custom classes emit nothing. Restore the missing object keys."
    ]


def chk_config_js_syntax(html):
    """Parse the `tailwind.config = {...}` block with `node --check` (syntax only, never executes).

    Superset of config-integrity: catches every JS syntax error, not just the one regex-detectable
    shape. The failure mode that motivated it: a keyframe CSS property whose name contains a hyphen
    left unquoted (`stroke-dashoffset: '24'`) parses as the subtraction `stroke - dashoffset`, so the
    whole assignment throws and no custom color / font / keyframe / radius ever registers -- the page
    silently falls back to browser defaults while every other rule stays green.

    Regex can only enumerate the broken shapes someone thought of; a real parser needs no such list.
    Skipped when node is unavailable (config-integrity still covers the common shape). `--check` only
    parses, so nothing in the draft can run.
    """
    if not _NODE:
        return []
    m = TAILWIND_CONFIG_ASSIGN.search(html)
    if not m:
        return []
    body = _balanced_body(html, m.end() - 1)
    if not body:
        return []  # unbalanced braces: config-integrity already reports this
    path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(f"tailwind.config = {{{body}}};\n")
            path = f.name
        proc = subprocess.run([_NODE, "--check", path], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []  # node broke or timed out: stay silent rather than block on tooling
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
    if proc.returncode == 0:
        return []
    lines = [ln.strip() for ln in (proc.stderr or "").splitlines() if ln.strip()]
    detail = next((ln for ln in lines if "Error:" in ln), lines[-1] if lines else "unknown")
    return [
        f"tailwind.config JS syntax error — {detail}. All custom classes emit nothing. "
        "Common cause: unquoted hyphenated key (`'stroke-dashoffset'` needs quotes)."
    ]


MOTION_BLOCK = re.compile(
    r"MOTION-SCRIPT:BEGIN\s*={3,}\s*\*/(.*?)/\*\s*={3,}\s*MOTION-SCRIPT:END", re.S
)
# Top-level `const {animate} = window` runs synchronously, before the deferred module has
# assigned those functions -- it captures undefined. Only a destructure that sits inside the
# motion:ready callback (or plain `window.animate(...)`) sees the real values.
MOTION_TOPLEVEL_DESTRUCTURE = re.compile(
    r"^[ \t]*(?:const|let|var)\s*\{[^}]*\}\s*=\s*window\b", re.M
)
# `animate(...)` call sites inside MOTION-SCRIPT, captured up to the matching paren
MOTION_ANIMATE_CALL = re.compile(r"\banimate\s*\(")
# An `opacity` keyframe whose first value is 0 -- the element starts invisible
MOTION_OPACITY_FROM_ZERO = re.compile(r"opacity\s*:\s*\[\s*['\"]?0(?:\.0+)?['\"]?\s*,")
MOTION_FILL_FORWARDS = re.compile(r"fill\s*:\s*['\"]forwards['\"]")
# First string literal in the call -- the selector animate() targets
MOTION_SELECTOR = re.compile(r"^\s*['\"]([^'\"]+)['\"]")
# A CSS rule that declares the element invisible at rest
CSS_OPACITY_ZERO_RULE = re.compile(
    r"([^{}]+)\{[^{}]*opacity\s*:\s*0(?:\.0+)?\s*[;}]", re.S
)


def _hidden_at_rest(html):
    """Selectors that start invisible: CSS `opacity: 0` rules plus `opacity-0` utility classes."""
    hidden = set()
    for style in re.findall(r"<style\b[^>]*>(.*?)</style>", html, flags=re.S | re.I):
        for m in CSS_OPACITY_ZERO_RULE.finditer(style):
            for sel in m.group(1).split(","):
                sel = sel.strip()
                if sel and not sel.startswith("@"):
                    hidden.add(sel)
    for cls in CLASS_ATTR.findall(html):
        tokens = cls.split()
        if "opacity-0" not in tokens:
            continue
        hidden.update(f".{t}" for t in tokens if not t.startswith("opacity-"))
    return hidden


def _selector_hidden(selector, hidden):
    """Whether animate()'s selector targets an element that is invisible at rest.

    Compared on the selector's trailing simple part: `#hero .hero-letter` and `.hero-letter`
    must both match a `.hero-letter { opacity: 0 }` rule.
    """
    tail = selector.strip().split()[-1] if selector.strip() else ""
    if not tail:
        return False
    for h in hidden:
        h_tail = h.strip().split()[-1] if h.strip() else ""
        if h_tail and (h_tail == tail or tail.endswith(h_tail) or h_tail.endswith(tail)):
            return True
    return False


def _call_args(text, open_paren):
    """Substring between the paren at `open_paren` and its match; '' when unbalanced."""
    depth = 0
    for i in range(open_paren, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren + 1:i]
    return ""


def chk_motion_fill_forwards(html):
    """A motion `animate()` fading in an element that is invisible at rest needs `fill: 'forwards'`.

    The Web Animations API defaults to `fill: 'none'`: when the animation finishes its inline
    styles are dropped and the element falls back to whatever CSS declares. That only breaks
    things when the resting state hides the element (`opacity: 0` rule or `opacity-0` class) --
    the element then plays once and disappears, with no error. Targets with no such resting
    state fall back to a visible default and are fine.
    """
    m = MOTION_BLOCK.search(html)
    if not m:
        return []
    body = m.group(1)
    hidden = _hidden_at_rest(html)
    if not hidden:
        return []
    bad = []
    for call in MOTION_ANIMATE_CALL.finditer(body):
        args = _call_args(body, call.end() - 1)
        if not args or not MOTION_OPACITY_FROM_ZERO.search(args):
            continue
        if MOTION_FILL_FORWARDS.search(args):
            continue
        sel_match = MOTION_SELECTOR.match(args)
        if sel_match and _selector_hidden(sel_match.group(1), hidden):
            bad.append(sel_match.group(1))
    if not bad:
        return []
    return [
        f"motion animate() fades in {', '.join(bad[:3])} from opacity 0 without "
        "`fill: 'forwards'`, and the target is hidden at rest — the Web Animations API drops its "
        "inline styles when the animation ends, so the element falls back to opacity 0 and "
        "disappears after playing once. Add `fill: 'forwards'` to the options object"
    ]


def chk_motion_window_timing(html):
    """Catch `const {animate,...} = window` placed outside the motion:ready callback.

    motion's functions reach `window` only after the deferred `<script type="module">` finishes
    importing. A destructure at the top of the MOTION-SCRIPT block therefore binds undefined, and
    every later call throws inside the event handler -- silently, since the throw happens in a
    listener. Symptom: every element that starts at `opacity-0` waiting for an entrance animation
    stays invisible, so the page reads as blank while the HTML and CSS are both fine.
    """
    m = MOTION_BLOCK.search(html)
    if not m:
        return []
    body = m.group(1)
    # Text before the first motion:ready listener is the block's synchronous top level.
    listener = re.search(r"addEventListener\s*\(\s*['\"]motion:ready['\"]", body)
    top_level = body[: listener.start()] if listener else body
    if not MOTION_TOPLEVEL_DESTRUCTURE.search(top_level):
        return []
    return [
        "MOTION-SCRIPT destructures motion helpers from `window` at the block's top level, before "
        "the deferred module assigns them — they bind undefined, animate() throws, and opacity-0 "
        "elements stay invisible. Move the destructure inside the motion:ready callback."
    ]


NONVOID_SELF_CLOSING = re.compile(
    r"<(span|div|p|a|button|section|article|main|header|footer|nav|ul|ol|li"
    r"|h[1-6]|em|strong|i|b|u|s|label|form|select|textarea|option|table|thead"
    r"|tbody|tfoot|tr|td|th|figure|figcaption|aside|blockquote|dl|dt|dd|small"
    r"|sup|sub|code|pre|video|audio|canvas|details|summary|dialog|iframe)\b[^<>]*/>",
    re.I,
)


class _DupAttrCollector(HTMLParser):
    """Collect start tags carrying the same attribute name more than once.

    HTMLParser keeps every occurrence in its attrs list (it does not de-duplicate), and it
    treats script/style bodies as CDATA, so JS strings holding "<div ...>" are not parsed
    as tags and cannot produce a false hit.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hits = []

    def handle_starttag(self, tag, attrs):
        names = [name for name, _ in attrs]
        for name in dict.fromkeys(names):
            if names.count(name) < 2:
                continue
            values = [v if v is not None else "" for k, v in attrs if k == name]
            self.hits.append((self.getpos()[0], tag, name, values))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def chk_duplicate_attr(html):
    """One start tag must never carry the same attribute twice.

    The HTML spec forbids it, and the tokenizer's error recovery keeps the FIRST occurrence and
    silently drops every later one. Nothing surfaces: the browser logs no error and the page
    renders. But a second `id=` never lands, so `getElementById` on that value returns null and
    the first statement touching it throws — killing the rest of that script block, which usually
    takes unrelated interactions (forms, drawers, banners) down with the animation. A dropped
    second `class=` silently loses a whole set of styles instead.

    Typical origin: one element serves two roles (scroll-scaled wrapper AND pointer hit area) and
    the id for the second role gets appended without noticing the tag already has one. Give the
    roles two nested elements, or reuse the single existing id.
    """
    parser = _DupAttrCollector()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        # Malformed markup is html-integrity's business; never crash the whole report here.
        return []
    out = []
    for line, tag, name, values in parser.hits:
        kept, dropped = values[0], values[1:]
        if name == "id":
            impact = ("the dropped id never lands, so getElementById returns null and the first"
                      " statement touching it throws — everything after it in that script block"
                      " never runs")
        elif name == "class":
            impact = "the dropped class list is lost, so that whole set of styles never applies"
        else:
            impact = f"the dropped {name} value has no effect"
        out.append(
            f"L{line} <{tag}> carries {name}= {len(values)} times ({name}=\"{kept}\" is kept,"
            f" {', '.join(f'{name}=\"{v}\"' for v in dropped)} is dropped by the browser)."
            f" Duplicate attributes are invalid HTML and fail silently: {impact}."
            " Keep one attribute per tag — give the two roles two nested elements, or reuse the"
            " single existing value"
        )
    return out


def chk_self_closing(html):
    """Flag JSX-style self-closing tags on non-void HTML elements (browser ignores the `/`)."""
    out = []
    for m in NONVOID_SELF_CLOSING.finditer(html):
        line = html.count("\n", 0, m.start()) + 1
        snippet = m.group(0)
        if len(snippet) > 72:
            snippet = snippet[:69] + "..."
        out.append(
            f"L{line} JSX-style self-closing tag {snippet}"
            f" (in HTML the / in <{m.group(1).lower()}/> is ignored by the browser, the tag stays open,"
            " and all following content gets swallowed into that element, wrecking the layout;"
            " use a matching pair of tags instead)"
        )
    return out


RULES = [
    ("tailwind-v3-pinned",   "error", False, chk_tailwind_version),
    ("self-contained",       "error", False, chk_local_refs),
    ("stamp-required",       "error", False, chk_stamp),
    ("design-tokens-block",  "error", False, chk_tokens_block),
    ("html-integrity",       "error", False, chk_html_integrity),
    ("section-ids",          "error", False, chk_section_ids),
    ("duplicate-attr",       "error", False, chk_duplicate_attr),
    ("no-jsx-self-closing",  "error", False, chk_self_closing),
    ("svg-foreign-content",  "error", False, chk_svg_foreign_content),
    # ("fonts-from-library", "error", False, chk_font_library),
    #   Disabled as a hard gate: a font served from outside the two BOS directories is not
    #   automatically wrong, and blocking on the domain alone rejected legitimate third-party
    #   sources. The rule stays in the docs as a prose requirement, and chk_font_library() is kept
    #   so re-enabling is a one-line change. What is still enforced is font-url-published: if the
    #   address IS one of our BOS font directories, the filename has to be one we publish.
    ("font-url-published",   "error", True,  chk_font_url_published),
    ("font-registration",   "error", False, chk_font_face_required),
    ("no-base64-image",      "error", False, chk_base64_img),
    ("assets-in-markup",     "error", False, chk_assets_in_markup),
    ("no-clearing-markup",   "error", False, chk_no_clearing_markup),
    ("min-text-size",        "error", False, chk_tiny_text),
    ("spacing-scale",        "error", False, chk_spacing_scale),
    ("config-integrity",     "error", False, chk_config_integrity),
    ("config-js-syntax",     "error", False, chk_config_js_syntax),
    ("keyframes-wired",      "error", False, chk_keyframes_wired),
    ("intersect-start-state", "error", False, chk_intersect_start_state),
    ("motion-window-timing", "error", False, chk_motion_window_timing),
    ("motion-fill-forwards", "error", False, chk_motion_fill_forwards),
    ("color-fn-double-wrap", "error", False, chk_color_fn_double_wrap),
    ("token-contrast",       "error", False, chk_token_contrast),
    ("no-inline-hex",        "error", True,  chk_inline_hex),
    ("no-direct-palette",    "error", True,  chk_direct_palette),
    ("no-gradient-text",     "error", True,  chk_gradient_text),
    ("no-purple-gradient",   "error", True,  chk_purple_gradient),
    ("no-lorem",             "error", True,  chk_lorem),
    ("no-emoji-icons",       "error", True,  chk_emoji_icons),
]


def _rewrite_class_attrs(html, repl):
    """Apply `repl` to the value of every class attribute, leaving the rest of the file untouched.

    A fix must never reach further than the check that motivated it. The rules read `class_text()`,
    i.e. class attribute values only, so a `text-[10px]` sitting in an HTML comment, in prose, in a
    JS string or behind `@apply` inside <style> is something no rule objected to -- rewriting it
    would silently edit bytes the author never asked about (and, for a draft whose only occurrence
    is in a comment, `--fix` would rewrite a file that passes).

    Substitution goes through the match's span, not `str.replace` on the matched attribute: a short
    class value that also occurs in the literal `class="` prefix (`class="a"`) would otherwise be
    replaced in the wrong place and corrupt the attribute name.
    """
    out, last = [], 0
    for m in CLASS_ATTR.finditer(html):
        start, end = m.span(1)
        out.append(html[last:start])
        out.append(repl(m.group(1)))
        last = end
    out.append(html[last:])
    return "".join(out)


def fix_tiny_text(html):
    """Clamp every `text-[<N>px]` below the readability floor up to `text-[12px]`."""
    hit = []

    def repl(m):
        if int(m.group(1)) >= 12:
            return m.group(0)
        hit.append(m.group(0))
        return "text-[12px]"

    return _rewrite_class_attrs(html, lambda v: re.sub(r"text-\[(\d+)px\]", repl, v)), hit


# Rules admitted here must have exactly ONE compliant output, so applying the repair cannot make a
# design decision on the author's behalf. That excludes anything needing a choice: which semantic
# token replaces `bg-blue-500`, which copy replaces lorem, which adjacent step replaces `h-13`.
# Those stay manual `str_replace_editor` edits, however many occurrences there are.
MECHANICAL_FIXES = {
    "min-text-size": fix_tiny_text,
    "token-contrast": fix_token_contrast,
    "svg-foreign-content": fix_svg_foreign_content,
}


def _draft_status(path):
    """The status the platform recorded for this draft in its own directory's manifest.

    Read per file, not per run: `--fix` may be handed several drafts at once and only some of
    them sealed. Returns "" when there is no manifest (standalone / local debugging) or the
    draft is not registered, which keeps those cases behaving exactly as before.
    """
    try:
        manifest = json.loads((path.parent / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(manifest, dict) or not isinstance(manifest.get("drafts"), list):
        return ""
    for entry in manifest["drafts"]:
        if isinstance(entry, dict) and \
                str(entry.get("path") or "").rsplit("/", 1)[-1] == path.name:
            return normalize_status(entry.get("status"))
    return ""


def apply_fixes(paths):
    """Apply every registered mechanical repair in place; return one record per file.

    Reads and writes with newline="" so the file's own line endings survive: universal-newline mode
    would decode CRLF to LF and write LF back, rewriting every line in a file whose only real defect
    was one class value.

    Sealed drafts are skipped rather than rewritten. The platform write-protects them and the
    dead-archive model says a delivered draft never changes, but its guard hook watches tool calls
    (str_replace_editor / rm) -- it cannot see this script's own `open(..., "w")`. So the guard has
    to live here. Until `token-contrast` landed this barely mattered because `--fix` almost never
    had anything to do; it now rewrites ~11% of drafts, which is enough exposure to matter.
    """
    records = []
    for p in paths:
        path = Path(resolve_input_path(p))
        if not path.exists():
            continue
        status = _draft_status(path)
        if is_sealed(status):
            records.append({
                "file": path.name,
                "skipped": status,
                "reason": sealed_draft_advice(status, path.name),
            })
            continue
        with open(path, encoding="utf-8", newline="") as f:
            html = original = f.read()
        applied = {}
        for rule, fn in MECHANICAL_FIXES.items():
            html, hit = fn(html)
            if hit:
                applied[rule] = {"count": len(hit), "replaced": sorted(set(hit))}
        if html != original:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(html)
            records.append({"file": path.name, "applied": applied})
    return records


def check_file(path, report):
    """Run every rule against one draft file and append its entry to report."""
    html = Path(path).read_text(encoding="utf-8")
    waivers = {name: reason for name, reason in DISABLE.findall(html)}
    entry = {"file": str(path), "errors": [], "warnings": [], "waived": []}
    for name, severity, waivable, fn in RULES:
        issues = fn(html)
        if not issues:
            continue
        if name in waivers and waivable:
            entry["waived"].append({"rule": name, "reason": waivers[name], "issues": issues})
            continue
        if name in waivers and not waivable:
            issues = [f"(this rule is not waivable) {i}" for i in issues]
        entry["errors" if severity == "error" else "warnings"].extend(f"[{name}] {i}" for i in issues)
    m = STAMP.search(html)
    entry["title"] = m.group(1).strip() if m else None
    entry["skeleton"] = m.group(2).strip() if m else None
    entry["sig"] = m.group(3).strip() if m else None
    report["files"].append(entry)
    return entry


def check_multi_diversity(entries, report):
    """Multi-draft (>=2, typically the first round's three) anti-reskinning gate: sigs must differ.

    Only sig is checked, the one deterministically judgeable signal of "same template copied N
    times with new copy". No aesthetic verdict on palette / font / skeleton spread -- whether the
    vibe should diverge depends on which axes the user's query pinned down, which a rule cannot
    decide; structural spread is left to the differentiation engine's five-axis matrix and the
    model's own discipline.
    """
    def _norm_sig(s):
        return re.sub(r"\s+", "", s or "").lower()

    sigs = [(e["file"], _norm_sig(e.get("sig"))) for e in entries if _norm_sig(e.get("sig"))]
    seen, dups = {}, []
    for f, s in sigs:
        if s in seen:
            dups.append(f"{Path(seen[s]).name} and {Path(f).name} have the same sig")
        else:
            seen[s] = f
    if dups:
        report["signature_diversity"] = (
            f"Duplicate sig: {dups} — each draft must have its own unique elevated craft detail;"
            " identical sigs mean only the skin changed, not the soul."
            " Rewrite the signature of one of the drafts"
        )


DIVERSITY_KEYS = ("signature_diversity",)

# Every blocking entry carries a repair instruction, not only a diagnosis. Traces show that a
# reason stating just what is wrong gets read as "start over": one run answered a long blocking
# list with `rm -f` on three drafts, another spent a whole round budget rebuilding a draft for
# four in-place edits. The default says the fix is local; the overrides cover the rules where a
# local edit is not what is being asked for.
DEFAULT_FIX = ("Fix in place in this same draft with str_replace_editor, then re-run this script "
               "on the draft. Do not delete the draft, do not create a new one.")
FIX_HINTS = {
    "token-contrast": ("Re-run with `--fix <draft>`: per CSS scope it flips the paired "
                       "`*-foreground` token to white, near-black or black -- whichever clears "
                       "4.5:1 against that scope's own background. The brand colour in "
                       "`--primary` / `--background` is never touched, and a `.dark {}` branch is "
                       "repaired independently of `:root`."),
    "svg-foreign-content": ("Try `--fix <draft>` first: it renames a `<span>` inside an SVG "
                            "`<text>` to `<tspan>`, and deletes an attribute-less stray tag that "
                            "has no closing tag. Anything it leaves behind needs a decision — "
                            "drop the tag, or wrap that markup in `<foreignObject>`. Never just "
                            "add a `</svg>`: the parser already discarded the one that was there."),
    "signature_diversity": ("Rework one draft's signature so the drafts differ from each other; "
                            "deleting a draft does not resolve this."),
    "design-tokens-block": ("Repair the marker comment lines in place; keep the block contents. "
                            "Do not delete the draft."),
    "min-text-size": ("Dozens of occurrences are normal: re-run this script with `--fix <draft>` to "
                      "clamp every one of them to text-[12px] in place (the same run re-checks the "
                      "file). Never reach for sed / heredoc / a whole-file rewrite."),
    "file": "Check the path: it is resolved against the app root, not the current shell directory.",
}

def _manifest_path(report):
    """Path of manifest.json in the design dir the checked drafts live in.

    Derived from the checked files rather than from the app root, so a run against an
    unrelated directory (local debugging) never touches an app's manifest. Returns None
    when the checked files do not share one directory.
    """
    dirs = {str(Path(e["file"]).parent) for e in report["files"] if e.get("file")}
    if len(dirs) != 1:
        return None
    return Path(dirs.pop()) / MANIFEST_FILENAME


def _verdicts(report):
    """Per-file pass verdict: error-free and not held back by a cross-draft gate.

    A cross-draft failure (duplicate sig) cannot be attributed to one draft, so it holds
    back every draft in the run -- matching what the engineering hook did when it read
    this report from stdout.
    """
    cross_draft_block = any(
        b.get("file") not in {Path(e["file"]).name for e in report["files"]}
        for b in report["blocking"]
    )
    return {
        Path(e["file"]).name: (e.get("error_count") == 0 and not cross_draft_block)
        for e in report["files"]
    }


def update_manifest(report):
    """Write this run's verdicts into manifest.json, in place, next to the drafts.

    The engineering side owns registration (designId / parent_ids / next_id / appType) and
    the frontend signal; this script owns exactly one thing -- turning a verdict into
    `status` + `check_failed`. It only touches drafts already registered: an unregistered
    draft has no id to key off, and it could not have passed anyway (its stamp is still the
    placeholder new_draft.py wrote). Doing this in-process is the point: a `--check` further
    down the same shell command sees the result immediately, no matter how the model piped
    or chained the commands.

    Silent no-op when the manifest is absent (standalone/local runs) or unreadable -- the
    engineering round-end sweep re-runs this checker for drafts still left at generating.
    """
    path = _manifest_path(report)
    if path is None or not path.is_file():
        return
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(manifest, dict) or not isinstance(manifest.get("drafts"), list):
        return

    now = _now_iso()
    verdicts = _verdicts(report)
    by_name = {}
    for entry in manifest["drafts"]:
        if isinstance(entry, dict):
            by_name[str(entry.get("path") or "").rsplit("/", 1)[-1]] = entry

    changed = False
    for filename, passed in verdicts.items():
        entry = by_name.get(filename)
        if entry is None:
            continue
        if is_stopped(entry.get("status")):
            # The platform sealed this draft when the round was aborted, without ever checking
            # it. Sealed in both directions on purpose: flipping it to ready here would show a
            # "已中止" card as ready and, worse, make a draft the platform never validated
            # through its own flow eligible for build / applyToApp (those scenes require ready).
            # Continuing a stopped draft goes through new_draft.py --from, which produces a
            # normal generating draft that this function does update.
            continue
        if passed:
            fields = {"status": STATUS_READY, "check_failed": False, "reason": None}
            stamp_title = next(
                (e.get("title") for e in report["files"]
                 if Path(e["file"]).name == filename and e.get("title")),
                None,
            )
            if stamp_title:
                fields["title"] = stamp_title
        elif normalize_status(entry.get("status")) == STATUS_GENERATING:
            fields = {"check_failed": True}
        else:
            # Already sealed (ready/failed): a later failing run must not un-seal it
            continue
        if all(entry.get(k) == v for k, v in fields.items()):
            continue
        entry.update(fields)
        entry["updated_at"] = now
        changed = True

    if not changed:
        return
    # Atomic replace: a torn write would leave the engineering side without its registry
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def _now_iso():
    """UTC timestamp in the same shape the engineering side writes (seconds precision)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def list_rules():
    """Print the complete enforced rule set, generated from the RULES table.

    Traces show the model otherwise guesses the checker's scope, or reverse-engineers it from
    whichever sibling draft happened to pass — turning one lucky draft into the de-facto spec.
    Generated, never hand-maintained: a prose list in the docs drifted to covering 8 of 28 rules.
    """
    payload = {
        "single_draft_rules": [
            {"name": name, "severity": severity, "waivable": waivable,
             "auto_fixable": name in MECHANICAL_FIXES}
            for name, severity, waivable, _fn in RULES
        ],
        "multi_draft_rules": [
            {"name": key, "severity": "error", "waivable": False,
             "note": "only runs when 2+ drafts are passed to one invocation"}
            for key in DIVERSITY_KEYS
        ],
        "waiver_syntax": "<!-- miaoda-design-disable <rule-name>: <reason> -->  (waivable rules only)",
        "error_prefix": "every error line begins with [<rule-name>] using exactly these names",
        "auto_fix": "`--fix <draft>` repairs the auto_fixable rules in place, then checks; the rest "
                    "need real str_replace_editor edits however many occurrences there are",
        "scope": "all rules apply to every draft, including P5 page drafts",
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main():
    """CLI entry: run all rules against the given HTML files and print a JSON report."""
    paths = sys.argv[1:]
    if "--list-rules" in paths:
        list_rules()
        sys.exit(0)
    fix_mode = "--fix" in paths
    paths = [p for p in paths if not p.startswith("--")]
    if not paths:
        print(__doc__)
        sys.exit(2)
    report = {"ok": True, "blocking": [], "files": []}
    if fix_mode:
        # Fix first, then check the rewritten files in the same run, so the report always describes
        # what is on disk now. Kept inside the report dict rather than printed as a preamble: stdout
        # must stay parseable as a single JSON document.
        report["fixed"] = apply_fixes(paths)
        report["fixable_rules"] = sorted(MECHANICAL_FIXES)
    entries = []
    for p in paths:
        resolved = resolve_input_path(p)
        if not Path(resolved).exists():
            report["files"].append(
                {"file": p, "errors": [f"File does not exist: {p} (resolved to {resolved})"],
                 "warnings": [], "waived": []}
            )
            continue
        entries.append(check_file(resolved, report))

    if len(entries) >= 2:
        check_multi_diversity(entries, report)

    # blocking is the sole source of failure reasons; files[] keeps only identifiers and
    # waiver records, not duplicated errors text.
    #
    # The per-rule fix hints all describe an in-place edit. On a draft the platform sealed that
    # advice is unexecutable, and the report used to contradict itself inside one document: `--fix`
    # answered "sealed, must not be edited in place, continue with new_draft.py" while every
    # blocking entry in the same JSON said "fix in place ... do not create a new one". The sealed
    # status wins -- there is exactly one legal move on such a draft.
    sealed_by_file = {}
    for e in report["files"]:
        if e.get("file"):
            name = Path(e["file"]).name
            status = _draft_status(Path(e["file"]))
            if is_sealed(status):
                sealed_by_file[name] = status
    for e in report["files"]:
        for err in e.get("errors", []):
            rule = err.split("]", 1)[0].lstrip("[") if err.startswith("[") else "file"
            name = Path(e["file"]).name
            fix = (sealed_draft_advice(sealed_by_file[name], name) if name in sealed_by_file
                   else FIX_HINTS.get(rule, DEFAULT_FIX))
            report["blocking"].append({"rule": rule, "file": name, "reason": err, "fix": fix})
    for key in DIVERSITY_KEYS:
        if key in report:
            report["blocking"].append({"rule": key, "file": "<multi-draft>", "reason": report[key],
                                       "fix": FIX_HINTS.get(key, DEFAULT_FIX)})

    report["ok"] = not report["blocking"]
    for e in report["files"]:
        e["error_count"] = len(e.pop("errors", []))
        e.pop("warnings", None)
        if not e.get("waived"):
            e.pop("waived", None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    update_manifest(report)
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
