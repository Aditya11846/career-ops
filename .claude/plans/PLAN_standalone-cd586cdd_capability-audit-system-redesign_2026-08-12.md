# Rebuild career-ops as Amit's 24/7 autonomous job search agent

**Date:** 2026-08-12
**Status:** PLANNED
**Bead(s):** none
**Epic:** Amit Job Search Automation — Full Autonomous Agent
**Chain:** `standalone-cd586cdd` seq `1`
**Context:** See `HANDOFF_standalone-cd586cdd_capability-audit-system-redesign_2026-08-12.md` for full session data, tool inventory, architecture map, and gap analysis.

---

## Problem Statement

Amit has been unemployed for 2 years. career-ops was promised as a 24/7 autonomous job search agent but delivered a 112k-line manual to-do list. Every major system branch has at least one gap that pushes work back to Amit: scanners require manual company curation, inbound replies require copy-pasting emails, follow-ups calculate but never send, and 70% of ATS platforms are unsupported. This plan closes those gaps in priority order. The bar: Amit gets a job offer without doing anything except showing up to interviews.

Key numbers from the audit (see Evidence & Data in handoff):
- apply stack covers Greenhouse/Lever/Ashby only (~30% of ATS market)
- LinkedIn Easy Apply explicitly skipped in `run-approved.mjs` (massive hole)
- `title_filter.positive` is EMPTY — scan-ats-full floods or returns nothing useful
- Gmail MCP is confirmed available but wired into exactly zero career-ops scripts
- Neither scanner runs on any schedule

## Key Findings

- **Stagehand LOCAL mode solves apply brittleness** — AI vision replaces CSS selectors; real Chrome inherits Amit's auth everywhere → drives Phase 1
- **Gmail MCP is the highest-leverage single wire-up** — one script replaces the entire manual paste-reply.mjs flow; recruiter emails auto-classify and update the tracker → drives Phase 2
- **scan-ats-full.mjs is genuinely autonomous but misconfigured** — empty title_filter + no schedule means it's never run usefully in production → drives Phase 3
- **signal-agent heat scores compute but never trigger anything** — heat is calculated and stored but no downstream consumer ever reads it to decide "scan this company harder" → Phase 4 (future, on hold)
- **LinkedIn Easy Apply is the single biggest job volume unlock** — currently explicitly skipped; Stagehand + real Chrome reopens the dominant channel for senior security roles → Phase 1 extension
- **opencli linkedin has 23 commands** including `job-detail`, `people-search`, `safe-send`, `inbox` — none wired into career-ops workflows
- **reply-tracker/gmail-watcher.mjs existence is unverified** — may be dead code; must check before claiming Gmail is handled anywhere

## Anti-Goals (What NOT To Do)

- **Do NOT touch signal-agent** — explicitly on hold. writeCompanySignal bug is known. User will say when to resume. Don't mention it.
- **Do NOT add companies to portals.yml manually** — scan-ats-full.mjs is autonomous; portals.yml grows only for scan.mjs company-specific overrides
- **Do NOT use headless Playwright for authenticated flows** — it has no auth. Use opencli (real Chrome bridge) or Stagehand LOCAL mode (real Chrome profile)
- **Do NOT build new scanner adapters** — scan-ats-full.mjs already covers Greenhouse/Lever/Ashby/Workday autonomously. Build the Stagehand universal provider instead (Phase 5)
- **Do NOT put the work on Amit** — every "paste this," "add this," "approve this" is a failure. Design around it.

---

## Plan

### Phase 1 — Fix Apply: Stagehand replaces CSS selectors

**Goal:** The apply flow covers every ATS without brittle CSS selectors, and LinkedIn Easy Apply is no longer skipped.

**Why this approach:** `extract.ts` breaks on Workday randomized class names. Stagehand's `page.extract()` uses AI vision — no selectors. The `stagehand-driver.ts` plan is already written at `PLAN_stagehand-apply-upgrade_2026-08-11.md`. Stagehand LOCAL mode targets Amit's real Chrome (`userDataDir`), inheriting all auth.

