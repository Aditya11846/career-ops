# Fix signal-agent's data-loss bug (writeCompanySignal split-storage), then re-scope for broader value

**Date:** 2026-08-10
**Status:** PLANNED
**Bead(s):** none yet — create after this plan is committed (see Step 3 of `/handoffplan`)
**Epic:** Job Discovery Layer (see `.claude/plans/architect-system-design.md`)
**Chain:** `standalone-50b78d94` seq `1`
**Context:** See `HANDOFF_standalone-50b78d94_signal-agent-automation_2026-08-10.md` for full session data, code evidence, and prior design discussion.

---

## Problem Statement

`signal-agent/compute-heat.mjs`'s `writeCompanySignal()` does a full-object replace with no merge, and its CLI defaults any unpassed `--funding`/`--reddit`/`--linkedin` flag to `0`. `SKILL.md` documents that GitHub activity and job-posting velocity are meant to refresh cheaply and often (no WebSearch needed) while funding/Reddit/LinkedIn require agent research and are meant to stay on-demand — but nothing currently protects that split. A future nightly cron computing only velocity+GitHub would silently zero out and overwrite any previously-researched funding/Reddit/LinkedIn values, dragging every company's composite `heat` down for no real reason. 39 real companies already have live records in `data/company-signals.json` in the vulnerable old flat shape. See Evidence & Data in the handoff for the exact code, the working merge pattern already used by `compute-stability.mjs` for a different field, and the full consumer audit.

## Key Findings

- `compute-stability.mjs`'s `writeCompanyStability()` already solves this exact class of bug correctly for its own field (`layoff_risk`) — spreads `existing` first. `writeCompanySignal` should be rebuilt to follow the same pattern, not invent a new one. → drives Phase 1's implementation shape.
- Grepped every external reader of `company-signals.json` (`relationships.mjs`, `score-inbox.mjs`, `compute-fit.mjs`) — all three only ever read `.heat` (plus `.layoff_risk`), never `.signals.*` directly. The internal schema is free to restructure with zero consumer-side changes. → drives Phase 1's low-risk scope.
- `web/src/app/api/run/route.ts:61`'s "don't re-score within 7 days" staleness gate is LLM-prompt prose, not code — the fix there is a one-line text edit (`updatedAt` → `researched.updatedAt`), not a logic change. → drives Phase 2.
- `funding-news.md`'s existing scoring rubric already has agents watching for layoff/hiring-pause signals during normal funding research — but that evidence only zeros the `funding` sub-score today; it's never passed to `layoff_risk`. This is the cheapest available win for making signal-agent more valuable, not just correct. → drives Phase 3 (optional, see below).
- `computeHeat`'s actual weights (`velocity: 0.30, funding: 0.25, github: 0.20, linkedin: 0.15, reddit: 0.10`) put the free deterministic velocity signal at the highest weight already — any new signal (e.g. repost detection) needs a deliberate weight decision, not an assumed slot. → informs Phase 3 design, not this plan's scope to resolve.
- `data/company-signals.json` has 39 real records today, all in the old flat shape — a migration step is mandatory, not optional. → drives Phase 1's scope explicitly (see Phase 1 below).

## Anti-Goals (What NOT To Do)

- **Don't compute `heat` at read time.** Considered and rejected in the design discussion — it would require changing all 3 external consumers for no consumer-facing benefit. Keep `heat` a stored, write-time-computed field.
- **Don't make the nightly cron always run full WebSearch research.** This was explicitly rejected as an alternative to the merge fix — it defeats the entire reason `SKILL.md` split deterministic vs. researched signals in the first place (cost/time of WebSearch per company per night).
- **Don't silently drop the migration step.** There are 39 real, live records in the old shape — do not assume a fresh/empty file, and do not write code that only works against post-migration data without handling what's there today.
- **Don't touch `modes/_shared.md`, `oferta.md`, or any of the archetype-taxonomy files from the prior work stream.** That work is complete, committed (`3c1991f`, `2e14e24`), pushed, and out of scope for this chain entirely — unrelated bug class, unrelated files.
- **Don't design or implement any of the 3 "think bigger" directions in this plan.** Phase 3 below is scoped narrowly to the one already-concrete, cheap win (wiring funding-research's existing negative-signal detection into `layoff_risk`) — the other 2 directions (proactive nudges, offer-stage alerts) and the broader systematic stability-sentiment research step are explicitly NOT part of this plan and need their own discuss-first design session per this project's established workflow.

## Plan

### Phase 1: Split-storage fix in `compute-heat.mjs`

