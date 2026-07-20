# Job Search Automation System — Implementation Plan

## Context

Aditya's build spec (`Job Search Automation System — Build Spec`) calls for extending this repo — which, exploration confirmed, **already is the full upstream `career-ops` project** (v1.21.0, ~50 `.mjs` scripts, 130 mode files, a Go TUI dashboard, and a separate Next.js/TS `web/` app) — with autonomous sourcing (Signal Agent), auto-submission (Apply Agent), and Gmail-based reply detection (reply-tracker), while staying local-first, subscription-authenticated, and Sonnet-only.

The spec was written somewhat generically (a plausible file tree, a literal "SQLite as source of truth" ask, a brand-new `apply-agent/*.ts` module) without knowledge of exactly how much of this already exists and how it's wired together. Three rounds of codebase exploration surfaced that several "new" pieces substantially overlap existing, working infrastructure — most notably: `data/applications.md` is already a lock-protected source of truth with a derived SQLite cache; `web/src/lib/apply/` already drives real Playwright-based ATS form-filling; `detect-reposts.mjs` already does repost-clustering; `reply-watch.mjs`/`paste-reply.mjs` already do reply classification; and Gmail OAuth plumbing already exists in `plugins/gmail/`. Building the spec literally would fork or duplicate this working machinery. This plan reconciles the spec's intent with the existing architecture, per four binding decisions Aditya made when asked, and sequences the work per the spec's own phased build order (Section 12) — Phase 1 only is scoped for immediate execution; later phases are architected now so implementation has a coherent target, but are not to be built until each prior phase is verified stable.

**Onboarding has never run** — `cv.md`, `config/profile.yml`, `data/applications.md`, and `portals.yml` don't exist yet. Phase 1 is both "system onboarding" and "spec Section 12 step 1" simultaneously.

## Binding decisions (already made by Aditya — do not re-litigate)

1. **Tracker storage stays markdown.** `data/applications.md` remains sole source of truth, written only via `tracker-utils.mjs` (`acquireTrackerLock`/`writeFileAtomic`) or the TSV-drop + `merge-tracker.mjs` convention. The existing derived `data/applications.db` (`tracker.mjs sync`) satisfies the spec's "tracker.db" — no second SQLite writer for tracker rows.
2. **Apply Agent builds on `web/src/lib/apply/`.** New code imports `session.ts`/`extract.ts`/`greenhouse.ts`/`agent-interpret.ts` as a library rather than re-implementing ATS form-fill logic in a fresh standalone module.
3. **Location filter stays broad; relocation is a downstream gate.** `portals.yml`'s `location_filter` doesn't block non-Pune Indian cities. A new Apply Agent gate routes onsite-non-Pune roles to the needs-input queue instead of auto-submitting, modeled on the existing trust-filter's "annotate, never drop" precedent.
4. **Score bands → action:** High = 4.5+ (auto-apply + A/B rotation), Medium = 4.0–4.4 (auto-apply + single variant), Low = <4.0 (draft-only, folds the existing 3.5–3.9 "apply with reason" band in). This override lives in `config/profile.yml`/`modes/_profile.md` (User Layer) — `modes/_shared.md`'s score-interpretation prose (System Layer) is not edited.

