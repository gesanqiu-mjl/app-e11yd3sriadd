#!/usr/bin/env python3
"""new_draft.py — copy a source draft into auto-numbered files with a placeholder stamp.

Usage:
  python3 new_draft.py --route home --from base --count 3   # first round: derive 3 drafts at once
  python3 new_draft.py --route home --from home-5           # iteration: derive 1 draft from home-5.html

Behaviour:
- Scan tasks/design/{route}-*.html for the highest number N, then emit
  {route}-{N+1..N+count}.html
- Copy the source content verbatim
- Force the top stamp line to a placeholder (check_design_quality.py rejects
  drafts whose stamp is still unfilled)
- Require the round_open flag (run --begin-round first); reject outright when
  drafts already added this round + count exceeds the budget

Exit codes: 0 = success, 1 = bad arguments, 2 = blocked
"""
import argparse
import glob
import json
import os
import re
import sys

# Round bookkeeping lives in core.py. This script used to count "drafts added this round" on its
# own -- files on disk minus the snapshot, with no idea the manifest existed -- and that second
# count is what deadlocked the skill against itself after a user cancel: --check said "continue
# such a draft with new_draft.py --from <it>", and this script answered "3 already added, at most
# 0 more allowed". See the "Round bookkeeping" section in core.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (  # noqa: E402
    default_state_path,
    html_set,
    load_manifest,
    manifest_stopped_filenames,
    split_round_drafts,
)

STAMP_RE = re.compile(r"<!--\s*miaoda-super-design\s*[|·].*?-->", re.S)
PLACEHOLDER_STAMP = (
    "<!-- miaoda-super-design | title: <风格词8字内不含产品名> | "
    "skeleton: <骨架族待填> | sig: <此稿独有细节待填> -->"
)


APP_ROOT_RE = re.compile(r"^app-[\w-]+$")


def enforced_rule_names():
    """Rule names check_design_quality.py enforces, imported from its own table — never hand-copied.

    Handed to the model at the moment it is about to author a draft, because otherwise the scope of
    the checker is unknowable from anything it reads: traces show it inferring the rule set from
    whichever sibling draft happened to pass. Returns None if the checker cannot be imported, so an
    informational line can never block draft creation.
    """
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import check_design_quality as q
        return [name for name, _severity, _waivable, _fn in q.RULES] + list(q.DIVERSITY_KEYS)
    except Exception:
        return None




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


def resolve_design_dir(arg):
    """Resolve --design-dir to an absolute path: keep absolute paths, resolve
    relative ones against the app root.

    Not against CWD — CWD may be `/workspace` while the app root is
    `/workspace/app-<id>`, so resolving against CWD would land outside the app.
    """
    if os.path.isabs(arg):
        return os.path.abspath(arg)
    return os.path.join(find_app_root(), arg)


def find_design_dir():
    """Return this app's tasks/design path (the caller creates it if missing).

    Anchored on the app root; it deliberately does **not** walk up looking for
    an existing tasks/design. On the first round that directory doesn't exist
    yet, and walking up would hit a tasks/design under an ancestor that belongs
    to a different app (or to nobody), so drafts written there would be missing
    from the app directory.
    """
    return os.path.join(find_app_root(), "tasks", "design")


def max_suffix(design_dir, route):
    """Scan {route}-*.html in design_dir and return the highest number (0 if none)."""
    pattern = os.path.join(design_dir, f"{route}-*.html")
    max_n = 0
    for p in glob.glob(pattern):
        name = os.path.basename(p)
        m = re.match(rf"^{re.escape(route)}-(\d+)\.html$", name)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return max_n