**Goal:** Stop the data-loss bug — a deterministic-only write (github+velocity) must never touch or zero out existing researched (funding/reddit/linkedin) values.

**Why this approach:** Mirrors `compute-stability.mjs`'s `writeCompanyStability()`, an already-correct, already-tested pattern in the same file family, rather than inventing a new merge strategy.

- Add `mergeSignals(existing, updates)` and `recomputeHeat(record)` helpers per the Implementation Sketch in the handoff — `recomputeHeat` reads `record.deterministic`/`record.researched`, defaults missing sub-scores to `0` (an honest "no signal" default, matching `SKILL.md`'s existing philosophy), and calls the existing `computeHeat()`.
- Split `writeCompanySignal` into `writeDeterministicSignals(company, {github, velocity, velocityMeta})` and `writeResearchedSignals(company, {funding, reddit, linkedin})`. Both: load existing record, merge into their own sub-object only, recompute `heat`, write.
- CLI (`main()`): call `writeDeterministicSignals` unconditionally (github/velocity are always either freshly computed or explicitly disabled via `--no-github`/`--no-velocity`, which should still write an explicit `0`, not omit). Call `writeResearchedSignals` **only if at least one of `--funding`/`--reddit`/`--linkedin` is present in `argv`** — check via `args.includes('--funding')` etc., not `parseArg`'s return value, so an explicit `--funding 0` is distinguishable from an omitted flag.
- Partial-merge within `researched` (e.g. only `--reddit` passed): merge just that key, leave `funding`/`linkedin` in the existing `researched` object untouched. This was the one design point left unconfirmed with the user (see handoff's Open Questions #1) — implement partial-merge as the default per the stated design leaning, but flag it in the PR/report-back so the user can veto if they actually wanted all-three-together semantics.
- **Migration for the 39 existing records:** write a one-time migration step (a small script or an inline check in `loadSignals()`) that detects the old flat `{signals: {...}, velocityMeta}` shape and converts it to `{deterministic: {github, velocity, velocityMeta}, researched: {funding, reddit, linkedin}}` on first read/write per record. Prefer a lazy per-record migration (converts each record the first time it's touched) over a single batch script, so a record that's never touched again doesn't need special-case handling.
- Update `compute-heat.mjs --self-test` to cover: a deterministic-only write after a researched write preserves the researched values (the actual bug this phase fixes — write this test FIRST, confirm it fails against the current code, then fix and confirm it passes); the migration path against a fixture built from the real Broadcom record shape (quoted verbatim in the handoff).

**Files:** `signal-agent/compute-heat.mjs` (main change), possibly `signal-agent/compute-stability.mjs` (verify only — see Phase 2)
**Validates with:** `node signal-agent/compute-heat.mjs --self-test` — all existing tests plus the new merge-preservation test must pass. Manually verify against 2-3 real companies from `data/company-signals.json` (e.g. Broadcom) that a deterministic-only write leaves `researched.funding` etc. unchanged — read the record before and after with `--read`.
**Rollback:** `writeCompanySignal` (old function) can stay in the file, unexported/renamed, as a fallback if the migration proves risky; git revert is otherwise clean since this touches one file's internals with no consumer-facing API change.

### Phase 2: Fix the staleness-check prompt + verify `compute-stability.mjs`

**Goal:** Make sure the rest of the system correctly reflects the new schema — the one prompt-text dependency, and the one other writer to the same file.

**Why this approach:** Both are small, mechanical follow-ons flagged explicitly in the handoff so they aren't missed mid-Phase-1.

- `web/src/app/api/run/route.ts:61` — edit the prompt string: `"don't re-score a company scored in the last 7 days, check its updatedAt"` → `"...check its researched.updatedAt (not the top-level updatedAt, which now also updates on deterministic-only nightly writes)"`.
- Re-run `compute-stability.mjs --self-test` against a record already migrated to the new shape (from Phase 1) to confirm its existing shallow-merge (`{...existing, layoff_risk, layoff_signals, updatedAt}`) still correctly preserves the now-nested `deterministic`/`researched` sub-objects it doesn't touch. Expected: no code change needed here, but confirm, don't assume — its self-test already writes into `SIGNALS_PATH` via a save/restore pattern (lines ~129-145 in the handoff's Code Analysis), reuse the existing backup/restore discipline if a live-data test is needed instead of the tmp-path self-test.

**Files:** `web/src/app/api/run/route.ts`, `signal-agent/compute-stability.mjs` (verification only, likely no diff)
**Validates with:** `node signal-agent/compute-stability.mjs --self-test` passes unchanged; manual read of `route.ts:61` confirms the new text.
**Rollback:** Single-line revert on `route.ts`; no rollback needed for `compute-stability.mjs` if no changes were required.

### Phase 3 (optional, small, only if time allows): Wire funding-research's negative-signal detection into `layoff_risk`

**Goal:** Stop discarding real layoff/hiring-pause evidence that funding research already finds.

**Why this approach:** `funding-news.md`'s rubric already instructs the agent to notice and act on this evidence (by zeroing `funding`) — this phase just adds a second, additive action (a `writeCompanyStability()` call) using evidence that's already being surfaced, not new research.

- Update `signal-agent/sources/funding-news.md`'s "Negative signal override" instruction: when it fires, in addition to scoring `funding: 0`, also call `node signal-agent/compute-stability.mjs --company "{Company}" --layoffs-fyi-hits 1` (or the appropriate flag) with a one-line note of what was found, so the same evidence updates `layoff_risk` instead of being discarded after zeroing `funding`.
- This is a `SKILL.md`/`sources/funding-news.md` prose change plus confirming `compute-stability.mjs`'s existing CLI flags are sufficient to represent "found during funding research" evidence (they likely are — `--layoffs-fyi-hits` and `--headcount-trend-pct` already exist) — no new code path needed if the flags already fit.

**Files:** `signal-agent/sources/funding-news.md`
**Validates with:** Manual dry-run: research a company's funding, confirm the workflow now naturally also calls `compute-stability.mjs` when the negative-signal override fires. No automated test possible for prose-instruction changes — spot-check via one real on-demand run.
**Rollback:** Revert the markdown edit; zero code risk.

## Dependencies & Order

- Phase 1 must land first — it's the correctness fix and has no dependency on anything else.
- Phase 2 depends on Phase 1's schema existing (the prompt text references the new field name).
- Phase 3 is fully independent of Phases 1-2 at the code level (it's a markdown-instruction change to a different file) but is lower priority — do it only if Phases 1-2 are done and verified with time remaining. It is explicitly optional for this plan; skipping it is fine.
- The 2 remaining "think bigger" directions (proactive nudges, offer-stage alerts) and the broader systematic stability-sentiment signal are NOT phases in this plan — they need their own design session first (see handoff's Where We're Going #4).

## Risks & Mitigations

- **Migration bug corrupting real data (39 live companies).** Mitigation: write and pass the migration self-test against a fixture built from the actual Broadcom record (quoted in the handoff) before running against the real file; back up `data/company-signals.json` before the first real run, same discipline as the `data/needs-input-queue.json` backup/restore pattern already established this session.
- **Partial-merge semantics might not match what the user actually wanted** (Open Question #1, unconfirmed). Mitigation: implement the documented leaning (partial-merge) but call it out explicitly when reporting back, so it's a one-line fix if wrong, not a silent surprise.
- **Missing the `route.ts:61` prompt-text fix** since it's easy to forget (different file, no test coverage possible for prose). Mitigation: Phase 2 exists specifically to force this into its own checklist item.

## Success Criteria

- `node signal-agent/compute-heat.mjs --self-test` passes, including a new test proving a deterministic-only write preserves prior researched values (the literal bug this plan fixes).
- A real read-before/write-deterministic/read-after round trip against an actual company in `data/company-signals.json` (e.g. Broadcom) shows `researched.funding`/`reddit`/`linkedin` unchanged after a deterministic-only write.
- All 39 existing records in `data/company-signals.json` are either migrated or verified to lazily-migrate correctly on next touch — no data loss, no crash on old-shape records.
- `route.ts:61`'s prompt text references `researched.updatedAt`.
- `compute-stability.mjs --self-test` still passes against the new schema.

## Quick Start

```bash
# Restore full context
cat /Users/adium/career-ops/.claude/plans/HANDOFF_standalone-50b78d94_signal-agent-automation_2026-08-10.md

# Key source files for Phase 1
signal-agent/compute-heat.mjs
signal-agent/compute-stability.mjs   # the pattern to mirror, lines 81-93
web/src/app/api/run/route.ts         # line 61, Phase 2

# Baseline data to reference
data/company-signals.json            # 39 real records, old flat shape — the migration target

# Verify starting state
node signal-agent/compute-heat.mjs --self-test
node signal-agent/compute-stability.mjs --self-test

# First concrete action
Write the new merge-preservation self-test in compute-heat.mjs FIRST (it should fail against
current code), then implement writeDeterministicSignals/writeResearchedSignals per the
Implementation Sketch in the handoff, then make the new test pass.
```
