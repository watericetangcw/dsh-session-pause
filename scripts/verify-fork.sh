#!/bin/bash
# Verify the fork carries ONLY the PAUSE change points on top of its upstream base.
#
# Usage:
#   ./scripts/verify-fork.sh <path-to-upstream-lib-index.js>
#
# Get the exact upstream base the fork is built on:
#   npm pack @deepseek-ai/dsh-agent-loop@0.2.1-rc.5
#   tar xzf deepseek-ai-dsh-agent-loop-0.2.1-rc.5.tgz
#   ./scripts/verify-fork.sh package/lib/index.js
#
# Why this exists: the fork is a full copy of upstream's lib/index.js plus the
# PAUSE change points. Upstream drift that is NOT a PAUSE change (deleted
# events, renamed helpers, refactored lifecycles) must be re-copied from the
# new base, never merged by hand. This script proves the rebuild did that.
#
# Judgement rule: each diff hunk is one change point. A hunk is "documented"
# when it contains at least one line mentioning PAUSE. Every documented hunk
# should correspond to one of the 11 change points listed in the fork header
# and notes/design.md; the expected count is printed for eyeball comparison.
#
# Exit 0 = every hunk is PAUSE-related. Exit 1 = undocumented hunks found.
set -uo pipefail

UPSTREAM="${1:?usage: verify-fork.sh <path-to-upstream-lib-index.js>}"
FORK="$(cd "$(dirname "$0")/.." && pwd)/lib/agent-loop.js"
EXPECTED_PAUSE_HUNKS=13

[ -f "$UPSTREAM" ] || { echo "missing upstream file: $UPSTREAM" >&2; exit 1; }
[ -f "$FORK" ]     || { echo "missing fork file: $FORK" >&2; exit 1; }

raw=$(mktemp)
trap 'rm -f "$raw"' EXIT
diff -u "$UPSTREAM" "$FORK" > "$raw" || true
cp "$raw" /tmp/verify-fork-full.diff

awk -v expected="$EXPECTED_PAUSE_HUNKS" '
  function flush_hunk() {
    if (hunk_no == 0) return
    if (has_pause) {
      pause_hunks++
      printf "  hunk %-2d %-40s PAUSE\n", hunk_no, hunk_head
    } else {
      bad_hunks++
      printf "  hunk %-2d %-40s <<< UNDOCUMENTED\n", hunk_no, hunk_head
      for (k = 1; k <= bad_n; k++) printf "        %s\n", bad[k]
    }
  }
  /^@@/ {
    flush_hunk()
    hunk_no++; has_pause = 0; hunk_head = $0; sub(/^@@ [^@]*@@ ?/, "", hunk_head)
    if (hunk_head == "") hunk_head = "(no context)"
    bad_n = 0
    next
  }
  hunk_no > 0 {
    if ($0 ~ /PAUSE/) has_pause = 1
    else if ($0 ~ /^[+-]/ && $0 !~ /^(\+\+\+|---)/) bad[++bad_n] = $0
  }
  END {
    flush_hunk()
    printf "\nPAUSE hunks: %d (documented: %d)\n", pause_hunks, expected
    if (pause_hunks != expected)
      printf "NOTE: hunk count differs from the documented %d — confirm each is a real change point.\n", expected
    if (bad_hunks > 0) {
      printf "UNDOCUMENTED hunks: %d\n", bad_hunks
      printf "1\n" > "/tmp/verify-fork.status"
      exit
    }
    printf "0\n" > "/tmp/verify-fork.status"
  }
' "$raw"

# awk writes its verdict to a status file rather than relying on $?: this
# script's output is routinely piped (| tail, | head), and a pipeline reports
# only its LAST command's status, so an `exit 1` from awk would be swallowed.
status=$(cat /tmp/verify-fork.status 2>/dev/null || echo 1)
echo
if [ "$status" = "0" ]; then
  echo "OK: no undocumented drift. Full diff: /tmp/verify-fork-full.diff"
else
  echo "FAIL: undocumented hunks above must be replaced with the upstream base's own code."
  echo "Full diff: /tmp/verify-fork-full.diff"
fi
rm -f /tmp/verify-fork.status
exit "$status"