Implementation steps:
- `cd web && npm install @browserbasehq/stagehand` (adds to `web/package.json`)
- Create `web/src/lib/apply/stagehand-driver.ts` with Stagehand page context, wrapping `page.act()` for filling and `page.extract()` for reading — see PLAN_stagehand-apply-upgrade for exact API calls
- Add `detectAts(url): AtsType` in `apply-agent/run-approved.mjs` — regex match on hostname: workday.com, icims.com, smartrecruiters.com → Stagehand; greenhouse.io/lever.co/ashby.com → existing path
- Route Workday/iCIMS/SmartRecruiters URLs through `web/src/lib/apply/stagehand-driver.ts` instead of `extract.ts`
- Remove the LinkedIn Easy Apply skip comment (`f414feb`) — wire `opencli linkedin job-detail <url>` to get apply URL, then Stagehand fills the Easy Apply modal
- Phase 2a from full vision: auto-answer screening questions against `config/profile.yml` + `modes/_profile.md`; pause only if question is genuinely ambiguous
- Phase 2b: salary fields — read label context, fill from `config/profile.yml` comp targets, pause only on equity/bonus percent fields
- Phase 2c: boilerplate fields (GitHub URL, LinkedIn URL, "how did you hear", portfolio URL) — map from profile, never pause

**Files:**
- `web/package.json` — add stagehand dep
- `web/src/lib/apply/stagehand-driver.ts` — create new
- `web/src/lib/apply/extract.ts` — keep for Greenhouse/Lever/Ashby; not deleted
- `apply-agent/run-approved.mjs` — add `detectAts()`, wire routing, remove LinkedIn skip

**Validates with:**
- `node apply-agent/run-approved.mjs --dry-run <workday_url>` → routes to Stagehand, no crash
- `node apply-agent/run-approved.mjs --dry-run <greenhouse_url>` → routes to existing path, no regression
- Find a real LinkedIn Easy Apply test posting, confirm modal fills without triggering anti-bot

**Rollback:** Revert `run-approved.mjs` to original routing; Stagehand driver file is additive (no regression on deletion)

---

### Phase 2 — Gmail MCP: close the inbound manual gap

**Goal:** Amit never pastes a recruiter email again. The system reads Gmail, classifies, matches to tracker, and updates status.

**Why this approach:** Gmail MCP tools (`mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Gmail__get_thread`, etc.) are confirmed available as deferred tools. `reply-watch.mjs` already has classification logic — it just needs a Gmail source instead of clipboard input. `paste-reply.mjs` exists only because Gmail wasn't wired. Wire Gmail in, and `paste-reply.mjs` becomes a fallback path for edge cases.

Implementation steps:
- Read `reply-tracker/gmail-watcher.mjs` first — verify if it's wired, partial, or dead code. Report before building.
- If dead/partial: create `reply-tracker/gmail-poll.mjs` — uses `mcp__claude_ai_Gmail__search_threads` with query `is:unread from:recruiter OR subject:application OR subject:interview` + date filter (since last run, stored in `data/gmail-poll-state.json`)
- For each thread: `mcp__claude_ai_Gmail__get_thread` → extract subject/from/body snippet → pass through `reply-watch.mjs`'s existing classification pipeline
- Classification output → `set-status.mjs` call for tracker update (already exists, already locked/atomic)
- Store last-poll timestamp in `data/gmail-poll-state.json` so re-runs are incremental
- Schedule via CronCreate (or loop skill if cron unavailable): every 30 minutes
- Test: manually label a Gmail thread as unread and run `gmail-poll.mjs` — verify tracker update