def resolve_source(design_dir, from_name):
    """Resolve the source content named by --from.

    --from base: first try assets/base.html two levels above design_dir (i.e.
    tasks/design → tasks/ → <project root>/assets/base.html); when that relative
    layout doesn't hold, fall back to the skill's own copy at
    <skill_dir>/assets/base.html, where skill_dir is derived from this script's
    location (the parent of scripts/).
    Anything else: read design_dir/{from_name}.html (appending .html if absent).
    """
    if from_name == "base":
        # Prefer ../../assets/base.html relative to design_dir
        candidate = os.path.abspath(
            os.path.join(design_dir, "..", "..", "assets", "base.html")
        )
        if os.path.isfile(candidate):
            with open(candidate, encoding="utf-8") as f:
                return f.read(), candidate
        # Fallback: the skill's bundled assets/base.html (this script lives in <skill_dir>/scripts/)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        skill_dir = os.path.dirname(script_dir)
        candidate = os.path.join(skill_dir, "assets", "base.html")
        if os.path.isfile(candidate):
            with open(candidate, encoding="utf-8") as f:
                return f.read(), candidate
        return None, candidate

    filename = from_name if from_name.lower().endswith(".html") else f"{from_name}.html"
    candidate = os.path.join(design_dir, filename)
    if os.path.isfile(candidate):
        with open(candidate, encoding="utf-8") as f:
            return f.read(), candidate
    return None, candidate


def stamp_content(html):
    """Replace the stamp line with the placeholder; if there is no stamp, insert
    one right after <!DOCTYPE html>."""
    if STAMP_RE.search(html):
        return STAMP_RE.sub(PLACEHOLDER_STAMP, html, count=1)
    lines = html.split("\n")
    if lines and lines[0].strip().lower().startswith("<!doctype"):
        lines.insert(1, PLACEHOLDER_STAMP)
    else:
        lines.insert(0, PLACEHOLDER_STAMP)
    return "\n".join(lines)


def stamp_line_no(html):
    """1-indexed line holding the stamp, or None if it is absent.

    Reported to the caller so the model can anchor its stamp edit directly. Traces show it otherwise
    `cat`ing the whole draft (and sometimes grepping first) once per draft just to locate a line the
    copy step itself placed — several full-file reads that buy no information.
    """
    for i, line in enumerate(html.split("\n"), 1):
        if STAMP_RE.search(line):
            return i
    return None


