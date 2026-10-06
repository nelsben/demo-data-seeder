#!/usr/bin/env bash
# PreToolUse(Bash) guard — enforce the one git invariant that is always
# correct: no direct commit/merge onto the default branch (branch first,
# per CLAUDE.md). Force-push is already denied at the permissions layer.
#
# Conservative + FAIL-OPEN: only acts on a real `git commit` / `git merge`
# that would land on the protected branch; on any parse/branch-detection
# error it ALLOWS (exit 0). Blocks only when certain the branch is main/master.
#
# Subcommand detection tokenizes the command in python3 (already a dependency
# for JSON parsing) — NOT string matching. A regex keyed on `git <space>
# (commit|merge)` is defeated by global options between `git` and the
# subcommand (`git -c k=v commit`, `git --no-pager commit`, `git -C dir
# merge`). Tokenizing walks past global options (consuming separate-token
# arguments), scans EVERY git invocation (commands may be ;- or newline-
# separated into one flat token list), and ignores `commit`/`merge` inside
# quoted strings (echo "...git commit...") or plumbing (git merge-base).
#
# Branch-state model (default-DENY): `prot` = "could a commit right now land on
# the branch bash will check (the starting branch) or on main/master?". It
# starts True and only flips to False on a PROVABLE branch-away — a recognized
# create (`checkout -b`/`switch -c`/…) onto a non-main ref. ANY OTHER bare
# checkout/switch re-arms `prot=True`, because the destination can't be proven
# off-main: `checkout main`, `checkout -`/`switch -` (previous branch),
# `checkout @{-1}` (reflog), or a feature ref all look the same statically, and
# `-`/reflog forms resolve to main right after a `checkout -b`. So `checkout
# -b feat && commit` is allowed, but `checkout -b feat && checkout - && commit`
# (or `&& checkout main &&`, `&& git switch - &&`, …) is BLOCKED. A
# `checkout -- <file>` restore is a pathspec op (no switch) → leaves `prot`.
# The cost is a SAFE over-block of the rare `checkout -b a && checkout
# other-feature && commit` (commit lands off main but we can't prove it) —
# never the prescribed `checkout -b <task> && commit` pattern.
#
# cd-tracking + subshells: a command-position `cd <dir>` (and a committing git's
# own `-C <dir>`) retargets the dir whose branch is checked, and a `cd` inside
# `( ... )` is correctly subshell-SCOPED (pushed at `(`, restored at `)`) so it
# can't leak to an outer commit (OPS-030 peer-review finding). `git checkout`
# inside a subshell is intentionally NOT scoped — it mutates on-disk HEAD, which
# persists past the subshell.
#
# KNOWN LIMITATION (out of scope per CLAUDE.md threat model — accident
# tripwire, not adversary-proof): indirection that hides the subcommand name
# from the literal string — `bash -c "git commit"`, `eval "git commit"`,
# `git $(echo commit)` — is allowed; so is a `cd $(…)`/`cd "$VAR"` whose target
# is only known at runtime, and HEAD plumbing that moves branches without
# checkout/switch (`git symbolic-ref HEAD`, `git update-ref`). One more:
# a NAMED create chained by `||` to a commit (`git checkout -b feat || git
# commit`) routes the commit to main only when the create FAILS — a contrived
# "branch, or-else commit to main" that no one writes by accident. The GitHub
# ruleset on `main` is the real backstop against determined evasion; this hook
# stops mistakes.
set -uo pipefail

input="$(cat 2>/dev/null)" || exit 0

# Print 'check' iff the command performs a real `git commit`/`git merge` that
# would land on the protected branch; else 'allow'. Fail-open: any exception,
# missing python3, or unparseable shell → 'allow'.
# OPS-030 multi-worktree fix: a `git commit` does NOT necessarily run in
# CLAUDE_PROJECT_DIR. `git -C <dir> commit` and a leading `cd <dir> && git
# commit` retarget another working dir — and with two live worktrees (one on a
# task branch, one possibly on main) the OLD guard resolved the branch from
# CLAUDE_PROJECT_DIR and waved a commit-to-main in a SIBLING worktree straight
# through. So decide() now ALSO returns the effective target dir of the
# committing invocation (tracking `cd` + the committing git's own `-C`), and
# bash resolves the branch THERE. Output is two tab-separated fields:
# "check\t<dir>" (dir empty = CLAUDE_PROJECT_DIR) or "allow\t".
out="$(printf '%s' "$input" | python3 -c '
import sys, json, shlex, os

OPT_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
           "--exec-path", "--config-env", "--super-prefix", "--attr-source"}
CREATE  = {"-b", "-B", "-c", "-C", "--create", "--force-create", "--orphan"}

def is_sep(tok):                 # a shell command separator/operator token
    return tok != "" and all(ch in "();<>|&;" for ch in tok)

def first_ref(rest):             # first non-flag token = the branch/ref argument
    for t in rest:
        if not t.startswith("-"):
            return t
    return None

def join_dir(cwd, d):            # effective dir of an invocation, given running cwd
    if not d:
        return cwd
    if os.path.isabs(d):
        return d
    return os.path.normpath(os.path.join(cwd, d)) if cwd else d