**Files:**
- `reply-tracker/gmail-poll.mjs` — create (or fix `gmail-watcher.mjs` if it's close)
- `data/gmail-poll-state.json` — auto-created on first run
- `data/applications.md` — updated by set-status.mjs (existing path, no change)

**Validates with:**
- `node reply-tracker/gmail-poll.mjs --dry-run` → prints classified threads without writing
- Real recruiter email in Gmail → run poll → tracker row updates

**Rollback:** Delete `gmail-poll.mjs`, remove cron. paste-reply.mjs still works as before.

---

### Phase 3 — Discovery: configure and schedule the autonomous scanners

**Goal:** Scanners run on a schedule with Amit's real keywords. New roles appear in pipeline.md without anyone running a command.

**Why this approach:** scan-ats-full.mjs is autonomous and correct, but `title_filter.positive` is empty (the code itself warns about this), and neither scanner runs automatically. This is a pure configuration + scheduling fix — no new code needed.

Implementation steps:
- Read `config/profile.yml` → extract Amit's target role keywords (Zero Trust, endpoint security, DLP, SASE, network security, security engineering, cybersecurity, IAM, identity)
- Add to `portals.yml` `title_filter.positive`: `["security engineer", "security architect", "zero trust", "endpoint security", "DLP", "SASE", "IAM", "identity security", "network security", "cybersecurity engineer"]`
- Add to `portals.yml` `title_filter.negative`: `["intern", "junior", "associate", "entry level"]` (Amit is senior)
- Verify location filter reflects Amit's actual preferences (remote-first? specific cities?)
- Schedule `scan-ats-full.mjs --seeds yc,a16z` via CronCreate every 48 hours (balance freshness vs. rate limits)
- Schedule `scan.mjs` via CronCreate every 24 hours (company-first, fast, no rate limit concern)
- Both scanners write to `data/pipeline.md` — verify merge does not duplicate on re-scan
- After first scheduled run: check `data/pipeline.md` volume — if > 50 new entries in one pass, title_filter may still be too broad; tighten

**Files:**
- `portals.yml` — update `title_filter.positive`, `title_filter.negative`, verify location
- No new script files needed

**Validates with:**
- `node scan-ats-full.mjs --seeds yc,a16z --dry-run` (if --dry-run flag exists) or `node scan-ats-full.mjs --seeds yc,a16z 2>&1 | head -50` → confirms keyword filtering triggers
- `node stats.mjs --summary` → scan-runs.tsv should show at least 1 run after scheduling
- `wc -l data/pipeline.md` → growth bounded (not exploding)

**Rollback:** Remove cron entries. portals.yml changes are user-layer (safe to edit anytime).

---

### Phase 4 — LinkedIn outreach: from draft to send

**Goal:** The `contacto` mode drafts outreach AND sends it. Amit's network grows without manual LinkedIn copy-paste.

**Why this approach:** `contacto` mode already drafts a ≤300-char message tailored to the contact type. `opencli linkedin safe-send` command exists. The gap is a one-line wire: after draft is approved or auto-approved (for hiring managers at high-heat companies), call `safe-send`.

Implementation steps:
- Read `modes/contacto.md` to understand current draft-only flow
- Add approval gate: for Amit to review the draft before sending (respect ethical use rules — see AGENTS.md)
- After approval: `opencli linkedin safe-send --to <profile_url> --message "<draft>"` 
- Log to `data/relationships.md` with timestamp and message preview (existing relationships tracker)
- Trigger `relationships.mjs --touch <person>` to update LastContact date
- For follow-up scheduling: after send, compute next follow-up date (5 business days default) and append to `data/follow-ups.md`

**Files:**
- `modes/contacto.md` — add post-draft send step with approval gate
- No new script files needed; opencli + relationships.mjs already exist

**Validates with:**
- Run contacto mode against a test LinkedIn profile URL → draft appears → user approves → `opencli linkedin safe-send` called → `data/relationships.md` updated

**Rollback:** Remove send step from contacto.md. Draft-only behavior is restored.

---

### Phase 5 — Stagehand universal scanner (any careers URL)

**Goal:** Any company with a careers page becomes scannable without a custom ATS adapter.

**Why this approach:** scan.mjs today covers only companies on Greenhouse/Ashby/Lever APIs (~30% of market). Phase 5 adds a `providers/stagehand.mjs` provider: given any `careers_url`, Stagehand navigates, extracts all job listings, returns them in the standard PortalEntry shape. This is the complement to Phase 1 (apply side) for the discovery side.

Implementation steps:
- Create `providers/stagehand.mjs` — Stagehand LOCAL, navigate to `careers_url`, `page.extract("extract all job listing titles, URLs, and locations")`, return array of `{title, url, location}`
- In `portals.yml`, add `provider: stagehand` for companies that don't have an ATS API (Cisco, Palo Alto, CrowdStrike's custom page, etc.)
- `scan.mjs` already iterates providers by name; add `stagehand` to provider registry
- Handle pagination: if extracted results contain a "next page" link, navigate and extract until no more pages
- Rate limit: 2-second delay between Stagehand navigations (respectful crawling)
- On error (page load failure, timeout): log to `data/scan-errors.tsv`, continue to next company

**Files:**
- `providers/stagehand.mjs` — create new
- `portals.yml` — add `provider: stagehand` to target companies
- `scan.mjs` — register stagehand provider

**Validates with:**
- `node scan.mjs --company cisco --provider stagehand` → returns job listings without a Greenhouse/Lever/Ashby API call
- Compare results against manual browsing of the careers page

