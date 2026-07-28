#!/bin/bash
# Weekly cron entrypoint: re-run the "widen-watchlist" discovery pass headless,
# independent of the web app's dev server (calls claude -p directly).
#
# IMPORTANT: this prompt and tool-scope MUST mirror
# web/src/app/api/run/route.ts's buildPrompt(kind === "widen-watchlist",
# input="") exactly, so the cron path and the dashboard button never drift.
# If that branch changes, update this file to match.
#
# After a successful run, snapshots portals.yml (revert safety, since it's
# gitignored) and commits + pushes automatically — same checkpoint habit
# used manually all session. Disable auto-push by commenting out the last
# block below if you'd rather review before it goes to origin.
set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR=".claude/notes/cron-logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/weekly-widen-$(date +%Y-%m-%d).log"
CLAUDE=/Users/adium/.local/bin/claude

PROMPT='You are widening career-ops'"'"' company watchlist (portals.yml), headless, on the user'"'"'s own machine. This is the SAME real-verification standard used throughout this project'"'"'s history — a company is only ever added with a CONFIRMED, LIVE, working config. Never guess a careers_url, never add a company with an unconfirmed ATS.

Discover NEW candidate companies not already in portals.yml, using the domain already encoded in config/profile.yml (target_roles/narrative) — search recent (current year) analyst category pages (e.g. G2 category listings for the relevant software category) and recent funding-round news for companies in this space. Prioritize quality of verification over quantity of candidates found.

For each candidate company, verify in this order — real HTTP checks, not assumptions:
1. Greenhouse: try `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` for slug variants derived from the company name (lowercase, hyphenated, no-space) — a real JSON response with a non-empty "jobs" array confirms it.
2. Ashby: try `https://api.ashbyhq.com/posting-api/job-board/{slug}`.
3. Lever: try `https://api.lever.co/v0/postings/{slug}?mode=json`.
4. Workday: search for the company'"'"'s real careers page, look for a `{tenant}.{instance}.myworkdayjobs.com` URL, then POST to `https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"appliedFacets":{},"limit":5,"offset":0,"searchText":""}` — a real response with a "total" count confirms it. IMPORTANT: even if the company'"'"'s human-facing careers page looks like an empty JS shell with no visible links, the Workday API itself often still works independently of the page'"'"'s own rendering — always test the API directly, never conclude "unscannable" from the page alone.
5. If none of the 4 resolve: fetch one real individual job-listing detail page (not the search/listing page) and check for `<script type="application/ld+json">` containing `"@type":"JobPosting"`. If found, also check whether the LISTING page itself has real server-rendered `<a href>` links to other job detail pages matching a consistent URL pattern — if so, this company can use `provider: jsonld-jobposting` with a `job_link_pattern` field (see providers/jsonld-jobposting.mjs'"'"'s existing listing-discovery mode); if the listing page is a JS shell with no real links, only a single-page (one known posting) config is possible, or the company is genuinely unscannable this way.

For each CONFIRMED company, edit portals.yml directly: add a new entry under tracked_companies with careers_url, provider (and job_link_pattern/api if applicable), enabled: true, and a notes field following the exact convention already used throughout this file — cite what was confirmed and today'"'"'s date. Preserve all other YAML structure, comments, and formatting exactly; touch ONLY the new entr(y/ies) you just verified.

Never add a company with an unconfirmed ATS, not even as a disabled placeholder with a guessed URL — if nothing resolves, just don'"'"'t add it and say so in your final report.

End with EXACTLY one final line: VERDICT: {number of companies confirmed and added}/5 — {names added, or "none confirmed" and why, ≤20 words}'

{
  echo "=== weekly widen-watchlist: $(date) ==="

  BEFORE_HASH="$(shasum portals.yml | cut -d' ' -f1)"

  "$CLAUDE" -p "$PROMPT" \
    --output-format text \
    --permission-mode acceptEdits \
    --allowedTools "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep" \
    --disallowedTools "Task,NotebookEdit"

  AFTER_HASH="$(shasum portals.yml | cut -d' ' -f1)"

  if [ "$BEFORE_HASH" != "$AFTER_HASH" ]; then
    echo "--- portals.yml changed, snapshotting + committing ---"
    /opt/homebrew/bin/node snapshot-config.mjs
    git add .claude/notes/config-snapshots/
    git commit -m "Snapshot config: weekly widen-watchlist cron run $(date +%Y-%m-%d)"
    git push origin main -q
  else
    echo "--- portals.yml unchanged, nothing to commit ---"
  fi

  echo "=== done: $(date) ==="
} >> "$LOG" 2>&1
