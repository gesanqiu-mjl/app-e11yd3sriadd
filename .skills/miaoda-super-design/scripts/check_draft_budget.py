#!/usr/bin/env python3
"""Draft-count budget interceptor -- 3 drafts in the first round, 1 per round after that.

Rule: the first round always produces 3 proposals. Every later round that produces new
drafts (iteration, a new page, "give me a few more versions") produces exactly 1 new html,
then ends the round after delivery and asks the user in the closing message whether to continue.

Usage (design_dir is tasks/design/ in debug mode):
  after P1 clarification  python3 check_draft_budget.py tasks/design --mark-clarified --reason "..."
  at the start of a round  python3 check_draft_budget.py tasks/design --begin-round
  self-check after drafts  python3 check_draft_budget.py tasks/design --check

State file: design-budget.json next to design_dir by default (tasks/design ->
tasks/design-budget.json). It only holds round-scoped state (snapshot/budget/clarified/
round_open) -- manifest.json has no notion of rounds, so the script must track that itself.
Override with --state.

Data sources `--check` uses to decide whether this round's new drafts passed, in priority order:
  1. `{design_dir}/manifest.json` exists (engineering hook environment): read drafts[].status;
     only status=="ready" (or the legacy "valid") counts as passed. The engineering side sets
     ready only after check_design_quality.py actually returned a passing JSON report, so it is
     unaffected by this command re-running the checker itself and immune to problems like a
     shell pipeline clobbering the exit code.
  2. No manifest.json and no local design-budget.json state either (--begin-round was never
     run): treat this as local debugging outside the engineering environment and fall back to
     running check_design_quality.py in a subprocess (the old behavior, kept so the script
     stays usable standalone).
  3. No manifest.json but local design-budget.json state exists (we are in the engineering
     environment, no draft write has triggered manifest registration yet): treat as 0 valid
     drafts. Not an error -- just report that nothing has passed yet.

Key edge case: the manifest only registers drafts the model actively ran
check_design_quality.py on and that passed. If the model writes a new draft but never
validates it before finishing, that draft never shows up in the manifest (not as invalid --
there is simply no entry, or it stays at generating until the end-of-round fallback marks it
invalid). `--check` must detect "new this round but missing from or not valid in the manifest"
and name the files explicitly. It must not pass just because the manifest holds enough valid
entries to cover the budget -- hitting the budget count does not prove the counted files are
this round's new ones.

Second edge case, `status == "stopped"`: the user aborted (or the agent errored) mid-round,
so the platform sealed the draft without ever checking it and write-protects the file. Such a
draft can neither be fixed to pass nor deleted, so it is excluded everywhere a draft would
otherwise block or consume quota: from `--begin-round`'s stray ratchet, from the "already
created" count that sets the first round's remaining budget, and from `--check`'s new-draft
list. Continuing it means `new_draft.py --from <it>`, and that replacement counts normally.

sha is recorded purely as bookkeeping for the files that passed this round; the script does
not use it to detect tampering.

Exit codes: 0 = pass; 2 = over budget / blocked by quality check; 1 = usage or state error.
Pure Python standard library, no third-party dependencies.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

# Status vocabulary and round bookkeeping live in core.py -- see the "Draft status vocabulary"
# section there for the state machine and for why is_sealed() is a closed set, and the "Round
# bookkeeping" section for why the "drafts this round produced" count must not exist twice.
# sys.path is amended so the import also works when the module is imported by tests rather than
# run as a script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (  # noqa: E402
    continue_draft_command,
    default_state_path,
    html_set,
    load_manifest,
    manifest_all_filenames,
    manifest_sealed_filenames,
    manifest_stopped_filenames,
    manifest_unchecked_filenames,
    manifest_valid_filenames,
    split_round_drafts,
)

APP_ROOT_RE = re.compile(r"^app-[\w-]+$")


def _walk_up_for_app(start):
    """Walk up from `start` to the first `app-<id>` directory; return None if none found."""
    probe = os.path.abspath(start)
    while True:
        if APP_ROOT_RE.match(os.path.basename(probe)):
            return probe
        parent = os.path.dirname(probe)
        if parent == probe:
            return None
        probe = parent


def find_app_root():
    """Locate the current app root `app-<id>`: check CWD's ancestors first, then the script's own location.

    Kept in sync with new_draft.py (both scripts must resolve the same app root; otherwise
    one writes state to `/workspace/app-x/tasks/design-budget.json` while the other looks for
    it at `/workspace/tasks/design-budget.json` and they never see each other). CWD is
    unreliable -- the engineering side may run bash from the app's parent directory (e.g.
    `/workspace`), where `app-<id>` is a child of CWD and walking up cannot reach it. The
    script is deployed under `<app-root>/.skills/.../scripts/`, so `__file__`'s ancestry
    always contains `app-<id>` -- a more stable anchor than CWD.
    """
    hit = _walk_up_for_app(os.getcwd())
    if hit:
        return hit
    hit = _walk_up_for_app(os.path.dirname(os.path.abspath(__file__)))
    if hit:
        return hit
    return os.path.abspath(os.getcwd())


def resolve_design_dir(arg):
    """Resolve design_dir to an absolute path: relative paths against the app root, absolute as-is."""
    if os.path.isabs(arg):
        return os.path.abspath(arg)
    return os.path.join(find_app_root(), arg)


def sha256_of(path):
    """Stable sha256 (reads the whole file; drafts are small, no need to chunk). Returns None if the file is missing."""
    if not os.path.isfile(path):
        return None
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def _snapshot_sha(design_dir, files):
    """Compute a sha snapshot for the current file set (bookkeeping only, not used for tampering detection)."""
    return {f: sha256_of(os.path.join(design_dir, f)) for f in files}


def load_state(state_file):
    """Read the state file; on corruption return an empty dict and warn (no traceback)."""
    if not os.path.isfile(state_file):
        return {}
    try:
        with open(state_file, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"WARN: state file corrupted ({state_file}): {e}. Treating as empty state.", file=sys.stderr)
        return {}


def save_state(state_file, state):
    """Write the state file; skip makedirs when the directory part is empty (bare filename)."""
    parent = os.path.dirname(state_file)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _is_first_round(prev):
    """Whether the still-open round is the first one, i.e. the round that owes 3 proposals.

    `first_round` is written by --begin-round. The `budget == 3` fallback only serves state
    files written before that key existed -- and reading the budget back is exactly the bug
    this helper replaces: a first round reopened after an abort has its budget recomputed to
    2, so `budget == 3` stopped matching and the stopped exemption fired only once. A second
    abort then dropped the round to 1 and the user got 2 proposals instead of the promised 3.
    """
    if "first_round" in prev:
        return bool(prev["first_round"])
    return int(prev.get("budget", 1)) == 3


def resolve_round_budget(prev, current, sealed, stopped=frozenset()):
    """Drafts this round may produce: 3 for a genuine first round, 1 for an iteration.

    A first round that never reached --check leaves `round_open` true. Reopening it must not
    restart the quota at 3 (the drafts already on disk would be unreachable) nor drop it to 1
    (the promised three proposals would shrink to one), so the remaining allowance is 3 minus
    what has already been created.

    Note the deliberate choice of "created" over "passed": with one ready and two failed
    drafts the user already holds a usable proposal, so the next round is a normal
    iteration worth 1 -- counting only ready drafts would wrongly grant 2.

    `stopped` drafts are the exception and do not count as created: the round was aborted
    before they were ever checked, and the platform write-protects them, so they are
    neither usable proposals nor fixable ones. The model has to create a replacement
    (new_draft.py --from the stopped draft carries the direction over), which needs a slot.
    Counting them would silently shrink the promised three proposals to two.

    `sealed` is unused here but kept in the signature so callers pass the manifest view
    they already computed; a future policy may need it.
    """
    had_prior_round = "snapshot" in prev
    if not had_prior_round:
        # No round state at all: a fresh app, or the state file was lost / corrupted while the
        # manifest survived (the interrupt-and-retrigger flow). Drafts already on disk mean someone
        # got partway, so this is treated as an iteration -- but a `stopped` draft is not partway
        # progress. Without this the same cancel that motivated the whole stopped exemption
        # degrades the first round to 1 proposal AND skips the P1 clarification gate below, which
        # is keyed on budget == 3.
        created, _skipped = split_round_drafts(current, (), stopped)
        return 3 if not created else 1
    if prev.get("round_open") and _is_first_round(prev):
        # Empty snapshot on purpose: the first round's quota of 3 is a single allowance spread
        # across every reopen, so what matters is how many of the three already exist -- not how
        # many appeared since the last --begin-round. Same helper as --check and new_draft.py,
        # so "stopped does not count" cannot drift between them.
        created, _skipped = split_round_drafts(current, (), stopped)
        return max(1, 3 - len(created))
    return 1



def main():
    """CLI entry: dispatch --mark-clarified / --begin-round / --check."""
    ap = argparse.ArgumentParser(description="Draft count budget interceptor")
    ap.add_argument("design_dir", help="Draft directory (tasks/design/ in debug mode)")
    ap.add_argument("--begin-round", action="store_true",
                    help="Start this round: snapshot existing drafts and print the budget")
    ap.add_argument("--check", action="store_true",
                    help="After producing drafts, verify this round's new count against the budget")
    ap.add_argument("--mark-clarified", action="store_true",
                    help="Mark P1 clarification done (must be called before the first round's --begin-round)")
    ap.add_argument("--reason", default=None, help="Clarification reason (required with --mark-clarified)")
    ap.add_argument("--state", default=None, help="State file path (defaults to design-budget.json next to design_dir)")
    args = ap.parse_args()

    # Mutual exclusion: exactly one of --begin-round / --check / --mark-clarified
    selected = sum([args.begin_round, args.check, args.mark_clarified])
    if selected != 1:
        print("ERROR: choose exactly one of --begin-round / --check / --mark-clarified", file=sys.stderr)
        return 1
    if args.mark_clarified and not args.reason:
        print("ERROR: --mark-clarified requires --reason", file=sys.stderr)
        return 1

    design_dir = resolve_design_dir(args.design_dir)
    if not os.path.isdir(design_dir):
        os.makedirs(design_dir, exist_ok=True)
    state_file = args.state or default_state_path(design_dir)
    current = html_set(design_dir)

    if args.mark_clarified:
        state = load_state(state_file)
        state["clarified"] = True
        state["clarify_reason"] = args.reason
        save_state(state_file, state)
        print(f"Clarification marked: {args.reason}")
        return 0

    if args.begin_round:
        # Ratchet: block re-opening a new baseline while the previous round has unchecked new drafts
        prev = load_state(state_file)
        manifest = load_manifest(design_dir)
        sealed = manifest_sealed_filenames(manifest) if manifest is not None else set()
        stopped = manifest_stopped_filenames(manifest) if manifest is not None else set()
        if prev:
            baseline = set(prev.get("checked") if prev.get("checked") is not None else prev.get("snapshot", []))
            # Sealed drafts (ready / failed / stopped) are excluded: --check has nothing left
            # to do on them, so keeping them as strays would make every escape route return
            # exit 2 -- the deadlock that motivated this branch. `stopped` matters most here:
            # the platform write-protects it, so the "delete the rest" escape is closed too.
            strays = [p for p in current if p not in baseline and p not in sealed]
            if strays:
                print(f"BLOCKED: found new drafts that never passed --check: {', '.join(strays)}.")
                print("The previous round's output was not validated (or over budget and not cleaned "
                      "up). Cannot open a new round directly:")
                print("  1) If over budget: keep only 1 new draft, delete the rest;")
                print(f"  2) Run python3 check_draft_budget.py {design_dir} --check and pass, "
                      "then --begin-round.")
                return 2
        budget = resolve_round_budget(prev, current, sealed, stopped)
        # First round (budget==3) requires P1 clarification (--mark-clarified) beforehand
        if budget == 3 and not prev.get("clarified"):
            print(
                "BLOCKED: P1 clarification not done. First send ask_user (or confirm the user already "
                "gave a color-scheme answer), then call --mark-clarified --reason '<reason>' and rerun --begin-round."
            )
            return 2
        new_state = dict(prev)
        new_state.update({
            "snapshot": current,
            "budget": budget,
            "checked": current,
            "round_open": True,
            # Sticky marker for "this open round is the 3-proposal one". Must not be derived
            # from `budget` later: an abort recomputes the budget below 3 (see _is_first_round).
            "first_round": budget == 3 or bool(prev.get("round_open") and _is_first_round(prev)),
        })
        save_state(state_file, new_state)
        if not current:
            print("This round budget: 3 drafts (the first round; the three layout skeletons must differ).")
        elif budget == 1:
            print(f"{len(current)} draft(s) already exist. This round budget: 1 draft -- build only one "
                  "html, end this round normally after delivery, and ask the user whether to continue "
                  "in the closing message.")
        else:
            print(f"{len(current)} draft(s) already exist, but the first round never closed. This round "
                  f"budget: {budget} draft(s) -- the first round owes the user 3 proposals in total, so "
                  "fill the gap, then run --check to close it.")
        return 0

    # --check
    state = load_state(state_file)
    # Note: first-round snapshot is an empty list (the dir was empty), so truthiness cannot be
    # used -- must check whether the key exists at all.
    if "snapshot" not in state:
        budget = 3 if len(current) <= 3 else 1
        print("WARN: no snapshot for this round found; cannot precisely determine this round's new count.")
        print("Run --begin-round at the start of each round. Reminding by total for now: ", end="")
        print("Within 3 drafts for the first round." if budget == 3
              else f"{len(current)} draft(s) already exist; non-first rounds allow only 1 draft per round.")
        return 0
    snapshot, budget = set(state.get("snapshot", [])), int(state.get("budget", 1))
    manifest = load_manifest(design_dir)
    # Drafts the platform sealed as `stopped` (this round was aborted before they were ever
    # checked) are dropped from "new this round": they are write-protected, so they can
    # neither be fixed to pass nor deleted. Leaving them in would block --check with advice
    # the model cannot act on ("edit the file first"), and counting them would consume the
    # round's quota with something the user cannot use. Once such a draft is continued via
    # new_draft.py --from, the replacement is a normal new draft and counts as usual.
    stopped = manifest_stopped_filenames(manifest) if manifest is not None else set()
    new, skipped = split_round_drafts(current, snapshot, stopped)
    if skipped:
        print(f"NOTE: skipping {len(skipped)} draft(s) stopped mid-round (never checked, "
              f"read-only): {', '.join(skipped)}.")
        print("      They do not count toward this round. Continue one with:")
        for f in skipped:
            print(f"        {continue_draft_command(f)}")
    n = len(new)

    if not new:
        # No new draft this round -- do not close round_open (might still be drafting, just a mid-check)
        state["checked"] = current
        state["sha"] = _snapshot_sha(design_dir, current)
        save_state(state_file, state)
        # State the outstanding count explicitly. Printing only "no new draft yet" left the model
        # unable to tell that it still owed three proposals: in the QA trace it read --help and
        # grepped both scripts' source instead of simply creating the drafts.
        print(f"No new draft added this round yet -- this round still owes {budget} draft(s).")
        return 0

    # Determine whether this round's new drafts have passed -- if manifest.json exists, read it
    # (the engineering side's authoritative registry; see data-source priority in the module
    # docstring). If absent, distinguish between "local debugging outside the engineering env"
    # and "engineering env but no draft has triggered manifest registration yet"; only the former
    # falls back to running check_design_quality.py as a subprocess.
    if manifest is not None:
        valid_names = manifest_valid_filenames(manifest)
        not_yet_valid = [f for f in new if f not in valid_names]
        if not_yet_valid:
            # Split the advice three ways, because the three cases need three different actions:
            #   never checked            -> run the checker
            #   checked, still failing   -> edit the file first (re-running it unchanged reprints
            #                               the same errors, and models do loop on that)
            #   sealed (failed/stopped)  -> cannot be edited at all; the only legal move is a copy
            # The third case used to be folded into the second, so --check told the model to edit a
            # write-protected file -- while check_design_quality.py --fix refused that same file for
            # being sealed. A `failed` draft then had no legal repair path at all.
            # A draft with no manifest entry counts as never checked: registration happens on write,
            # so a missing entry cannot mean "already rejected".
            registered = manifest_all_filenames(manifest)
            unchecked = manifest_unchecked_filenames(manifest)
            sealed_names = manifest_sealed_filenames(manifest)
            never = [f for f in not_yet_valid if f in unchecked or f not in registered]
            frozen = [f for f in not_yet_valid if f not in never and f in sealed_names]
            rejected = [f for f in not_yet_valid if f not in never and f not in frozen]
            print(f"BLOCKED: {len(not_yet_valid)} of this round's new drafts are not ready.")
            if never:
                print(f"  never checked: {', '.join(never)}")
                print("    python3 check_design_quality.py "
                      f"{' '.join(os.path.join(design_dir, f) for f in never)}")
            if rejected:
                print(f"  checked, still failing: {', '.join(rejected)}")
                print("    the errors from the last run are unfixed -- edit the file with "
                      "str_replace_editor first; re-running the checker unchanged prints the same output.")
            for f in frozen:
                print(f"  sealed, cannot be repaired in place: {f}")
                print(f"    {continue_draft_command(f)}")
                print("    then finish the copy and re-check it; the sealed draft stays as it is.")
            print("Then rerun this command. Enough valid entries in manifest to meet budget does not mean "
                  "these specific files passed; each must map to this round's new filenames.")
            return 2
        passed = new
    elif "snapshot" not in state or state.get("_never_begun"):
        # Should not reach here in practice (snapshot existence was checked above); kept as a defensive guard
        passed = new
    else:
        # manifest absent: use whether --begin-round has been run to distinguish scenarios.
        # design-budget.json state exists (we got this far, so snapshot must exist) means we are
        # in the engineering env but no draft write has triggered manifest registration yet -- not
        # an error, but we also cannot assume "no manifest = all passed". Fall back conservatively
        # to running the checker locally (preserves standalone usability).
        quality = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_design_quality.py")
        if not os.path.isfile(quality):
            print("WARN: manifest.json not found and check_design_quality.py not found; cannot determine "
                  "whether this round's new drafts passed, treating as not passed.")
            return 2
        files = [os.path.join(design_dir, f) for f in new]
        res = subprocess.run([sys.executable, quality, *files], capture_output=True, text=True)
        if res.returncode != 0:
            print("BLOCKED: this round's new drafts did not pass check_design_quality (error level).")
            print("First run:")
            print(f"  python3 check_design_quality.py {' '.join(files)}")
            print("Fix via str_replace_editor per the output, then rerun this command after it passes.")
            for line in (res.stdout or "").splitlines()[:20]:
                print("  ", line)
            return 2
        passed = new

    n = len(passed)
    if n <= budget:
        state["checked"] = current
        state["sha"] = _snapshot_sha(design_dir, current)
        # Only close the round when the budget is used up (n == budget); if not full yet keep round_open
        if n == budget:
            state["round_open"] = False
        save_state(state_file, state)
        if budget == 1:
            print(f"OK: 1 new draft this round ({passed[0]}), budget used up, end this round after delivery.")
        else:
            # Deliberately "n/budget", not "n/3": when a mid-round abort left stopped drafts behind,
            # --begin-round recomputed the budget below 3, and printing n/3 then told the model it
            # still owed drafts while round_open had already been closed -- two contradicting signals.
            if n == budget:
                print(f"OK: this round's {n} draft(s) passed ({', '.join(passed)}), budget used up, "
                      "end this round after delivery.")
            else:
                print(f"OK: {n}/{budget} of this round's drafts passed ({', '.join(passed)}), "
                      "keep filling the rest.")
        return 0
    # Over budget. Both statements the old wording made here were false: it said "keep only 1"
    # while the line above printed a budget of 3 (obeying it deletes delivered proposals), and it
    # called every surplus file "not yet registered, safe to delete" -- a draft the platform has
    # already sealed cannot be deleted at all. It also promised that the next --begin-round would
    # be BLOCKED, which is only true for drafts that are still `generating`: sealed ones are
    # deliberately excluded from the stray ratchet, so for them the refusal below is the whole
    # enforcement and the surplus cannot be undone afterwards.
    #
    # Note `deletable` is empty whenever the manifest is authoritative: `passed` can only hold
    # `ready` drafts there, and `ready` is sealed. It is non-empty only on the standalone path
    # (no manifest, verdict from the checker subprocess), which is where local debugging lands.
    sealed_names = manifest_sealed_filenames(manifest) if manifest is not None else set()
    deletable = [f for f in passed if f not in sealed_names]
    print(f"BLOCKED: this round's budget is {budget} draft(s), but {n} were added ({', '.join(passed)}).")
    print("Rule: exactly 3 proposals in the first round; only 1 html per round afterward.")
    if deletable:
        print(f"Fix: keep {budget}, delete the surplus. Only these are still deletable (the platform "
              f"has not sealed them): {', '.join(deletable)}.")
        print("     After deleting, rerun --check and pass -- an unchecked leftover blocks the next "
              "round's --begin-round.")
    if len(deletable) < n - budget:
        print("The rest are already sealed by the platform (delivered or verdicted): they cannot be "
              "deleted or edited, so this surplus cannot be undone. Deliver what exists, create no "
              "more this round, and get the count right before creating rather than after.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
