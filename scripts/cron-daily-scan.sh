#!/bin/bash
# Daily cron entrypoint: scan.mjs -> filter-inbox-by-fit.mjs -> score-inbox.mjs
# -> auto-evaluate-top-picks.mjs.
# The first three stages are zero-LLM-cost (deterministic scripts, no claude -p
# call). The last stage is NOT zero-cost (2026-08-03, item 15 of the 20-point
# plan / brainstorm §23): it auto-evaluates up to 5 new top-ranked, not-yet-
# evaluated postings per night via real `claude -p` calls, real token spend,
# unattended — that cap and "only if genuinely new" behavior is intentional
# (Aditya's explicit choice), not a bug. See auto-evaluate-top-picks.mjs's own
# header for the selection logic. Installed via launchd, see
# .claude/notes/automation-2026-07-28.md for the install/uninstall steps.
set -euo pipefail
cd "$(dirname "$0")/.."

# launchd's default PATH is minimal and excludes Homebrew — this script uses
# absolute node paths so it doesn't need this, but set for consistency/safety
# in case a future script.mjs shells out to something on PATH.
export PATH="/opt/homebrew/bin:$PATH"

LOG_DIR=".claude/notes/cron-logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/daily-scan-$(date +%Y-%m-%d).log"

{
  echo "=== daily scan: $(date) ==="
  /opt/homebrew/bin/node scan.mjs
  /opt/homebrew/bin/node filter-inbox-by-fit.mjs
  /opt/homebrew/bin/node score-inbox.mjs
  /opt/homebrew/bin/node auto-evaluate-top-picks.mjs
  echo "=== done: $(date) ==="
} >> "$LOG" 2>&1