def create_one(design_dir, route, source_bytes):
    """Create a draft atomically: probing for a free number and creating the file
    with O_CREAT|O_EXCL is a single step, so two concurrent processes can never
    both get a handle on the same number — whoever loses simply retries with the
    next one. The earlier "check os.path.exists, then open(...,'w')" had a window
    in between: concurrent calls both saw "number N is free", the later write
    clobbered the earlier one, and a draft was lost. Returns the new filename, or
    None on failure."""
    n = max_suffix(design_dir, route)
    guard = 0
    while guard < 1000:
        n += 1
        guard += 1
        candidate_name = f"{route}-{n}.html"
        candidate_path = os.path.join(design_dir, candidate_name)
        try:
            fd = os.open(candidate_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            continue  # number taken (including false positives on case-insensitive filesystems); try the next
        with os.fdopen(fd, "wb") as f:
            f.write(source_bytes)
        return candidate_name
    return None


def main():
    """CLI entry: validate the round budget, then copy the source draft into new files."""
    ap = argparse.ArgumentParser(
        description="Copy a source draft into the next auto-numbered file with a placeholder stamp."
    )
    ap.add_argument("--route", required=True, help="Page route name, e.g. home")
    ap.add_argument(
        "--from", dest="from_name", required=True,
        help='Source draft: "base" (derive from assets/base.html) or an existing draft name (e.g. home-5)',
    )
    ap.add_argument("--count", type=int, default=1,
                    help="How many drafts to create in one call (first round derives 3 from base at once)")
    ap.add_argument("--design-dir", default=None,
                    help="Draft directory (defaults to tasks/design resolved against the app root)")
    args = ap.parse_args()

    # route must be kebab/snake case (guards against path traversal and broken budget counting)
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9_-]*$", args.route):
        print(f"ERROR: --route accepts letters/digits/hyphen/underscore only (got '{args.route}').",
              file=sys.stderr)
        return 1
    if args.count < 1:
        print(f"ERROR: --count must be >= 1 (got {args.count}).", file=sys.stderr)
        return 1

    design_dir = resolve_design_dir(args.design_dir) if args.design_dir else find_design_dir()
    if not os.path.isdir(design_dir):
        os.makedirs(design_dir, exist_ok=True)

    state_file = default_state_path(design_dir)
    if not os.path.isfile(state_file):
        print(f"BLOCKED: budget state file not found ({state_file}). "
              "Run check_draft_budget.py --begin-round first.")
        return 2
    try:
        with open(state_file, encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR: budget state file is corrupt ({state_file}): {e}. Re-run --begin-round.",
              file=sys.stderr)
        return 1
    if not state.get("round_open"):
        print("BLOCKED: this round is not open (round_open is not true). "
              "Run check_draft_budget.py --begin-round first.")
        return 2

    # Enforce the count budget at creation time: drafts added this round + the requested count >
    # budget -> reject. This blocks "over-budget draft floods" at the source instead of ratcheting
    # them back after the fact via --check.
    #
    # The count comes from core.split_round_drafts, the same helper --begin-round and --check use,
    # so a draft the platform sealed as `stopped` does not occupy a slot here either. It cannot:
    # the file is write-protected, so the user can never receive it and the model can never repair
    # it, and charging the round for it leaves the round with an instruction it cannot carry out.
    budget = int(state.get("budget", 1))
    snapshot = set(state.get("snapshot", []))
    manifest = load_manifest(design_dir)
    stopped = manifest_stopped_filenames(manifest) if manifest is not None else set()
    new_this_round, skipped = split_round_drafts(html_set(design_dir), snapshot, stopped)
    if len(new_this_round) + args.count > budget:
        remaining = max(0, budget - len(new_this_round))
        print(f"BLOCKED: this round's budget is {budget} draft(s), {len(new_this_round)} already added, "
              f"so at most {remaining} more allowed — requested {args.count}. "
              "The first round makes exactly 3; later rounds make exactly 1. "
              "Run --check to close the round, then ask the user whether to continue.")
        return 2
    if skipped:
        print(f"NOTE: {len(skipped)} draft(s) stopped mid-round do not occupy a slot "
              f"({', '.join(skipped)}); this round's budget is counted without them.")

    source, source_path = resolve_source(design_dir, args.from_name)
    if source is None:
        print(f"ERROR: source draft not found: {source_path}", file=sys.stderr)
        return 1
    stamped = stamp_content(source)
    source_bytes = stamped.encode("utf-8")
    stamp_line = stamp_line_no(stamped)

    created = []
    for _ in range(args.count):
        name = create_one(design_dir, args.route, source_bytes)
        if name is None:
            print(f"ERROR: no free number available for route={args.route}.", file=sys.stderr)
            return 1
        created.append(name)

    names = ", ".join(f"`{c}`" for c in created)
    where = f"line {stamp_line}" if stamp_line else "the line after <!DOCTYPE html>"
    print(
        f"Created {names}: byte-identical to `{args.from_name}` except {where}, where the stamp is "
        "reset to a placeholder. Nothing else was touched.\n"
        "Never re-read them; edit only with str_replace_editor (cp/cat/tee/sed wipes edits).\n"
        "Fill the stamp once, after the body is final: title = style word, <=8 chars, no product name.\n"
        f"Copy this exact line as your old_str -- the source draft's own stamp will not match:\n"
        f"{PLACEHOLDER_STAMP}"
    )
    # The full rule set is printed once per app — at the first draft creation, which is when
    # "will the checker reject this?" first matters. Later rounds get the pointer only.
    rules = enforced_rule_names() if not snapshot and budget >= 3 else None
    if rules:
        print(f"Enforced by check_design_quality.py ({len(rules)} rules): {', '.join(rules)}. "
              "Severity / waivable / waiver syntax: check_design_quality.py --list-rules")
    else:
        print("Rule set: python3 check_design_quality.py --list-rules — don't infer the scope from "
              "a draft that happened to pass.")
    return 0



if __name__ == "__main__":
    sys.exit(main())
