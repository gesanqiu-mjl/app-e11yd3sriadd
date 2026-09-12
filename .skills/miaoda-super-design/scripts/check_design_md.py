#!/usr/bin/env python3
"""miaoda-super-design: DESIGN.md consistency validation (standard library only).

Usage:
    python3 check_design_md.py docs/DESIGN.md --index-css src/index.css [--src src/]

Checks:
1. Front matter exists and contains a tokens section;
2. Token values are bare HSL triplets (radius is a length value);
3. Consistency with src/index.css, variable by variable (every token declared
   in DESIGN.md must exist in index.css with the same value);
4. Section order: Overview → Colors → Typography → Layout → Components →
   Do's and Don'ts (sections may be omitted but not reordered);
5. Contrast: foreground/background and primary-foreground/primary must be
   >= 4.5:1 (WCAG AA text tier — a button label is text, so it does not drop
   to the 3:1 tier that covers large text and non-text UI parts). A failure
   names the paired *-foreground as the variable to change, so a locked brand
   color never has to be touched;
6. When `--src` is given: front matter's `section_blueprint` is compared
   section-by-section against the React code — for each `id`,
   the root element's className must cover every class listed in the
   blueprint. A miss is a warning (a lost visual baseline, which should be
   fixed rather than waived by default).
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Value formats, the length rule and the CSS declaration parser are shared with the emitter that
# writes this file's input: any divergence means DESIGN.md gets rejected for containing exactly
# what apply_design_tokens.py just produced. Both scripts always ship together in scripts/.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apply_design_tokens as adt  # noqa: E402
# Contrast maths is shared with the draft-time gate (check_design_quality.py) via core.py: if the
# two disagree by a decimal, a draft passes P2 and only fails here -- at which point it is sealed
# and the only legal repair is a whole extra draft file.
from core import best_extreme_foreground, contrast_ratio  # noqa: E402

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

    CWD is unreliable — the engineering side may run bash from the app's parent
    directory (e.g. `/workspace`), where `app-<id>` is a *child* of CWD and
    walking up never reaches it. The script itself is deployed under
    `<app-root>/.skills/miaoda-super-design/scripts/`, so `__file__` always has
    `app-<id>` among its ancestors, making it a sturdier anchor than CWD. Only
    when both probes fail (local debugging, or the skill living outside an app)
    do we fall back to CWD.
    """
    hit = _walk_up_for_app(os.getcwd())
    if hit:
        return hit
    hit = _walk_up_for_app(os.path.dirname(os.path.abspath(__file__)))
    if hit:
        return hit
    return os.path.abspath(os.getcwd())


def resolve_input_path(arg):
    """Keep absolute paths as-is; resolve relative paths against the app root
    (not CWD, since CWD may be the app's parent directory)."""
    if os.path.isabs(arg):
        return os.path.abspath(arg)
    return os.path.join(find_app_root(), arg)


HSL_TRIPLET = adt.HSL_TRIPLET
SECTION_ORDER = ["Overview", "Colors", "Typography", "Layout", "Components", "Do's and Don'ts"]
NON_COLOR = adt.NON_COLOR
# "HSL triplet / alpha" — the form apply_design_tokens.py normalizes rgba()/#RRGGBBAA into.
ALPHA_SUFFIX = re.compile(r"\s*/\s*[0-9.]+%?$")


def token_value_issue(name, value):
    """Judge one DESIGN.md token value -> (report key, message) or None.

    The acceptance set must match what `apply_design_tokens.py --emit-designmd-tokens` can
    legitimately produce, otherwise conversion stalls on the script's own output: besides bare
    HSL triplets that is "triplet / alpha", gradients, font stacks, easing curves and any other
    structurally intact CSS value. Only a malformed value is an error here; a color written in
    a non-normalized format means the front matter was hand-copied instead of pasted, which is
    worth a warning because the emitter would have converted it.
    """
    value = str(value).strip()
    if name in NON_COLOR:
        if not adt._valid_length_value(value):
            return "errors", f"--{name}: invalid length value '{value}'"
        return None
    if HSL_TRIPLET.match(ALPHA_SUFFIX.sub("", value)):
        return None
    if not adt._structurally_valid_css_value(value):
        return "errors", f"--{name}: value '{value}' is malformed (unbalanced parentheses or quotes)"
    if (adt.HEX_COLOR.match(value) or adt.HEX_COLOR_ALPHA.match(value)
            or adt.RGB_FUNC.match(value) or adt.HSL_FUNC.match(value)):
        return "warnings", (
            f"--{name}: color '{value}' is not a bare HSL triplet — paste the "
            "apply_design_tokens.py --emit-designmd-tokens output instead of hand-copying values")
    return None  # gradient / font stack / easing curve: legitimate emitter output

