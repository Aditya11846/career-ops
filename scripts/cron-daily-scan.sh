#!/bin/bash
# Daily cron entrypoint: scan.mjs -> filter-inbox-by-fit.mjs -> score-inbox.mjs.
# Zero-LLM-cost pipeline (scan/filter/score are all deterministic scripts, no
# claude -p call) — safe to run unattended every day. Installed via launchd,
# see .claude/notes/automation-2026-07-28.md for the install/uninstall steps.
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
  echo "=== done: $(date) ==="
} >> "$LOG" 2>&1