def decide(cmd):
    try:
        # posix + punctuation_chars => shell-like tokenizing: ; && || | & ( )
        # become their own tokens, quotes are honored. Raises on unbalanced
        # quotes -> caller fails open.
        tokens = list(shlex.shlex(cmd, posix=True, punctuation_chars=True))
    except Exception:
        return ("allow", "")

    n = len(tokens)
    prot = True       # default-DENY: assume on the protected branch until proven off
    mutates = False
    target = None     # effective dir of the FIRST committing invocation
    cwd = ""          # running cwd, updated by a command-position `cd <dir>`
    cwd_stack = []    # subshell scoping for cwd (see below)
    i = 0
    while i < n:
        # Subshell scoping: a `cd` inside `( ... )` is SHELL state — it does not
        # survive the subshell — so push cwd at `(` and restore it at `)`. (By
        # contrast a `git checkout` inside `(...)` mutates on-disk HEAD, which
        # DOES persist, so prot is intentionally NOT scoped.) Parens can be glued
        # into a combined punctuation token (`)&&`, `&&(`), so scan each char.
        if is_sep(tokens[i]):
            for ch in tokens[i]:
                if ch == "(":
                    cwd_stack.append(cwd)
                elif ch == ")" and cwd_stack:
                    cwd = cwd_stack.pop()
            i += 1
            continue
        at_start = (i == 0 or is_sep(tokens[i - 1]))
        if tokens[i] == "cd" and at_start:
            # `cd <dir>` at a command position retargets cwd for what follows.
            k = i + 1; arg = None
            while k < n and not is_sep(tokens[k]):
                if not tokens[k].startswith("-"):
                    arg = tokens[k]; break
                k += 1
            if arg is not None:
                cwd = join_dir(cwd, arg)
        elif tokens[i] == "git" and at_start:
            j = i + 1
            cdir = ""                                # this invocation`s own -C dir
            while j < n and not is_sep(tokens[j]):   # walk past git global options
                o = tokens[j]
                if o == "-C" and j + 1 < n:          # retargets THIS invocation
                    cdir = tokens[j + 1]; j += 2; continue
                if o in OPT_ARG:                     # takes a SEPARATE-token arg
                    j += 2; continue
                if o.startswith("--git-dir=") :      # attached form
                    cdir = cdir or o.split("=", 1)[1]; j += 1; continue
                if o.startswith("--") and "=" in o:  # other attached opt=val
                    j += 1; continue
                if o.startswith("-"):                # flag w/o arg (--no-pager,-p)
                    j += 1; continue
                break
            sub = tokens[j] if (j < n and not is_sep(tokens[j])) else ""
            e = j + 1                                # bound this cmd at next sep
            while e < n and not is_sep(tokens[e]):
                e += 1
            rest = tokens[j + 1:e]
            if sub in ("checkout", "switch"):
                if "--" in rest:
                    pass                             # pathspec/file restore — no switch
                elif any(f in rest for f in CREATE):
                    ref = first_ref(rest)
                    # off main only on a NAMED create of a non-main branch. A
                    # nameless create (ref is None: `checkout -b ;`/`-b ||`) is
                    # malformed and cannot prove a branch-away -> default-DENY.
                    prot = ref is None or ref in ("main", "master")
                else:
                    # bare switch to SOME ref that cannot be statically proven
                    # off main (main / - / @{-1} / a feature ref all look alike).
                    # Only safe default is DENY: re-arm prot for the next commit.
                    prot = True
            elif sub in ("commit", "merge"):
                if prot:
                    mutates = True
                    if target is None:
                        target = join_dir(cwd, cdir)
        i += 1
    return ("check", target or "") if mutates else ("allow", "")

try:
    d = json.load(sys.stdin)
    cmd = d.get("tool_input", {}).get("command", "")
except Exception:
    cmd = ""
dec, tgt = decide(cmd) if cmd else ("allow", "")
sys.stdout.write(dec + "\t" + tgt)
' 2>/dev/null)" || exit 0

decision="${out%%$'\t'*}"
target="${out#*$'\t'}"
[ "$decision" = "check" ] || exit 0

# Resolve the effective dir of the committing invocation. Relative targets
# resolve against CLAUDE_PROJECT_DIR (best available anchor for the hook).
anchor="${CLAUDE_PROJECT_DIR:-.}"
if [ -z "$target" ]; then          effdir="$anchor"
elif [ "${target#/}" != "$target" ]; then effdir="$target"      # absolute
else                               effdir="$anchor/$target"; fi

branch="$(git -C "$effdir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Git guard: don't commit directly to '$branch' (target dir: $effdir). Branch first (e.g. setup/... or chore/...), then open a PR for the merge gate." >&2
  exit 2
fi
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  # `abbrev-ref HEAD` yields "" (resolve failed) or the literal "HEAD" (detached).
  # Commit-intent is proven but the target branch is indeterminate. If the dir is
  # a real work tree (detached/unborn HEAD), fail CLOSED — a guard that can't see
  # the branch must not wave a proven commit through (review M1 fail-open). If the
  # dir isn't a repo at all, the commit fails harmlessly on its own → don't add a
  # confusing block.
  if [ "$(git -C "$effdir" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ]; then
    echo "Git guard: can't determine the branch in '$effdir' (detached/unborn HEAD). Blocking the commit as a precaution — checkout a feature branch (e.g. setup/... or chore/...) and retry." >&2
    exit 2
  fi
  exit 0
fi
exit 0