# JSX section parsing: regex cannot handle JSX (attribute values / expressions
# contain `>` and nested `{}`), so we use a state machine instead.
JSX_SECTION_OPEN = re.compile(r"<(?:section|header|footer|nav|aside|main)\b", re.I)
# id="X": negative lookbehind excludes data-xxx-id / aria-id etc.
# (hyphens count as word boundaries, so a plain \bid would match `data-section-id`).
JSX_SECTION_ID = re.compile(r'(?<![\w-])id\s*=\s*["\']([^"\']+)["\']')
STRING_LITERAL = re.compile(r"[\"'`]([^\"'`]*)[\"'`]")


def _jsx_tag_end(code, start):
    """From after `<section`, scan to the opening tag's `>`, skipping string
    literals and `{}` expressions (which may themselves contain `>`)."""
    i, n, quote, depth = start, len(code), None, 0
    while i < n:
        ch = code[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        elif ch == ">" and depth == 0:
            return i
        i += 1
    return -1


def _extract_classnames(attrs):
    """Collect every class token in className from a <section> attribute string.

    Supports className="..." / className={`...`} / className={cn("a", cond && "b")}.
    For the expression form: after finding `className={`, slice the whole
    brace-balanced expression and pull out every string literal inside it.
    """
    classes = set()
    for m in re.finditer(r"className\s*=\s*", attrs):
        j = m.end()
        if j >= len(attrs):
            break
        if attrs[j] in ("'", '"', "`"):
            sm = STRING_LITERAL.match(attrs, j)
            if sm:
                classes.update(sm.group(1).split())
        elif attrs[j] == "{":
            depth, k, quote = 0, j, None
            while k < len(attrs):
                c = attrs[k]
                if quote:
                    if c == quote:
                        quote = None
                elif c in ("'", '"', "`"):
                    quote = c
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            expr = attrs[j:k + 1]
            for sm in STRING_LITERAL.finditer(expr):
                classes.update(sm.group(1).split())
    return classes


def jsx_section_classes(src_dir):
    """Scan src/**/*.tsx and return {section_id: {"classes": set}}.

    Section root elements are identified by id="X"; that same id doubles as the
    in-page anchor target for <a href="#X"> nav links (no separate tracing attr).
    All three className forms are collected (literal / template / cn(...)) —
    for expressions, every string literal inside is merged in.
    """
    found = {}
    for path in sorted(Path(src_dir).rglob("*.tsx")):
        try:
            code = path.read_text(encoding="utf-8")
        except Exception:
            continue
        for om in JSX_SECTION_OPEN.finditer(code):
            end = _jsx_tag_end(code, om.end())
            if end < 0:
                continue
            attrs = code[om.end():end]
            sid_m = JSX_SECTION_ID.search(attrs)
            if not sid_m:
                continue
            sid = sid_m.group(1)
            classes = _extract_classnames(attrs)
            entry = found.setdefault(sid, {"classes": set()})
            entry["classes"].update(classes)
    return found


def check_section_blueprint(blueprint, src_dir, report):
    """Every class in the blueprint must appear on the root element of the
    same-named React section."""
    actual = jsx_section_classes(src_dir)
    if not actual:
        report["warnings"].append(
            f"No <section id=...> found under {src_dir}——"
            "every React section root element must keep id= "
            "(it identifies the section and doubles as the nav anchor target)")
        return
    for sid, cls_str in blueprint.items():
        want = set(cls_str.split())
        if not want:
            continue
        if sid not in actual:
            report["warnings"].append(
                f'section_blueprint["{sid}"]: no matching <section id="{sid}"> found in React code'
                " (nav <a href=\"#" + sid + "\"> will jump to page top)")
            continue
        entry = actual[sid]
        missing = sorted(want - entry["classes"])
        if missing:
            report["warnings"].append(
                f'section_blueprint["{sid}"]: React root element is missing {" ".join(missing)}'
                "——top-level visual classes lost for this section (background/text/border), "
                "visual baseline mismatch")


def _yaml_scalar_value(raw):
    """Read one front-matter scalar: quoted (double or single) or plain with a trailing comment.

    emit_designmd quotes token values, and a value may legally contain `#` (hex color) or `"`
    (`url("data:...")`). Stripping quotes with a blunt `.strip('"')` or cutting at the first `#`
    corrupted exactly those values, so quoting is honoured first and only an unquoted value can
    carry a trailing comment.
    """
    v = raw.strip()
    if len(v) >= 2 and v[0] == '"':
        end = v.rfind('"')
        if end > 0:
            return v[1:end].replace('\\"', '"')
    if len(v) >= 2 and v[0] == "'":
        end = v.rfind("'")
        if end > 0:
            return v[1:end].replace("''", "'")
    return v.split("#", 1)[0].strip()


def parse_front_matter(text):
    """Parse the YAML-like front matter block into a nested dict (top-level scalars + one-level nesting)."""
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return None
    fm, current = {}, None
    for line in m.group(1).splitlines():
        if re.match(r"^\S", line):
            key = line.split(":", 1)[0].strip()
            rest = line.split(":", 1)[1].strip() if ":" in line else ""
            if rest and not rest.startswith("#"):
                fm[key] = _yaml_scalar_value(rest)
                current = None
            else:
                fm[key] = {}
                current = key
        elif current is not None and ":" in line:
            k, v = line.strip().split(":", 1)
            v = _yaml_scalar_value(v)
            if k.strip() and v:
                fm[current][k.strip()] = v
    return fm


def main():
    """CLI entry: validate DESIGN.md tokens/order/contrast, optionally against index.css and src/."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("design_md", help="DESIGN.md path")
    ap.add_argument("--index-css", help="src/index.css path (for per-variable consistency validation)")
    ap.add_argument("--src", help="src/ path (validate section_blueprint against React code)")
    args = ap.parse_args()

    report = {"ok": True, "errors": [], "warnings": []}
    design_md_arg = resolve_input_path(args.design_md)
    path = Path(design_md_arg)
    if not path.exists():
        report["errors"].append(f"File does not exist: {path}")
        _finish(report)
    text = path.read_text(encoding="utf-8")

    fm = parse_front_matter(text)
    if fm is None:
        report["errors"].append("Missing front matter (YAML header enclosed by ---)")
        _finish(report)
    tokens = fm.get("tokens") if isinstance(fm.get("tokens"), dict) else None
    if not tokens:
        report["errors"].append(
            "front matter is missing the tokens section (should be generated by "
            "apply_design_tokens.py --emit-designmd-tokens)")
        _finish(report)
    customs = fm.get("custom_tokens") if isinstance(fm.get("custom_tokens"), dict) else {}
    if "name" not in fm:
        report["warnings"].append("front matter is missing name (should match the manifest title)")

    all_tokens = {**tokens, **customs}
    for name, value in all_tokens.items():
        issue = token_value_issue(name, value)
        if issue:
            report[issue[0]].append(issue[1])

    if args.index_css:
        css_path = Path(resolve_input_path(args.index_css))
        if not css_path.exists():
            report["errors"].append(f"index.css does not exist: {css_path}")
        else:
            css = css_path.read_text(encoding="utf-8")
            # Shared parser: previously injected custom tokens sit after the custom marker but
            # are still :root variables, so both halves count as declared.
            _ro, root_map, _do, _dm, registered = adt.parse_index_css(css)
            css_root = {k: re.sub(r"\s+", " ", v.strip()) for k, v in {**root_map, **registered}.items()}
            for name, value in all_tokens.items():
                if name.startswith("dark-"):
                    continue
                if name not in css_root:
                    report["errors"].append(
                        f"--{name}: present in DESIGN.md but not in index.css :root (injection missed?)")
                elif css_root[name] != re.sub(r"\s+", " ", value.strip()):
                    report["errors"].append(
                        f"--{name}: DESIGN.md='{value}' does not match index.css='{css_root[name]}'")

    body = text.split("---", 2)[-1]
    found = [(body.index(f"## {s}"), s) for s in SECTION_ORDER if f"## {s}" in body]
    if [s for _, s in sorted(found)] != [s for _, s in found]:
        report["errors"].append(
            f"Sections out of order: expected {' → '.join(SECTION_ORDER)} (may be omitted but not reordered)")
    if not found:
        report["warnings"].append("No standard section found in the body (Overview/Colors/…)")

    # Button labels count as text, so both pairs sit on the 4.5:1 tier -- the same tiering the
    # application-side design-system prompt states (large text and non-text UI parts get 3:1, and
    # neither of these token pairs describes those).
    pairs = [("foreground", "background", "body text"),
             ("primary-foreground", "primary", "primary button label")]
    for fg, bg, label in pairs:
        if fg in tokens and bg in tokens:
            ratio = contrast_ratio(tokens[fg], tokens[bg])
            if ratio is not None and ratio < 4.5:
                msg = f"{label} contrast {fg}/{bg} = {ratio:.2f}:1 < 4.5:1 (WCAG AA)"
                best = best_extreme_foreground(tokens[bg])
                if best:
                    msg += (f". Keep --{bg} and change --{fg}: {best[0]} on it gives {best[1]:.2f}:1"
                            f". Fix it in the draft's DESIGN-TOKENS block and re-run"
                            f" apply_design_tokens.py -- do not hand-edit src/index.css")
                report["errors"].append(msg)

    if args.src:
        blueprint = fm.get("section_blueprint") if isinstance(fm.get("section_blueprint"), dict) else None
        src_dir = Path(resolve_input_path(args.src))
        if not src_dir.is_dir():
            report["errors"].append(f"--src path does not exist: {src_dir}")
        elif not blueprint:
            report["warnings"].append(
                "front matter is missing section_blueprint (should be extracted by apply_design_tokens.py)")
        else:
            check_section_blueprint(blueprint, src_dir, report)

    _finish(report)


def _finish(report):
    """Print the report as JSON and exit 0 on success, 1 if any error was recorded."""
    report["ok"] = not report["errors"]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
