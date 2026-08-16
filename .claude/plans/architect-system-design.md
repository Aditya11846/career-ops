# Career-Ops — Architect Session: Full Architecture & Flow Design Doc

_Compiled 2026-08-05 from a full-system deep-dive session. This is the durable spec other sessions (delegated feature-implementation sessions, testing sessions) should read before touching code. Workflow: Aditya + this "Architect" session discuss/design each feature here, then a fresh isolated session is spawned per feature with this doc + a specific design brief, implements it, reports back for review, gets merged. Repeat._

## 1. Purpose

Career-ops was originally built for Aditya, but as of 2026-08-02 it pivoted entirely to target **Amit Kumar Singh** (Aditya's father): a 22-year senior systems/security engineer (Zero Trust, endpoint encryption, embedded/kernel security, ex-Broadcom/Symantec), targeting Principal/Staff/Distinguished IC or EM/Director security roles, Pune-based, remote-only or Pune-hybrid, no relocation. He has been searching for 1.8 years without success. This is not a resume-builder side project — it's a tool aimed at breaking a specific stuck situation.

**Core design insight encoded in the profile:** for a search like his, *title* is not a useful filter — a "Staff Security Engineer" and a "Principal Zero Trust Architect" posting are both real candidates. `portals.yml`'s title filter is therefore deliberately left empty. What matters instead is:
- **Domain fit** (Zero Trust / endpoint / embedded-security keyword match)
- **Compensation** (India-tax-resident effective value, not raw USD)
- **Geo-eligibility** (remote-from-India or Pune-hybrid; hard-blocked otherwise)

---

## 2. Pipeline Overview

```
scan.mjs / scan-ats-full.mjs        → pulls postings from 11 job boards + ATS APIs
        ↓
filter-inbox-by-fit.mjs             → 3 gates, each writes rejects to its own file:
                                         domain-fit (compute-fit.mjs)
                                         geo-eligibility (india-eligible / global-remote / restricted / unknown)
                                         liveness (dead-posting check)
        ↓
score-inbox.mjs                     → ranks survivors (fitRank), zero LLM cost
        ↓
auto-evaluate-top-picks.mjs         → nightly, headless `claude -p`, evaluates top 5
   (or the web dashboard's            real token spend, real reports + tracker rows
    "Evaluate top N" button)
        ↓
reports/{n}-{company}-{date}.md     → full evaluation, score, hard_stops
        ↓
merge-tracker.mjs                   → data/applications.md (single source of truth)
        ↓
apply/ (mostly unfinished)          → CV tailoring, then fill-and-submit — the weak link
```

**Live numbers at time of writing:** 8,199 postings scanned since 2026-07-27, across 703 companies (45 tracked companies + 11 job boards). 17 real evaluations completed, average fit 1.9/5, top score 3.2/5. **Zero applications ever submitted** — everything upstream (scan/filter/rank/evaluate) is solid and verified; the submit step is where the system has never actually closed the loop.

---

## 3. The Two Code Layers

1. **CLI layer** — `.mjs` scripts run directly (`node scan.mjs`, etc.), driven by Claude Code in a terminal, following `AGENTS.md` / `modes/*.md` as instructions. The original, most-tested path.
2. **Web layer** (`web/`, Next.js) — a real dashboard: pipeline/inbox triage view, apply page, config, analytics. It shells out to the same underlying scripts/modes rather than reimplementing logic (verified architecture, not just claimed). Most recent UI work (top-pick badges, cost tracking) has landed here.

Both layers read/write the same `data/` files — they are two front ends on one pipeline, not two separate systems.

---

## 4. Data Contract (migration-critical)

Files split into two trust tiers:

- **User layer** (never auto-updated, Amit's actual personalization): `cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`, everything in `data/`, `reports/`, `output/`. `config/profile.yml` and `portals.yml` are **gitignored** — they don't travel via `git push`/`pull` at all and must be copied manually.
- **System layer** (auto-updatable, shared code): everything else — `.mjs` scripts, `modes/_shared.md`, `AGENTS.md`, `web/`. This is what's in the git repo and what `update-system.mjs` can pull updates for later.

---

## 5. Identity & Config Layer

Three gitignored "user layer" files drive everything: `config/profile.yml` (identity, target roles, archetypes, comp targets), `portals.yml` (the company/board list to scan — 45 tracked companies + 11 job boards), `cv.md` (canonical CV, markdown).

`portals.yml` has 4 top-level sections: `title_filter` (deliberately near-empty), `location_filter`, `tracked_companies` (~390 lines, the bulk of the file), `job_boards` (the 11 aggregators).

---

## 6. Discovery Layer — `scan.mjs` (2,022 lines) + `providers/*.mjs` (54 provider files)

Each provider file implements one `fetch(company, ctx) → Job[]` adapter for one ATS or board type (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, RemoteOK, HackerNews-who's-hiring, etc.). Most are thin JSON-API wrappers; a few (`local-parser.mjs`) fall back to HTML scraping when no clean API exists.

**`main()` flow, precisely:**

1. Load all providers via `loadProviders()`, optionally merging auth-gated plugin providers (Apify, etc. — opt-in, off by default).
2. Parse `portals.yml`.
3. Build filter functions ahead of time — `buildTitleFilter`, `buildLocationFilter`, `buildPostingAgeFilter`, `buildSalaryFilter`, `buildContentFilter`, `buildVisaFilter`, plus a `buildTrustValidator` (scores posting legitimacy) — each a closure over the relevant `portals.yml` section.
4. `resolveEntries()` maps each `tracked_companies`/`job_boards` entry to a provider (by matching `ats_type` or inferring from `careers_url`), skipping disabled entries, and collecting an `agentHandoff` list for `scan_method: websearch` entries (companies with no clean API — handed to an agent to search manually, not auto-scanned).
5. Load `data/blacklist.md` (do-not-apply companies, opt-in).
6. Load dedup state: `loadSeenUrls()` reads `data/scan-history.tsv` (every URL ever scanned, with a configurable re-check policy); `loadSeenCompanyRoles()` reads `data/applications.md` itself to catch "same company+role even if the URL changed" dupes.
7. Fan out `provider.fetch()` calls concurrently (`parallelFetch`, bounded concurrency). Each returned job gets trust-scored first (`trustScore`/`trustFlags`/`trustLevel` — runs before any filter, never drops a posting, pure enrichment), then passed through: blacklist → title filter → tier filter (if `skip_tiers` configured, via `classify-tier.mjs`) → location filter → posting-age filter → salary filter → content filter → visa filter → cooldown filter (re-apply windows from `loadReApplyWindows`) → dedup against seen URLs/company-roles.
8. Survivors get appended to `data/pipeline.md`'s `## Pending` section (`appendToPipeline`) and logged to `data/scan-history.tsv` (`appendToScanHistory`), plus a run summary line to `data/scan-runs.tsv` (`appendScanRunSummary`).

`--verify` mode additionally runs a live Playwright liveness check per-offer (`verifyOffers()`) before writing, with `--headed-fallback`/`--throttle`/`--rediscover-404` options for sites that anti-bot-wall headless requests.

This step costs zero LLM tokens — pure HTTP fetches against public JSON APIs.

---

## 7. Triage Layer — `filter-inbox-by-fit.mjs` (3 gates, still zero-LLM)

Runs after scan, operates only on `data/pipeline.md`'s Pending section:

- **Gate 1 — Domain fit** (`compute-fit.mjs`'s `scoreDomainFit()`): a 3-tier keyword scorer — strong keywords (zero trust, endpoint encryption, UEFI, kernel driver, vulnerability, incident response, etc.) worth 15pts each, moderate (C++, firmware, cryptography, etc.) worth 6, general (Python, Java, TCP/IP) worth 3, summed and clamped 0–100. Threshold for this cheap title-only pass is `TITLE_FIT_MIN_SCORE = 1` — deliberately much lower than the JD-text threshold (`DOMAIN_FIT_GATE_THRESHOLD = 20`) used later at full-evaluation time, since a 3–5 word title can realistically only ever hit one or two keywords.
- **Gate 2 — Geo eligibility** (`classifyGeoEligibility()`): classifies into `india-eligible | global-remote | restricted | unknown` using layered regex evidence — explicit India/IND mentions win first, then explicit work-authorization negative language ("must be a US citizen", "security clearance required"), then bare "distributed"/"worldwide" (but not region-qualified variants like "APAC - Distributed"), then a list of other-country/US-state names plus Workday's 3-letter country codes, else unknown. Below `GEO_GATE_CONFIDENCE_THRESHOLD = 20` and tier `restricted` → filtered out.
- **Gate 3 — Liveness** (`liveness-api.mjs`): `checkLivenessViaApi()` tries the posting's ATS API directly (Greenhouse/Lever/Workday are per-job endpoints where 200=live; Ashby is org-level so it parses the board JSON and checks `isListed`), SSRF-guarded (fixed host, strict path-segment charset, no redirects followed). Falls back to `checkLivenessViaFetch()` (plain HTTP GET, no browser) for non-ATS aggregator mirrors, feeding the response into the same `classifyLiveness()` pure classifier that the Playwright-based rung (`liveness-browser.mjs`) uses — checks HTTP status, bot-challenge patterns (Cloudflare "Just a moment", hCaptcha — treated as uncertain, never expired), hard "no longer available" body-text patterns, URL-redirect-lost-job-id heuristics, and apply-control presence. Everything ambiguous defaults to keeping the posting.

Each gate writes rejects to its own separate file (`pipeline-filtered.md`, `pipeline-geo-filtered.md`, `pipeline-dead-filtered.md`) rather than deleting anything, specifically because `web/src/lib/career-ops.ts`'s `readInbox()` scans `pipeline.md` for any checkbox line regardless of section heading — a same-file "filtered" section would still leak into the dashboard.

---

## 8. Ranking Layer — `score-inbox.mjs` (zero-LLM, writes `data/posting-signals.json`)

For every survivor, computes `computeInboxRank()` = domain-fit (60%) blended with company stability (40%, from `signal-agent/compute-heat.mjs`'s stored heat/layoff_risk, null-safe defaults if the company was never signal-scored). Writes `{url: {company, role, domainFit, rank, geoEligibility, geoEvidence, updatedAt}}` atomically via `tracker-utils.mjs`'s `writeFileAtomic()`. This `rank` field is what both the dashboard's "top pick" badge and `auto-evaluate-top-picks.mjs`'s selection sort on.

---

## 9. Evaluation Layer — real LLM cost, `modes/oferta.md`

A full evaluation follows a fixed rubric structure:

`Liveness gate → Blacklist gate → Bounded Research Budget → Step 0 (Archetype Detection) → Block A (Role Summary) → Block B (Match with CV) → Block C (Level and Strategy) → Block D (Comp and Demand) → Block E (Customization Plan) → Block F (Interview Plan) → Block G (Posting Legitimacy) → Risk Summary → optional Cover Letter Draft → Machine Summary`

Block D is where `compute-fit.mjs`'s `scorePosting()` gets invoked for `comp_effective_value_inr` / `india_hireability_confidence` / `fit_rank`. The Machine Summary is a structured YAML block that every downstream script parses — `hard_stops`, `final_decision`, the scores.

**Comp math** (`compute-fit.mjs`): converts any offer into net-INR annual effective value assuming India tax residency — real slab-based tax calc (`computeIndianTaxINR`, illustrative new-regime slabs, explicitly flagged as approximate, not legal-filing-grade), FX via a live API (`open.er-api.com`) with a static fallback table, and a real risk-adjustment: cash counted at full weight, public-company RSUs haircut 50% (vesting-cliff/volatility risk), private-company equity excluded entirely from the ranked number (informational only — resolved design principle: "priority is reliable income after an 18-month gap, not speculative illiquid upside").

---

## 10. Persistence Layer — `merge-tracker.mjs` + `tracker-utils.mjs`

Every evaluation writes a TSV to `batch/tracker-additions/{num}-{slug}.tsv`, never edits `data/applications.md` directly. `merge-tracker.mjs` parses it (`parseTsvContent`, `parseAppLine`, validating status against `templates/states.yml`, `parseScore`), dedupes by company+role+report-num, and writes the merged tracker back through `tracker-utils.mjs`'s locking primitive:

- `acquireTrackerLock()` — a real `mkdir`-based mutex with owner metadata (pid/token/timestamp written to `owner.json`)
- Stale-lock recovery guarded by a second nested lock (`{lockDir}.recover`) to prevent two processes racing on the recovery decision itself
- PID-liveness checking so a crashed process's lock doesn't block forever
- The actual file write goes through `writeFileAtomic()` — write to a same-directory temp file, then `renameSync` (atomic on the filesystem, so no reader ever sees a half-written tracker)

---

## 11. Automation Layer

`scripts/cron-daily-scan.sh`, launchd-scheduled, runs 4 steps in order:

`scan.mjs → filter-inbox-by-fit.mjs → score-inbox.mjs → auto-evaluate-top-picks.mjs`

Only the last step has real token cost — headless `claude -p` calls, sequential (not parallel, so report-number reservation never races), capped at top-5-not-yet-evaluated per night, selection logic mirrors the dashboard button exactly.

---

## 12. Web App Layer (`web/`, Next.js)

~32 API routes. Confirmed discipline pattern: routes that only read data (`api/tracker`, `api/portals`, etc.) are pure TypeScript; every route that mutates canonical state either shells out to the real `.mjs` scripts/`modes/*.md` via `spawn` (`api/run/route.ts` — what both `auto-evaluate-top-picks.mjs` and the dashboard's evaluate button ultimately trigger, for different reasons: the script calls `claude -p` directly, the web button calls this API which spawns the CLI) or writes through the same `lib/apply/session.ts` used everywhere else. No route reimplements scoring/tailoring/tracker logic independently.

---

## 13. Apply/Submit Layer — the CLI path (`apply-agent/`)

`apply-agent/orchestrator.ts` is the state machine:

`relocation gate → open session (POST /api/apply/session, drives a real Playwright browser via session.ts) → check for blocking issues (captcha/bot-challenge/login-wall/auth-required → pause immediately, log to data/needs-input.md) → field-mapper.mjs's mapFields()`

`mapFields()` maps extracted form fields to profile values via **9 hardcoded regex label rules** (first/last/full name, email, phone, LinkedIn, GitHub, portfolio, location). Anything matching a salary-pattern regex is flagged separately (`salaryFields`, always pauses — "requires a specific number" is an explicit spec-level pause trigger); anything required-but-unmatched goes to `unmapped[]` (also always pauses; optional-and-unmapped is silently left blank, not a pause). **No dropdown, radio, checkbox, or free-text-essay handling exists in this file** — this is the CLI path's literal, confirmed limitation.

If the fill is completely clean (every field filled, zero post-fill issues) and the run came through `run-approved.mjs --auto-submit` (i.e. the human already explicitly approved this specific job beforehand via `data/apply-approved.json`), it submits immediately via `POST /api/apply/submit`. Anything less than perfectly clean queues to `approve-queue.mjs` for fast human batch review rather than auto-submitting. **The trust boundary is approval before filling, not review after filling.**

---

## 14. Apply/Submit Layer — the Web Path (`session.ts`, `extract.ts`, `diagnose.ts`, `prefill/route.ts`)

This is a genuinely different, more capable system from the CLI path above — it does **not** use `field-mapper.mjs` at all. It has real select/radio/checkbox/combobox extraction and an LLM-drafted answer for every field type, including free text.

### Session lifecycle (`session.ts`)

A `Session` is an in-memory object (`Map<string, Session>` on `globalThis`, survives Next.js hot-reload but not a server restart) holding a real, headed Chrome tab: `{ id, url, title, fields, context, page, frame, createdAt }`.

**Why headed, not headless:** `headedBrowser()` launches real Google Chrome (`channel: "chrome"`, falls back to bundled Chromium if Chrome isn't installed) with `--window-position=-3200,-3200` — a real on-screen browser window, parked off the visible desktop during fill, on the user's own residential IP rather than a datacenter IP a headless bot-detector would flag. `handoffSession()` later repositions it on-screen via a raw CDP call (`Browser.setWindowBounds`) so `bringToFront()` actually surfaces it. Idle sessions auto-expire after 15 minutes (`prune()`); the whole browser process closes after 5 minutes with zero open sessions (`scheduleIdleClose`) to avoid leaking.

**`openSession(url, cliId, forceAgent, noApplyBtn, storageStatePath)` — the real open sequence:**

1. `gotoResilient()` — up to 3 attempts with backoff.
2. `statusBlock()` on the raw HTTP response — the cheapest possible check, before any DOM work: 401/407→auth-required, 451→geo-block, 403→bot-block (if Cloudflare headers present) or forbidden, 429→rate-limited, 5xx→server-error, 404/410→not-found. Hard abort, no wasted work.
3. `dismissConsent()` — auto-clicks known cookie-banner accept buttons (OneTrust, Cookiebot, Quantcast, TrustArc, plus a generic "Accept/Allow/Agree" role-button fallback). Never a hard block, just visual noise removal.
4. Waits for real form controls to render in any frame (`Promise.race` across `page.frames()`), then `dropNewTabs()` — strips `target="_blank"` from every link/form and monkey-patches `window.open` to navigate in-tab instead, since many "Apply" buttons are `<a target="_blank">` (e.g. openai.com → jobs.ashbyhq.com) and an unfollowed new tab would silently dead-end the flow.
5. `pickFormFrame()` — extracts from every frame on the page (main + all iframes, since Greenhouse/Lever/SmartRecruiters are often cross-origin embeds) and keeps whichever produced the most fields.
6. If that doesn't look like a real application form (`looksLikeApplicationForm()` — has a file/email/name-ish field vs. is all search/filter fields vs. is 3-or-fewer all-optional fields = a job-board search box, not an app), it retries: a bounded 3-step scroll pass (`nudgeScroll`, triggers lazy/virtualized fields), then `tryApplyTrigger()` (clicks a real "Apply" CTA — prefers a direct `<a href>` to a known ATS over a popup click; refuses anything labeled `/submit|applied|withdraw/`).
7. `enrichFromAts()` — for Greenhouse postings, fetches Greenhouse's real published JSON schema and overlays correct labels/types/options onto extracted fields (Greenhouse renders react-select widgets whose options never appear in the raw DOM).
8. Optional forced-AI mode (`forceAgent`): ignores deterministic extraction entirely and has an agent read the page directly — opt-in for users willing to spend tokens to avoid a heuristic miss.
9. If still nothing usable, `classifyEmpty()` decides why rather than emitting a generic failure — and if it's the ambiguous "no-form-but-not-a-hard-block" case with a CLI available, it keeps the session alive and hands off to a streamed agentic drive loop (`/api/apply/drive`) instead of aborting, so the user watches the agent navigate live.
10. Soft issues are surfaced, never swallowed: interactive-captcha warning, multi-step-form notice, "AI interpreted this" flag, unlabeled-field count.

### Field extraction (`extract.ts`)

Runs as a real `page.evaluate()` closure inside the browser:

- **Label resolution** (`labelFor`) tries, in order: `aria-label` → `aria-labelledby` → `<label for=id>` → wrapping `<label>` → nearest field-wrapper's label/legend/heading (handles Ashby's `ashby-application-form-question-title`, Greenhouse's `select__label`) → walks up to 4 ancestor levels for a nearby label/heading → placeholder → name attribute. Filters out UUIDs and generic placeholders ("Select...", "Choose", "--") so those never masquerade as real labels.
- **Radio groups** are deduped by name into one field with a real `options[]` list, with a purpose-built `groupLabel()` that finds the group's question (via `role=radiogroup`/fieldset legend) rather than accidentally grabbing the first option's own label.
- **react-select comboboxes** (`role="combobox"`) are detected, and the dummy autosize `<input>` react-select renders alongside is explicitly dropped so it doesn't show up as a bogus "Untitled field."
- Every real control gets tagged `data-co-field="{id}"` directly on the live DOM element — the deterministic handle the fill phase locates by, not a fragile CSS selector.

### Filling (`fillSession`) — per-type mechanics, and the hard safety line

- **text/email/tel/etc.:** plain `.fill(value)`
- **select:** `.selectOption({label})` falling back to value-based
- **checkbox:** `.setChecked()`, falling back to clicking the associated `<label>` (custom-styled checkboxes hide the real input), falling back to a forced check as a last resort — **except** it hard-refuses to auto-tick anything matching `/i agree|i consent|privacy notice|terms|gdpr/i` in its label, logging that as a step requiring the human's own confirmation, regardless of what value was passed in.
- **radio:** locates by the tagged `data-co-option` value
- **comboboxes (react-select):** click to open, type the value character-by-character, click the matching option — deliberately never presses Enter, since Enter inside a `<form>` can trigger a submit

**File attach:** any file field whose label matches `/resume|résumé|cv|curriculum|lebenslauf/i` gets the tailored CV PDF attached via `setInputFiles()` — other file fields (cover letter, portfolio) are explicitly left for the human.

After filling, `verifyFill()` reads the real DOM back — did every answer actually land (a react-select click can silently fail), are required fields still empty, is there a visible validation error on the page — surfacing mismatches as warnings before handoff, rather than trusting that "the fill script ran" means "the fill succeeded."

`submitSession()` is the **only** function in the codebase that ever clicks submit — this is explicit in the code's own comment, and it does **not** re-verify that human approval happened; it trusts the caller (`approve-queue.mjs`'s flow) already gated that. Submit-button matching handles real-world edge cases (e.g. `<button>Submit order</button>` with no `type` attribute) via a "contains" pattern plus a fallback to any non-cancel `<form>` button not explicitly typed `button`/`reset`.

### Answer generation for the web flow

The web `/apply` page's real answer source is `POST /api/apply/prefill` — **not** the 9-regex mapper. It spawns the user's own CLI (Claude Code, headless, read-only: `--allowedTools Read,Glob,Grep`, `--disallowedTools Bash,Write,Edit,...WebFetch,WebSearch` — a planner, no browser access, can't touch anything) with a prompt containing every extracted field (id/type/label/options), instructing it to read `cv.md`/`config/profile.yml`/the matching report, then draft a real answer per field — including free-text essay questions in the candidate's own voice, and select/radio answers using exact option text so the fill step's option-matching works. It explicitly refuses categories: **never** fills legal / visa / work-authorization / salary / demographic / sensitive fields → `needs_confirmation:true`, `value:""`. Output streams as NDJSON with live progress logging (this is what writes `.career-ops-web/apply-prefill.log`).

`extractJsonObject()` handles the planner getting killed mid-output on a large form — rather than failing the whole batch, it walks back through the truncated JSON fragment trying successively shorter valid prefixes so completed fields still come through.

### Where the real remaining gap is

The web path handles dropdowns, radios, checkboxes, comboboxes, and free-text essays — the things originally thought to be universally missing. What's actually still unfinished:

1. **`field-mapper.mjs`/`orchestrator.ts` (the CLI path)** still only does 9-regex identity-field mapping — a separate, weaker path from the web flow, not a shared dependency. May matter less in practice if the web dashboard becomes the primary driver.
2. **Workday is explicitly unsupported** (`classifyEmpty` hard-blocks it by hostname — "multi-step, account-gated," routed to apply directly) — and Workday is 3,078 of the 8,199 scanned postings (the single biggest source by volume). Scanning/evaluating Workday postings works fine; only auto-fill/submit refuses them.
3. **Legal/visa/salary/demographic fields** are by design always routed to human confirmation, never auto-filled — a safety choice, not a bug.
4. **CAPTCHA'd platforms** (Ashby confirmed) still route to manual-assist.

---

## 15. Open / Unstarted Items

1. **Apply/submit path** — the actual gap between "the tool works" and "an application went out" (see Sections 13–14).
2. **CAPTCHA'd platforms** (Ashby confirmed) — permanently out of scope, routed to manual-assist.
3. **Cover-letter chat-loop wiring** and **India-market rubric merge** (LPA/CTC framing, bond penalties) — both scoped but not started.
4. **Follow-up email auto-drafting** — small, not started.

---

## 16. Migration Risk List (for the eventual move to Amit's laptop)

- `/Users/adium/.local/bin/claude` is hardcoded in `auto-evaluate-top-picks.mjs` and `scripts/cron-daily-scan.sh` — will silently fail on a new machine unless swapped.
- launchd jobs (daily scan, weekly widen) are registered on the current Mac only — need re-registration.
- `.mcp.json` (Playwright MCP) is committed and portable — fine as-is.
- Chrome-extension-driven flows (the `/apply` page's live-form-read) only work from an interactive foreground session tied to a real open Chrome — need the new machine's own Chrome + extension, can't be pre-baked.
- Gitignored user files (`config/profile.yml`, `portals.yml`, `data/*`) won't come along via `git clone`/`git pull` — need explicit copy.
- `output/`, `reports/`, `data/applications.md` — the real evaluation history — whether the new machine inherits this history or starts clean is a real decision, not a mechanical step.

**Recommended sequencing:** stabilize the current machine first (there's active churn — liveness gate, ranking-evaluation connector), then do one clean handoff (copy `cv.md`/`config/profile.yml`/`portals.yml`/`data/`, swap hardcoded paths, re-register launchd/cron) once things settle, rather than migrating mid-churn.

**Model choice for migration/ongoing dev:** Opus is worth it for genuinely hard, open-ended build work (SSRF-safe URL handling, liveness-ladder design, multi-file bug hunts, the SQLite job-queue migration, `cover.md` chat-loop wiring, apply-agent field-mapper gaps) — a one-time, bounded cost per feature. Sonnet is the better fit for the nightly unattended auto-evaluate/scan/filter loop, since that runs indefinitely once shipped and is mechanical (JD extraction, rubric application, geo/domain classification) rather than deep reasoning.

---

## 17. Analytics — `stats.mjs` (the canonical lifetime funnel)

`stats.mjs` is the canonical, documented lifetime aggregator, zero token cost. Its funnel definition is the one every other script (including `funnel-velocity.mjs`) imports rather than recomputing:

- `everApplied` isn't "currently in the Applied status" — it's a cumulative "was ever submitted" figure, computed as **Applied + Responded + Interview + Offer + Rejected rows summed together**, because a rejection proves a submission happened even though the row's current status has moved past "Applied."
- Each later stage sums itself plus everything beyond it (so `everInterview` includes rows now at Offer or even Rejected-after-interview).
- Every rate is relative to `everApplied`, with an honest `smallSample: everApplied < 10` flag baked into the output contract itself.

At the time of this review, with `everApplied` at literally 0, every rate in the system is undefined/zero — which is itself the accurate, sobering summary of where the pipeline stands: everything upstream (scan→filter→rank→evaluate→track) is thoroughly built and instrumented, and none of it has yet produced a single real submission to measure.

---

## 18. Budget Tracking / Cost Accounting

Three separate systems, one of them silently unenforced — a real, significant finding on the same pattern as several others in this doc (signal-agent not automated, `_profile.md` archetypes stale): a real safety mechanism exists, is tested, is documented as "the single source of truth" — and turns out to only be half-wired into the code that actually runs.

**`budget-tracker.mjs`** defines two daily ceilings, stored in `data/usage-today.json` (auto-rolls over at IST midnight): `daily_llm_calls` (default 300) and `tier2_daily_cap` (default 25, per platform). `checkAndIncrement(kind)` is the enforcement primitive — check-and-increment atomically, refuse and log a needs-input entry on a cap hit, never silently degrade or retry. `isCapped(kind)` is a cheap pre-check callers are supposed to use before doing expensive work (opening a real browser session, etc.), reserving the actual increment for after the real event happens.

Checking every real call site in the codebase, not just the header comment's claim:

- `checkAndIncrement('tier2_apply_linkedin'|'tier2_apply_naukri')` is genuinely wired in — `apply-agent/tier2/driver-core.mjs` calls it for real, right after a fill completes.
- `checkAndIncrement('llm_call')` — the actual daily LLM-call ceiling — appears **nowhere** in the entire codebase except inside `budget-tracker.mjs`'s own self-test. Not in `auto-evaluate-top-picks.mjs` (the nightly unattended evaluator). Not in `web/src/app/api/run/route.ts` (every dashboard-triggered evaluate/pdf/contacto/research/compute-heat/fix-portal call). Not in the assistant chat loop. Not in signal-agent's WebSearch-driven scoring. Not in `api/apply/prefill/route.ts`'s planner call.

The file's own header claims it's "the single source of truth for daily caps (both LLM calls and Tier-2 applies), so the two numbers can't silently drift apart" — true for the Tier-2 half, **false in practice** for the LLM-call half: nothing actually checks or increments it, so the 300/day ceiling is a designed, self-tested, but completely disconnected safety net. Every real token-spending call in the system — the nightly 5-evaluation auto-run, manual dashboard evaluations, CV generation, outreach drafting, company-heat scoring — runs entirely outside this budget's awareness.

Separately, there's a real, working usage-observability system that isn't about enforcement at all — **`/api/usage/route.ts`**. This reads Claude Code's own actual per-message usage logs, machine-wide (not scoped to career-ops): it walks `~/.claude/projects/**/*.jsonl` (every Claude Code session transcript on the whole machine, across every project) and sums real token counts in rolling 5-hour and 7-day windows — deliberately matching the same window shape as the account's actual rate-limit windows, cached 60s since the walk is heavy. This is what actually backs the dashboard's live usage display — a genuinely accurate, real-time view of account-level spend, just not a per-action gate.

**`CostBadge`** (the small label attached to the "Evaluate top N picks" button) is purely a static UI primitive — it doesn't read live usage data at all, it just renders a fixed label/tooltip/icon based on a `CostClass` string (`"spend"`/`"free"`/`"free-gemini"`) the caller passes in. A deliberate design-system constraint is documented right in its own comment: spend badges are muted/neutral, never the brand's orange accent color — because orange is reserved for the primary "free" call-to-action ("Run your first FREE scan"), and an orange spend badge would visually collide with and out-shout that hero action.

**Honest summary of this subsystem:** real-time usage visibility is solid and genuinely useful (`/api/usage`), Tier-2 apply rate-limiting is solid and wired in, but the LLM-call daily ceiling — the thing that would actually stop runaway spend from the nightly auto-evaluate or a chatty assistant session — is untested-in-practice dead code, not a working safety net. Worth fixing whenever development resumes, though not urgent given current usage volume (17 real evaluations total, nowhere near 300/day).

---

## 19. Onboarding / Update Machinery + the Plugin Trust Boundary

**`doctor.mjs`** — two distinct modes sharing one deterministic prerequisite list (matching `AGENTS.md`'s own claim that `AGENTS.md` and `doctor.mjs` "share the same prerequisite list, so they can never drift").
- `--json` mode is the fast path used at session start — just `onboardingState()`, checking the 4 user-layer prereqs (`cv.md`/`config/profile.yml`/`modes/_profile.md`/`portals.yml`) plus auto-copying `_profile.template.md`/`_custom.template.md` into place the first time either is found missing.
- The plain-text mode runs the full checklist: Node version (specifically checking for ≥22.5, because `tracker.mjs`'s SQLite index needs the built-in `node:sqlite` module — a real, load-bearing version requirement, not just a nice-to-have), dependency checks, Playwright MCP configuration, font presence, the auto-managed directories, the pipeline file shape, and plugin discovery/status.

**`tracker.mjs`** — a real, working, already-shipped SQLite-derived index over the tracker. Markdown (`data/applications.md`) stays the single source of truth; the SQLite DB (`applications.db`) is rebuilt from it, safe to delete at any time (regenerates on next sync), and query/history commands auto-resync whenever the markdown has changed since the last sync, so a read can never come back stale.

The motivation is concrete: at hundreds of tracker rows, a plain markdown table degrades structurally — a stray `|` inside a cell shifts every column after it, encoding issues propagate silently, grepping the same table can get inconsistent reads. The index normalizes canonical statuses and repairs columns at sync time, so corruption gets caught immediately instead of silently compounding. Notably, "Phase 2" (the database becoming the actual source of truth, markdown becoming a rendered view) is explicitly **not** implemented — called out as a separate, deliberate, per-user opt-in decision, not something that happened by default.

This is a real precedent worth keeping in mind for the future apply-queue SQLite migration the mega-plan proposed: the project already has a working example of "SQL index over markdown truth, always rebuildable" to follow rather than invent from scratch.

**`update-system.mjs`** — the self-updater, with a real, specific, previously-fixed bug worth knowing if this file is ever touched again: it must stay self-loading, with **no static top-level relative imports**. Reason: the updater's `apply()` re-executes itself by checking out only `update-system.mjs` first, before the fuller checkout that would materialize any imported local module — a static top-level import from this file would crash with `ERR_MODULE_NOT_FOUND` during that old→new version jump, before the rest of the update ever runs. The fix was to pull in local helper modules lazily, at their actual point of use, by which time the full checkout has already happened — and there's a standing test suite specifically enforcing this invariant so it can't regress silently. Version comparison is real semver, tolerant of Release-Please's tag-prefixing convention (e.g. `career-ops-v1.9.0`). Updates touch only system-layer files; user data is structurally untouchable by this script.

**The plugin system** — genuinely more of a real security boundary than expected, worth describing precisely:

- **`plugins.mjs`** is the explicit host for non-provider plugin hooks (ingest/search/notify/export — e.g. Gmail, Notion). Deliberately not how scan-source provider plugins work (those ride through `scan.mjs` itself via a `provider:` entry in `portals.yml`) — the separation is intentional: `node scan.mjs` alone should never silently hit an email inbox or a paid third-party API, only an explicit plugin call can. Crucially, this host file — not the plugin itself — owns every write to the shared data files (`pipeline.md`, `applications.md`); a plugin can't corrupt the canonical format even if it tries, because it never gets direct write access.
- **`plugin-audit.mjs`** — a real static-analysis firewall specifically for third-party community/registry plugins (bundled/first-party plugins are reviewed in-tree and exempt, since they're already vetted). It maintains an explicit forbidden-module denylist — `child_process`, `playwright`, `worker_threads`, `vm`, and every raw networking primitive (`http`/`https`/`net`/`dns`/`tls`/`dgram`) — versus an allowed list of side-effect-free builtins (`crypto`, `path`, `fs`, `os`, etc.). The file is candid about its own limits in its own header: this is a *static* heuristic, not containment — a determined attacker can obfuscate; the real controls are review, pinning, and capability limits. It even applies self-referential care: the forbidden module names are built from string fragments (e.g. `cp = 'child' + '_process'`) specifically so this file's own source doesn't trip a repo-wide grep for those same forbidden tokens.
- **`plugins/_lock.mjs`**'s `hashPluginTree()` + a `consentSurface()` function — a content-hash lockfile mechanism: a plugin is pinned by hash at install time; if the plugin's tree changes later (an update, or something more adversarial), the hash mismatch is detectable rather than the plugin silently mutating its own behavior post-install without the user re-consenting.

This is a genuinely more serious trust boundary than "just some optional integrations" — it's built with the assumption that a community-contributed plugin is semi-trusted at best, and enforces that assumption mechanically rather than just documenting it.

---

## 20. Interview Prep, Reply-Watch, and the Final Sweep

**`needs-input.mjs`** — the central sink every gate in the system writes into (`gates/relocation.mjs`, `gates/warm-intro.mjs`, `pause-triggers.mjs`'s callers, `budget-tracker.mjs` on a cap hit, `orchestrator.ts`). One JSON array, one schema, one validation point (`VALID_SOURCES` enum: `apply_pause`/`warm_intro`/`relocation`/`unmapped_field`/`budget_cap`) — every producer goes through `addEntry()` so nothing can drift out of schema. There is a real, working Go TUI dashboard (`dashboard/`, built via `build-dashboard.mjs`, a cross-platform wrapper specifically because `go build -o` produces an extension-less binary on Windows that breaks PATH lookup there) — per its own framing "no longer the primary interface" now that the Next.js web app exists, but apparently still the primary reader/resolver for this specific needs-input queue.

**`reply-watch.mjs` + `reply-matcher.mjs` + `paste-reply.mjs`** — email-reply classification.
- `reply-matcher.mjs`'s `classifyReply()` sorts incoming replies into Interview/Responded/Need-Action/Rejected/Offer/Auto-confirmation/Noise/Unknown, matched against tracker rows by domain/company/role text similarity.
- Genuinely international in scope — real Chinese-language signal detection (a dedicated `normalizeChinese()` helper, WeChat mini-program mentions), consistent with `contacto.md`'s Boss Zhipin greeting-variant support found elsewhere in the system — real multi-market reach beyond English-language Western ATS platforms, even though the current search is US/global-remote-focused.
- The intended input path (a Gmail scanner) is explicitly unbuilt — `paste-reply.mjs`'s own header states plainly that the only planned way to auto-populate `reply-candidates.json` is a Gmail scanner that doesn't exist yet (requires OAuth inbox-read access).
- `paste-reply.mjs` is the actual working alternative for anyone unwilling to grant mailbox access — pure normalization, no classification of its own, appends to the same candidate-object shape `reply-watch.mjs` expects, never touches the tracker directly.
- Classification always requires human confirmation before any tracker write (interactive CLI prompt via readline).

**Interview modes** — five files forming a real prep-through-debrief cycle:

`interview-prep.md` (company-specific intel: a process map per interview round, likely-questions-per-audience, and a story-bank mapping step tying `interview-prep/story-bank.md`'s accumulated STAR+R stories to specific likely questions) → `interview/plan.md` (time-blocked prep schedule given a JD and interview date) → `interview/practice.md` (structured practice Q&A with feedback) → `interview/debrief.md` (post-interview gap-closing, updates the question bank).

`interview-redflag.md` is the most structurally interesting of these — explicitly dependent on real prior sessions: its own "Dependency" section states it requires transcripts already produced by `debrief.md` or `practice.md`, saved under `interview-prep/sessions/` (gitignored) — if none exist, it exits with an onboarding message rather than fabricating a verdict from nothing. It aggregates interviewer-behavior signals and a scope/compensation-mismatch check per company into one score, mapped to fixed warning tiers (e.g. 0–1 → "No structural red flags," 2–3 → "⚠️ Enter with eyes open") — the same descriptive-not-alarmist framing discipline seen in `oferta.md`'s Block G.

**`agent-inbox.mjs`** — a small, deliberately low-tech bridge for exactly the "I have a request but I'm not in an AI session right now" situation: drop a request ("evaluate this URL," "draft a follow-up for #7"), and it gets drained at the start of the next session. Plain markdown checklist (`data/agent-inbox.md`), append-only, no database — explicitly human-in-the-loop, nothing auto-submits from a queued intent.

**The final sweep** — smaller, more self-contained utilities, named rather than detailed since each composes into subsystems already covered above:

- *Tracker/pipeline hygiene:* `dedup-tracker.mjs`, `archive-posting.mjs`, `cv-sync-check.mjs`, `detect-reposts.mjs` (the fuzzy-title-clustering repost detector `compute-velocity.mjs` reuses), `ghost-filter.mjs`, `classify-tier.mjs` (the seniority-tier classifier `scan.mjs`'s `skip_tiers` config optionally loads), `fingerprint-core.mjs` (the content-hash logic behind `scan-history.tsv`'s fingerprinting, also the fuzzy role-name matcher shared by `set-status.mjs`/`followup-cadence.mjs`/`reply-matcher.mjs`).
- *Application-quality tooling:* `invite-match.mjs` (fuzzy-matches a pasted interview-invite email against tracker rows), `process-quality.mjs` (aggregates `[process-friction]` tags from `active-interviews.md`), `salary-gap.mjs` (folds advertised vs. desired vs. actual comp), `assessment-log.mjs` (skills-assessment event log), `match-star.mjs` (matches STAR interview stories to specific roles).
- *Alternate model backends:* `gemini-eval.mjs`, `ollama-eval.mjs`, `openai-eval.mjs`, `openai-tailor.mjs`, `openrouter-runner.mjs` — non-Claude evaluation/tailoring paths for users on a different model provider; `eval-golden.mjs` — a golden-set regression harness for evaluation quality itself.
- *LaTeX CV variant:* `extract-latex-content.mjs`, `patch-latex-content.mjs` — support scripts for the opt-in LaTeX mode (tailoring a hand-maintained `.tex` CV in place).
- *Misc:* `img-to-pdf.mjs`, `find.mjs`, `add-entry.mjs`, `browser-extract.mjs` (the Playwright JD-extraction helper `doctor.mjs` checks for), and a manifesto-signing helper referenced in `AGENTS.md`'s closing section.

**Cumulative findings worth remembering**, surfaced across the full system walkthrough: `modes/_profile.md`'s stale AI-era archetypes, `merge-tracker.mjs` missing the Hired state, `run-approved.mjs` skipping `followup-seed.mjs`, and `budget-tracker.mjs`'s LLM-call ceiling being entirely unenforced in practice.

---

## 21. Tracker Canonical States

### The source of truth: `templates/states.yml`

Nine states, each with `id`, `label`, `aliases[]`, `description`, `dashboard_group`:

| Label | id | Aliases | Meaning |
|---|---|---|---|
| Evaluated | evaluated | evaluada | Report exists, pending decision |
| Applied | applied | aplicado, enviada, aplicada, sent | Submitted |
| Responded | responded | respondido | Company replied, not yet interview |
| Interview | interview | entrevista | Active interview process |
| Offer | offer | oferta | Offer received |
| Rejected | rejected | rechazado, rechazada | Rejected |
| Discarded | discarded | descartado, cerrada, cancelada | Candidate passed / posting closed |
| SKIP | skip | no_aplicar, monitor | Doesn't fit, don't apply |
| **Hired** | hired | contratado, hired, accepted | Offer accepted, job landed |

`Hired` isn't in the state table `AGENTS.md` documents (that table stops at SKIP) — it's real, it's in the actual `states.yml`, it's the terminal success state, just undocumented at the `AGENTS.md` level.

### Three separate places validate a status string — and they've drifted

1. **`tracker-utils.mjs`'s `resolveCanonicalState()`** — the strict one, used by `set-status.mjs` (interactive/CLI writes). Loads `states.yml` fresh every call via `loadCanonicalStates()`, matches case-insensitively against label/id/every alias, returns `null` on anything unrecognized — the caller hard-rejects the write before touching the tracker at all. **Correct** — includes all 9 states because it reads the YAML directly.
2. **`normalize-statuses.mjs`'s `normalizeStatus()`** — a hand-written regex/lookup function (not YAML-driven) for cleaning up an existing tracker's legacy junk: strips markdown bold, strips trailing dates, maps `DUPLICADO`/`Repost` → `Discarded` (moving the original text into Notes), maps `MONITOR`/`geo.?blocker` → `SKIP`, treats a bare `—`/`-`/empty status as `Discarded`. Its own hardcoded canonical list **does** include `Hired`.
3. **`merge-tracker.mjs`'s `validateStatus()`** — used during every TSV-batch merge, i.e. every real evaluation (per `AGENTS.md`'s pipeline-integrity rule: batch additions always land via TSV → merge, never hand-edited). Its `CANONICAL_STATES` array is **hardcoded to 8 entries and does not include `Hired`**. Its alias table doesn't map `contratado`/`hired`/`accepted` to anything either. Fallback for anything unrecognized: log a warning and **silently default to `"Evaluated"`**.

### The concrete consequence — a real latent bug

If a real evaluation (or anything going through the TSV→merge path) ever tries to write `Hired` as a status, `merge-tracker.mjs` doesn't recognize it, doesn't error, and silently downgrades it to `Evaluated` with only a console warning nobody's watching in a batch run. `set-status.mjs` (the documented canonical write path per `AGENTS.md`) would handle `Hired` correctly since it reads the real YAML — so the bug only bites if something tries to batch-write a `Hired` transition rather than going through `set-status.mjs` directly. Given the tracker currently shows 0 offers/0 hires (`stats.mjs`: `ever applied 0`), this has never actually fired — a **latent** bug, not one that's bitten yet, but real and worth a one-line fix (add `Hired` to `merge-tracker.mjs`'s array) whenever building resumes.

### `set-status.mjs` — the actual write mechanics, end to end

`AGENTS.md`'s documented canonical write path ("UPDATE status/notes via `set-status.mjs`, never hand-edit"):

- **Row resolution is deliberately paranoid** — a bare numeric selector matches the `#` column, but if two rows share the same number (a real historical bug, #1704, from an earlier `merge-tracker.mjs` numbering race), it refuses to guess and prints both candidates, requiring `--role` to disambiguate or `--force` to proceed anyway. Company-name selectors use the same `normalizeCompany()` key `merge-tracker.mjs` uses for dedup.
- **Second paranoia check:** if a numeric selector's row Report cell links to a different report number (tracker drift), it refuses by default — unless `--force`.
- **State validation happens before the tracker is touched at all** — `resolveCanonicalState()` runs before the file is even opened.
- **The write goes through the same `acquireTrackerLock()`/`writeFileAtomic()` machinery as `merge-tracker.mjs`** (same lock directory — a `set-status.mjs` call and a concurrent `merge-tracker.mjs` run can never race). Only Status and Notes cells change; every other cell round-trips byte-for-byte untouched.
- **Note-appending is genuinely idempotent** — checks the note appears as a whole `"; "`-delimited entry, so re-running the identical command twice is always a safe no-op, but a note that's a substring of another note doesn't falsely suppress a real new one.
- **Exit codes are a real contract:** 0=success (incl. idempotent no-ops), 1=usage/validation error, 2=row not found, 3=ambiguous match, 4=lock timeout (busy, retry) — callers branch on these without parsing text.
- **A transition into `Applied` specifically** (checks `statusChanged`, not just "new status happens to be Applied") sets `followupSeedCandidate: true` in the JSON output — the hook `followup-seed.mjs` uses to pin a first follow-up date. `set-status.mjs` itself doesn't call it, just signals the opportunity.

---

## Workflow For Using This Doc

1. Aditya + this session ("Architect") discuss and design one feature/fix at a time, referencing the relevant section above.
2. Once a design is settled, spawn a fresh isolated session (git worktree) with: this doc + a specific design brief for that feature.
3. That session implements only that feature, reports back a diff.
4. Optionally spawn a separate testing/review session against that diff.
5. Architect + Aditya review together, merge if good, iterate if not.
6. Commit and push periodically as features land.
7. Repeat for the next feature. Aditya picks the order.