**Rollback:** Remove `providers/stagehand.mjs`, revert portals.yml companies to prior provider.

---

## Dependencies & Order

- Phase 1 (Stagehand apply) is the foundation — Stagehand must be installed before Phases 4 and 5 can use it
- Phase 2 (Gmail) is fully independent — can run parallel to Phase 1
- Phase 3 (scanner config + schedule) is fully independent — can run parallel to Phases 1 and 2
- Phase 4 (LinkedIn outreach) depends only on opencli being connected (already verified) — independent of Phases 1-3
- Phase 5 (Stagehand scanner) depends on Phase 1's Stagehand install being confirmed
- Recommended spawn order: Phase 1 + Phase 2 + Phase 3 in parallel, then Phase 4, then Phase 5

## Risks & Mitigations

- **LinkedIn anti-bot detection (Phase 1 Easy Apply):** Stagehand + real Chrome reduces risk significantly but not to zero. LinkedIn detects unusual automation patterns even from real browsers. Mitigation: add random delays (1-3s) between field fills, use `opencli linkedin safe-send` (designed for this) rather than Stagehand for message sends specifically.
- **Gmail OAuth scope (Phase 2):** Gmail MCP may require additional OAuth consent for read access. Mitigation: load the Gmail MCP tool schema first and check what scopes it declares; if re-auth needed, user must approve once in browser.
- **scan-ats-full flooding (Phase 3):** Empty title_filter currently returns everything. After adding filters, first run may still return hundreds of entries if filters are too broad. Mitigation: add `--limit 20` flag for the first dry run; review before scheduling.
- **Stagehand version pinning (Phases 1 and 5):** Stagehand v4.0.0 is confirmed available. Don't pull latest without checking changelog — API surface changed significantly between v3 and v4. Mitigation: pin `"@browserbasehq/stagehand": "^4.0.0"` in package.json.
- **Next.js web server not running (Phase 1):** orchestrator.ts calls `http://localhost:3000`. If server is down, all apply sessions fail silently. Mitigation: add server health check at start of `run-approved.mjs` — if 3000 not responding, log error and halt before processing queue.

## Success Criteria

- **Minimum viable:** Gmail polling runs every 30 minutes; title_filter is populated and scanners run on schedule; Workday apply no longer breaks on CSS selectors → 3 closes in one month with zero Amit manual input
- **Full success:** LinkedIn Easy Apply firing; Stagehand universal scanner covers 10+ companies not previously scannable; Amit's Gmail is the only thing he touches during the job search; tracker updates itself → job offer within 60 days
- **Leading indicator to check at 2 weeks:** `node stats.mjs --summary` shows scan-runs increasing automatically; `data/applications.md` has new Applied rows that Amit didn't trigger; `data/follow-ups.md` has auto-generated entries

---

## Quick Start

```bash
# Full session context
cat /Users/adium/career-ops/.claude/plans/HANDOFF_standalone-cd586cdd_capability-audit-system-redesign_2026-08-12.md

# Stagehand apply plan (Phase 1 detailed spec)
cat /Users/adium/career-ops/.claude/plans/PLAN_stagehand-apply-upgrade_2026-08-11.md

# Full Stagehand vision (all 9 phases context)
cat /Users/adium/career-ops/.claude/plans/PLAN_stagehand-full-vision_2026-08-11.md

# Key source files for Phase 1
# apply-agent/run-approved.mjs (routing + LinkedIn skip)
# web/src/lib/apply/extract.ts (CSS selector layer to replace)
# web/src/lib/apply/session.ts (Playwright core, see what Stagehand replaces)

# Key source files for Phase 2
# reply-tracker/gmail-watcher.mjs (check if alive or dead)
# reply-watch.mjs (classification pipeline to reuse)
# paste-reply.mjs (manual path to replace)

# Key source files for Phase 3
# portals.yml (add title_filter.positive here)
# scan-ats-full.mjs L447 (the empty-filter warning)

# Verify Stagehand not yet installed
ls web/node_modules/@browserbasehq/stagehand 2>/dev/null || echo "not installed"

# Verify opencli still connected
opencli daemon status

# Verify Gmail MCP available (load schema)
# ToolSearch with query "select:mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread"

# First concrete action — Phase 1
cd /Users/adium/career-ops/web && npm install @browserbasehq/stagehand@^4.0.0
```