Two further design choices, adopted directly rather than re-asked (clear safe defaults, no unique user preference needed):
- The A/B resume `variant={A|B}` tagged field follows the existing `via={Agency}` precedent (AGENTS.md TSV Format section, #1596) — documented in AGENTS.md (System Layer, which AGENTS.md itself designates as agent-editable) exactly the way `via=` already is. Variant *content* (the two narrative framings) stays in `modes/_profile.md` (User Layer).
- `company_heat` is **never** multiplied into `modes/_shared.md`'s scoring formula. It's computed and applied entirely inside `signal-agent`/`apply-agent` code as a post-scoring adjustment attached to the report/tracker row — keeps the shared evaluation prompt untouched and preserves Data-Contract purity.

## Target architecture

```
signal-agent/                 NEW — company_heat scoring (daily cadence)
  SKILL.md
  sources/{reddit,funding-news,github-activity}.md
  compute-heat.mjs            → data/company-signals.json (keyed by normalizeCompany())

apply-agent/                  NEW — orchestrator; imports web/src/lib/apply/*
  SKILL.md
  orchestrator.mjs            score-band → auto-apply/draft-only, calls into web lib
  pacing.mjs                  randomized delay, 25/day/platform backstop, 8am–11pm IST
  tier2/{linkedin,naukri}.ts  new Tier-2 drivers on session.ts patterns
  pause-triggers.mjs          CAPTCHA/MFA/unmapped-field/salary-field checks
  gates/relocation.mjs        onsite-non-Pune → needs-input (decision 3)
  gates/warm-intro.mjs        1st/2nd-degree LinkedIn connection → needs-input
  session-store/               gitignored, OS-keychain-backed session cookies
  submission-log.mjs          timestamp + before/after screenshot + form data + variant

reply-tracker/                NEW — Gmail OAuth watcher feeding the existing pipeline
  SKILL.md
  gmail-watcher.mjs           reuses plugins/gmail OAuth pattern; writes data/reply-candidates.json
                               (same schema paste-reply.mjs already writes — closes #1583)

ghost-filter.mjs              NEW, root — pre-scoring zero-LLM gate (>3 reposts / 60d)
budget-tracker.mjs            NEW, root — daily LLM-call + Tier-2-apply ceiling enforcement
needs-input.mjs               NEW, root — shared read/write helpers for the needs-input queue

dashboard/panels/             NEW Go files inside the existing dashboard/ module
  needs-input-queue.go, budget-usage.go, pipeline-funnel.go
```

Everything else (`scan.mjs`, `oferta.md`/`batch.md`, `detect-reposts.mjs`, `set-status.mjs`, `merge-tracker.mjs`, `tracker.mjs`, `followup-cadence.mjs`, `modes/apply.md`) stays as-is and is reused, not rebuilt.

---

## Phase 1 — Onboarding + verify existing pipeline unmodified (execute now)

1. **`cv.md`** — create from Aditya's background: B.Tech CS, MIT Pune; Emerson GenAI internship (Nov 2025–May 2026: production RAG — ingestion/embeddings/retrieval/generation/multimodal, Azure, CI/CD); Tech Mahindra internship (computer vision, ML pipelines). Match the section structure `modes/pdf.md`/`modes/_profile.template.md` expect — don't invent a new shape.
2. **`config/profile.yml`** — copy `config/profile.example.yml`, fill `candidate.*` (location: Pune), `target_roles.archetypes` (AI/ML Engineer, Applied AI Engineer, Systems+AI hybrid, Agentic AI), `narrative.*` seeded with both eventual A/B framings (RAG/production-AI-lead, systems/C++-depth), `spend_tier: standard` (hard cap — never `premium`, per Section 1's Sonnet-only requirement), and the new `auto_apply_thresholds: {high: 4.5, medium: 4.0}` block (binding decision 4).
3. **`portals.yml`** — copy `templates/portals.example.yml`; `location_filter.always_allow` includes Pune + Remote + India broadly, no block-list for other Indian cities (binding decision 3); enable the existing trust-filter block; seed `tracked_companies` with 5–10 real Greenhouse/Lever/Ashby companies for verification.
4. **Readiness check** — `node doctor.mjs`, resolve every ✗/⚠ before proceeding.
5. **End-to-end verification, pipeline unmodified** — scan or manually seed 5–10 real job URLs into `data/pipeline.md`; confirm `scan-history.tsv` gets correct `appendToScanHistory` rows; run the evaluation mode on each; confirm `reports/*.md` have correct `**URL:**`/`**Legitimacy:**` headers and a well-formed `## Machine Summary` YAML fence; confirm `batch/tracker-additions/*.tsv` files have correct 9-column order; run `merge-tracker.mjs` and confirm `data/applications.md` rows are correct with no duplication; run `tracker.mjs sync` and confirm `data/applications.db` matches.

**Verification:** all of step 5 passes on real data with **zero** code changes anywhere outside `cv.md`/`config/profile.yml`/`portals.yml`/`data/*`. `git status` shows no diffs to any `.mjs`/`modes/*` file.

---

## Phase 2 — Tier 1 sourcing at scale + ghost-filter

New `ghost-filter.mjs` (root). Imports `parseScanHistory`/`detectReposts` from `detect-reposts.mjs` as a library — calls `detectReposts(rows, 60)` filtered to `repostCount > 3` (spec's literal threshold) **without changing `detect-reposts.mjs`'s own default** (90-day/2+ stays as-is for Block G's per-JD legitimacy check, a different purpose). Adds the other two Section 5 rules: no-salary + boilerplate + posted >45d; domain-doesn't-resolve (reuse `liveness-core.mjs`'s resolution-check style). Flagged listings are never dropped — they get one cheap Sonnet classification pass, matching the existing trust-filter's "annotate, never silently drop" precedent. Wired in as a filter step between `scan.mjs`/`scan-ats-full.mjs` output and the per-JD evaluation loop.

**Verification:** run against ≥50 real scanned rows; manually confirm flagged listings match expectation and nothing legitimate is dropped from `pipeline.md`.

---

## Phase 3 — Signal Agent

New `signal-agent/compute-heat.mjs` computes `company_heat` (0–100) from funding/news (90d), GitHub org activity, Reddit hiring-mentions (60d), LinkedIn hiring-signal cadence. Storage: `data/company-signals.json`, keyed by `normalizeCompany()` (reused from `tracker-utils.mjs` for consistency with how `merge-tracker.mjs`/`set-status.mjs` key companies) — a flat JSON, not a new SQLite table, since this is small/read-mostly data and `tracker.mjs` already owns the one derived-DB precedent. Applied as a post-scoring multiplicative adjustment computed in code (never edits `_shared.md`'s formula, per the design choice above) and written into the report/tracker alongside the base score.

**Verification:** run once against 10–15 real tracked companies Aditya already has judgment on; sanity-check `company_heat` against known ground truth (recently-funded/visibly-hiring companies score high; dormant ones score low).

---

## Phase 4 — Apply Agent, Tier 1 only

New root-level `apply-agent/` orchestrator (Node) that imports `web/src/lib/apply/{session,extract,greenhouse,agent-interpret}.ts` as a library rather than living inside the Next.js app — `web/`'s API routes are built around interactive, human-driven, request/response sessions; the Apply Agent needs an unattended, queue-driven loop with its own pacing/pause-trigger/logging, which doesn't fit that request/response shape. **Packaging mechanics** (npm workspace vs. relative import across `web/`'s and root's separate `package.json`s) is a real implementation decision — not resolvable by file-path reasoning alone, flag for a concrete call when this phase starts.

New files: `apply-agent/orchestrator.mjs` (score-band decision, reading `auto_apply_thresholds` from `config/profile.yml`), `apply-agent/submission-log.mjs`, `apply-agent/gates/relocation.mjs` (decision 3). Tier 1 has no pacing cap per spec Section 8. All tracker write-backs go through `set-status.mjs` as a subprocess (`node set-status.mjs <report#> Applied --note "..."`) — never a direct `applications.md` write — so they inherit the existing lock automatically.

**Verification:** submit exactly **one** real low-stakes Tier-1 application end-to-end; confirm before/after screenshots exist, the submission log has exact form data + variant tag, the tracker row transitions to `Applied` via `set-status.mjs` cleanly, and `data/applications.db` reflects it after sync. Do not batch further submissions until this one is confirmed clean.

---

## Phase 5 — Apply Agent, Tier 2 (LinkedIn/Naukri)

New `apply-agent/tier2/{linkedin,naukri}.ts` on `session.ts`'s patterns, against Aditya's real logged-in session (`apply-agent/session-store/`, gitignored, OS-keychain cookies, never synced between machines). `pacing.mjs`: randomized delays, hard 25/day/platform backstop (safety net, not the primary pacing mechanism — match-quality-driven pacing is), 8am–11pm IST window enforced. `pause-triggers.mjs` checked before every field fill: CAPTCHA, MFA/OTP, unmapped custom field, salary-number-required field, any warm-intro flag (`apply-agent/gates/warm-intro.mjs` — one LinkedIn connections lookup before firing; on a hit, routes to needs-input with a suggested referral-ask message instead of applying). Each trigger halts only that single job (per-job try/catch in the orchestrator loop) and queues it to needs-input with full context; the rest of the day's queue continues.

**Verification:** start at 1–3/day; deliberately test each pause-trigger (a job with a salary-number field, a job at a company with a known 1st-degree connection) before trusting the path at volume.

---

## Phase 6 — Reply-tracker Gmail watcher

New `reply-tracker/gmail-watcher.mjs`, reusing `plugins/gmail/index.mjs`'s OAuth pattern (`GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` via `.env`) but scoped to inbox reply-detection, closing the gap `paste-reply.mjs`'s own header comment flags (#1583). Output schema matches `paste-reply.mjs`'s exactly (`{message_id, from, subject, body_snippet, signal}`) so `reply-watch.mjs`'s existing `classifyReply()` pipeline consumes it unchanged — no second classifier. Never auto-replies.

**Fix bundled into this phase:** `reply-watch.mjs` currently writes `reply-candidates.json` via raw `fs.writeFileSync`, bypassing `tracker-utils.mjs`'s lock. Since this phase adds a second producer to the same file, route both through `acquireTrackerLock`/`writeFileAtomic` now, before concurrent writes become likely.

**Verification:** point the watcher at a test label with 2–3 known reply emails (interview invite, rejection, auto-confirmation); confirm classifications match, and the interactive y/N confirmation in `reply-watch.mjs` still works before it shells `tracker.mjs sync`.

---

## Phase 7 — Dashboard panels (Go)

New `dashboard/panels/{needs-input-queue,budget-usage,pipeline-funnel}.go`, following `career.go`'s existing read pattern. `needs-input-queue.go` reads `data/needs-input-queue.json`; `budget-usage.go` reads `data/usage-today.json`; `pipeline-funnel.go` builds scanned→scored→drafted→applied→interview counts from `scan-history.tsv` + `applications.md` + the new signal/needs-input files.

**Fix bundled into this phase:** `career.go`'s `UpdateApplicationStatus`/`UpdateApplicationStatusAndNotes` (lines ~660–726) currently write `applications.md` via raw `os.WriteFile`, no lock — a second unlocked writer, materially riskier once Signal/Apply/Reply agents write more often. Have the Go side shell out to `set-status.mjs` as a subprocess for status/notes writes instead of writing the file directly — smallest fix, reuses the lock path exactly, avoids porting the stale-lock/retry logic to Go.

**Verification:** seed `needs-input-queue.json`/`company-signals.json` with synthetic entries, run `cd dashboard && go run . --path ..`, confirm all three panels render and the status-change flow still works through the fixed write path.

---

## Phase 8 — Tier 2b (career pages) + Tier 3 (discovery expansion)

Only after Phases 1–7 are stable. Tier 2b (Apify actor or Claude-in-Chrome, case-by-case structured forms only) and wider Reddit/funding-news/GitHub-org Tier 3 sourcing feeding Signal Agent more broadly (never auto-apply). No new plumbing beyond what Phases 3 and 5 already establish — pure coverage expansion.

---

## Budget/usage-cap enforcement (spec Section 7)

New `budget-tracker.mjs`, imported by every LLM-calling entry point (`batch.md`'s runner, `apply-agent/orchestrator.mjs`, the ghost-filter's Sonnet classification call).

- **Storage:** `data/usage-today.json` — `{date, llm_calls, tier2_applies: {linkedin, naukri}}`, written via `writeFileAtomic`. Rolls over automatically when `date` doesn't match today.
- **Enforcement:** `checkAndIncrement(kind)` called before each LLM call / Tier-2 apply; hard-stops when `config/profile.yml`'s `budget.daily_llm_calls` (default 300) or `budget.tier2_daily_cap` (default 25/platform) is hit. No silent degrade or retry-queue — callers halt and log a clear reason, also appended to `needs-input-queue.json` as an informational entry ("capped, resumes tomorrow") for the dashboard.
- **Composition with `spend_tier`:** independent axes. `spend_tier` (capped to `standard` in Phase 1, per Section 1's no-Opus rule) picks the model; `budget-tracker.mjs` limits call count regardless of tier — no re-enforcement of model choice needed here.
- Follows `followup-cadence.mjs`'s existing pattern exactly: a `DEFAULT_BUDGET` constant + profile-key overrides, same shape as `DEFAULT_CADENCE`/`PROFILE_CADENCE_KEYS`.

## "Needs your input" queue — shared schema

New `data/needs-input-queue.json` (JSON array — entries vary by source, unlike the tracker's fixed columns; kept separate from `reply-candidates.json` since producers/consumers differ entirely). Written via `writeFileAtomic`:

```json
{
  "id": "uuid",
  "created_at": "ISO timestamp",
  "source": "apply_pause | warm_intro | relocation | unmapped_field | budget_cap",
  "report_ref": "report number or null",
  "company": "string", "role": "string",
  "reason": "human-readable",
  "context": { "...source-specific detail..." },
  "status": "open | resolved | dismissed",
  "resolved_at": "ISO timestamp or null"
}
```

All producers (`apply-agent/orchestrator.mjs`, `gates/warm-intro.mjs`, `gates/relocation.mjs`, `budget-tracker.mjs`) append through one shared `needs-input.mjs` helper (`addEntry()`/`resolveEntry()`) so the schema stays consistent. `dashboard/panels/needs-input-queue.go` is the sole consumer, rendering `status === "open"` entries at the top of the view, resolving via a small Node helper shell-out (mirrors the `set-status.mjs` subprocess pattern) rather than a Go-native rewrite of the JSON array.

## Deferred / explicitly not solved now

- **Multi-machine setup (spec Section 11):** replication via git, second-machine fallback-vs-active scheduling. Explicitly out of scope until Phases 1–7 are stable, per the spec's own sequencing — revisit and get an explicit decision from Aditya before any DB/tracker write-conflict handling is built for it.
- **Cross-`package.json` import mechanics for Phase 4** — call it when Phase 4 starts, not now.

## Critical files (existing, to be read closely before touching related new code)

- `tracker-utils.mjs` — locked write path, must be reused not reinvented
- `detect-reposts.mjs` — repost clustering to import as a library
- `web/src/lib/apply/session.ts` — Apply Agent's base
- `dashboard/internal/data/career.go` — unlocked-write bug to fix in Phase 7
- `config/profile.example.yml` — Phase 1 template
- `followup-cadence.mjs` — pattern to mirror for `budget-tracker.mjs`
- `templates/states.yml` — canonical states, unchanged
- `AGENTS.md` — TSV Format section, extend with `variant=` tag documentation alongside existing `via=`
