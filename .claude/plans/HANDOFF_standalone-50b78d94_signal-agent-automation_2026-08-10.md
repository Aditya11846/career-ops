# Signal-agent automation: writeCompanySignal merge fix + broader-value design

**Date:** 2026-08-10
**Status:** IN PROGRESS
**Bead(s):** none yet — created after the paired PLAN file
**Epic:** Job Discovery Layer (see `.claude/plans/architect-system-design.md`)
**Chain:** `standalone-50b78d94` seq `1`
**Parent:** none — first in chain
**Prior chain:** none — first in chain

---

## Reference Documents

- `AGENTS.md` — project conventions, Data Contract (User Layer vs System Layer), Ethical Use rules, canonical states
- `.claude/plans/architect-system-design.md` — full career-ops system design, referenced by the mega-plan
- `.claude/plans/mega-plan-next-sessions.md` — cross-session roadmap this work slots into
- Auto-memory at `~/.claude/projects/-Users-adium-career-ops/memory/` — `MEMORY.md` is the index; `project_signal_agent_design.md` (written this session) is the primary source for everything in this handoff; `project_discovery_layer_status.md` and `project_stale_content_audit.md` cover the prior, now-complete work stream (see Since-Last-Handoff-equivalent context below); `project_open_design_threads.md` lists two bigger unimplemented branches (Profile Presence, Unified Inbound Signals) that are NOT part of this chain.

## The Goal

career-ops is an AI job-search pipeline currently serving Amit Kumar Singh (22-year senior security/systems engineer — Zero Trust, endpoint encryption, embedded/kernel security, ex-Broadcom/Symantec), run by his son Aditya. `signal-agent/` is a subsystem that scores each tracked company's "heat" (0-100, composite of funding/Reddit/LinkedIn/GitHub/job-posting-velocity signals) and a separate `layoff_risk` score, stored in `data/company-signals.json` and read by `score-inbox.mjs` (ranks the pending-JD inbox), `compute-fit.mjs`'s `blendRank()` (folds into the final fit rank used for evaluation priority), and `relationships.mjs` (enriches outreach contacts with their company's current heat). The end goal of this work stream: fix a real data-loss bug in how signals get persisted, then decide and design at least one of three "make this genuinely more valuable, not just structurally correct" directions — all discussed but none yet implemented.

## Where We Are

- **This session started as a completely different task** (finishing/verifying a stale-content bug fix — see below) and pivoted into Signal-agent design only in its final third, after the user explicitly asked to move to the next item on the Job Discovery Layer backlog.
- `signal-agent/compute-heat.mjs`'s `writeCompanySignal()` (line 142) does a **full replace**: `signals[key] = { company, ...record, updatedAt: new Date().toISOString() }` — no spread of the existing stored record first.
- Its CLI (`main()`, ~line 218-270) defaults unpassed `--funding`/`--reddit`/`--linkedin` flags to `0` via `Number(parseArg(args, '--funding') ?? 0)` — same pattern for all three.
- `signal-agent/SKILL.md`'s own documented Workflow section (lines 24-77, already read in full this session) explicitly splits the 5 signals into two categories: **deterministic** (GitHub activity via `githubActivityScore()`, job-posting velocity via `compute-velocity.mjs` reading `data/scan-history.tsv` — both free, no WebSearch, "safe to run nightly on a cron") and **agent-researched** (funding/news, Reddit hiring signal, LinkedIn hiring signal — all require WebSearch, meant to stay on-demand per the SKILL.md text itself: "As a scheduled daily job... if the user opts in").
- **The bug this creates, confirmed by reading the code, not assumed:** if a nightly cron ever calls `compute-heat.mjs --company X --github-org slug` (velocity+github only, matching SKILL.md's documented intent), the three agent-researched flags are absent from argv, collapse to `0` via the `?? 0` default, and `writeCompanySignal`'s full-replace overwrites whatever real funding/reddit/linkedin values an earlier on-demand agent run had researched — silently dragging the composite `heat` down every single night even though nothing about funding/Reddit/LinkedIn actually changed.
- **This exact merge pattern already exists correctly elsewhere in the same file family.** `signal-agent/compute-stability.mjs` (read in full this session) is a *third* writer to the same `data/company-signals.json`, storing a `layoff_risk` field. Its `writeCompanyStability()` (lines 81-93) does: `all[key] = { ...existing, company: existing.company || company, layoff_risk: layoffRisk, layoff_signals: signals, updatedAt: ... }` — spreads `existing` first, so it never clobbers `heat`. There's even a code comment confirming the author was already aware of this exact class of bug: `// Merge behavior: writing stability must not clobber an existing heat record.` (line 129), and a self-test asserting `merged.heat === 77` survives after a stability write (lines 139-140).
- **Consumer audit (grep across the whole repo, not assumed):** the only external readers of `data/company-signals.json` are `relationships.mjs:133` (`readCompanySignal(r.company)` → reads `.heat` only, line 139), `score-inbox.mjs:99-101` (`readCompanySignal` → reads `.heat` and `.layoff_risk`), and `compute-fit.mjs:759,477-478` (`readCompanySignal` → reads `.heat` and `.layoff_risk`). **Nobody outside `compute-heat.mjs` itself reads into `.signals.*` or `.velocityMeta` directly.** This means the internal record shape is free to restructure without touching any consumer — confirmed, not guessed.
- `web/src/app/api/run/route.ts:61` (grepped exact line, confirmed) is the caller that spawns the agent-researched half of the workflow — **the 7-day staleness gate is prose in an LLM prompt string, not code logic**: `` `...that does NOT already have a record in data/company-signals.json (read it first to see what's already scored — don't re-score a company scored in the last 7 days, check its updatedAt).` `` — the agent doing the scoring run is trusted to read the file and judge staleness itself. This makes the fix trivial once the schema changes: it's a one-line prompt-text edit (`its updatedAt` → `its researched.updatedAt`), not a code-logic change. Still worth its own explicit check-off in the plan so it isn't forgotten, but it's not a real engineering risk — just an easy-to-miss text update in a file this design doesn't otherwise touch.
- **Design decision reached and confirmed with the user: Option 2 — split storage.** Store `deterministic` (github, velocity, velocityMeta) and `researched` (funding, reddit, linkedin) as two separate sub-objects, each with its own `updatedAt`, combined only into a single `heat` field at write time (not read time — see Key Decisions for why).
- **Nothing has been implemented yet.** No code changes to `compute-heat.mjs`, `compute-stability.mjs`, or `web/src/app/api/run/route.ts` in this session. This is a pure design handoff.
- **Beads (`bd`) CLI was installed and initialized in this repo during this session**, in stealth mode: `npm install -g @beads/bd` (v1.1.2), then `bd init --skip-agents --stealth` — deliberately passed `--skip-agents` because `bd init` auto-modifies `AGENTS.md` by default to document the beads workflow for agents, and this repo's `AGENTS.md` is a carefully curated, load-bearing file (the entire Data Contract lives in it) that should never be auto-edited by a third-party tool. `.beads/` database is git-excluded via `.git/info/exclude` (confirmed via `git status -s` showing no new tracked files after init). `bd stats` currently shows 0 issues — nothing created yet, that happens after the paired PLAN file per the `/handoffplan` skill's Step 3.
- **`modes/_custom.md` (user-layer, previously empty template) now has its first real customization**, written this session under "Custom Workflows": use `/handoffplan` for session handoffs going forward, but override its default output location — write `HANDOFF_*`/`PLAN_*` pairs to `.claude/plans/` (this repo's existing convention, where `architect-system-design.md` and `mega-plan-next-sessions.md` already live), never the skill's repo-root default. Also documents that beads is set up in stealth mode and `AGENTS.md` was deliberately never auto-touched.

## What We Tried (Chronological)

1. **User asked "what's next" after the prior work stream's commit+push.** I answered from `project_discovery_layer_status.md`'s "still genuinely open" list: Signal-agent automation, `modes/_profile.md` archetype fix, Workday autofill investigation, plus two bigger unimplemented branches (Profile Presence, Unified Inbound Signals) from `project_open_design_threads.md`.
2. **User picked the archetype fix first** (separate, now-fully-complete work stream — see "Since Last Handoff"-equivalent section below for why it's relevant background, not part of this chain's scope).
3. **After that work completed, user asked "what's next" a second time** and explicitly chose "Signal-agent automation" to discuss next.
4. **First discussion pass was too abstract** — I recalled the `writeCompanySignal` merge-vs-replace question from memory without re-reading the actual code. Correctly self-corrected by re-grounding: read `SKILL.md`'s Workflow section in full, then found the exact bug in `compute-heat.mjs` by reading `writeCompanySignal()` and `main()` directly.
5. **Found `compute-stability.mjs` already solves this correctly** for its own field (`layoff_risk`) via a grep across the repo for other writers to `company-signals.json` — this was the key discovery that turned "design a new merge strategy from scratch" into "generalize a pattern that already works in this codebase."
6. **Grepped all external consumers of `readCompanySignal`/the signals file** before proposing a schema change, specifically to confirm no consumer reads into `.signals.*` — this de-risked the redesign (confirmed no hidden coupling) before proposing it.
7. **Proposed 3 options** (true merge at flat level / split storage with independent staleness / always-full-recompute-nightly). User picked split storage ("2") without hesitation.
8. **User then asked a "why does this matter, think bigger" question** — I traced the actual downstream consumers' code (not just named them) to answer concretely: `score-inbox.mjs`'s `computeInboxRank()`, `compute-fit.mjs`'s `blendRank()`, `relationships.mjs`'s `enrich()`. Then proposed 3 "bigger" directions (see Key Decisions / Where We're Going) — none chosen yet, that's the open question for the next session.
9. **User asked about session cost/optimization** (unrelated tangent, triggered by viewing the `/status` panel) — answered with concrete, non-generic advice tied to the actual usage breakdown shown (76% subagent-heavy, 28% at >150K context, 18% parallel-session usage). Recommended `/compact` or a fresh session given length; user chose a fresh session.
10. **User then invoked `/handoffplan` directly** (not something I initiated) — I identified a real process conflict before running it blind: no `bd` CLI installed, no prior `HANDOFF_*`/`PLAN_*` convention in this repo, and the skill's default behavior (commit + close session automatically) would have silently duplicated the memory-based handoff already written. Surfaced this via `AskUserQuestion` rather than proceeding.
11. **User clarified they wanted to actually adopt beads and `/handoffplan` as a standing workflow going forward**, not skip it — reversing my initial recommendation. Installed beads (see Where We Are), asked a second `AskUserQuestion` about output-file location (`.claude/plans/` vs skill default root), got `.claude/plans/`, wrote that as a house rule into `modes/_custom.md`, and am now running the skill for real on this exact Signal-agent work (this handoff file is that live run).

## Key Decisions

- **Split storage (`deterministic` / `researched` sub-objects) over flat merge or always-full-recompute.** Rejected flat single-level merge because it doesn't give staleness visibility per signal category (a nightly-refreshed `updatedAt` would hide month-old funding/Reddit/LinkedIn data). Rejected always-full-recompute-nightly because it would run WebSearch-based research for every tracked company every night, which is exactly the cost `SKILL.md`'s original design was trying to avoid by splitting deterministic-cron vs on-demand-agent signals in the first place.
- **`heat` recomputed and stored at write time, not read time.** Chosen specifically to avoid touching any of the 3 external consumers (`relationships.mjs`, `score-inbox.mjs`, `compute-fit.mjs`) — they all just read `.heat` today and would need zero changes under this design. A read-time-computed `heat` was considered (more "pure," no denormalized field to go stale) but rejected as unnecessary churn for no consumer-facing benefit.
- **Omitted CLI flags mean "don't touch," not "score 0."** An explicit `--funding 0` must still count as a real researched value (agent looked, found nothing) — this requires the CLI to distinguish "flag truly absent from argv" from "flag present with value 0," which `parseArg()` already supports (`parseArg` returns `undefined` only when the flag isn't in argv at all) — the bug is purely in the `?? 0` collapsing that distinction away in `main()`, not in `parseArg` itself.
- **Partial-merge for the researched sub-object left as an explicit open call, not decided.** Should re-checking only Reddit (leaving funding/LinkedIn untouched) merge just that one field, or should all three always update together as a set? Leaning partial-merge for flexibility (matches the same principle applied to the deterministic side), but the user has not confirmed this — flag it explicitly to the next session rather than silently deciding.
- **Beads adopted in stealth mode, not shared/committed.** This is a single-user personal tool (Amit's search specifically), so there's no collaborator use case for a shared issue tracker — local-only, git-excluded fits the actual usage pattern. This was my recommendation, user did not push back.
- **`bd init` run with `--skip-agents --stealth` specifically to avoid auto-editing `AGENTS.md`.** This repo's `AGENTS.md` is treated as a load-bearing, carefully-curated file (holds the entire Data Contract) — decided any future beads-workflow documentation for agents belongs in `modes/_custom.md` (user-layer, survives `update-system.mjs`), never auto-generated into `AGENTS.md` by a third-party tool's default behavior.
- **`/handoffplan`'s default output location (repo root) overridden to `.claude/plans/`.** This repo already has an established convention for cross-session planning docs (`architect-system-design.md`, `mega-plan-next-sessions.md`) — writing to root would fragment that, and would also read as "sidecar documentation" which `AGENTS.md`'s own "Where rules live" section explicitly warns against for anything meant to be discovered automatically.

## Evidence & Data

**The core bug, in the actual code (verbatim, both pieces confirmed by direct reads this session):**

```js
// signal-agent/compute-heat.mjs:142-148 — the bug
export function writeCompanySignal(company, record) {
  const signals = loadSignals();
  const key = normalizeCompany(company);
  signals[key] = { company, ...record, updatedAt: new Date().toISOString() };  // no ...existing spread
  writeFileAtomic(SIGNALS_PATH, JSON.stringify(signals, null, 2) + '\n');
  return signals[key];
}

// signal-agent/compute-heat.mjs:239-241 — how record gets built, the 0-default problem
const funding = Number(parseArg(args, '--funding') ?? 0);
const reddit = Number(parseArg(args, '--reddit') ?? 0);
const linkedin = Number(parseArg(args, '--linkedin') ?? 0);
```

```js
// signal-agent/compute-stability.mjs:81-93 — the pattern that already works, to generalize
/** Merges into any existing record (e.g. compute-heat.mjs's heat/signals) rather than overwriting it. */
export function writeCompanyStability(company, { layoffRisk, signals }) {
  const all = loadSignals();
  const key = normalizeCompany(company);
  const existing = all[key] || {};
  all[key] = {
    ...existing,
    company: existing.company || company,
    layoff_risk: layoffRisk,
    layoff_signals: signals,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(SIGNALS_PATH, JSON.stringify(all, null, 2) + '\n');
  return all[key];
}
```

**Consumer grep results (full, not truncated) — confirms the redesign is safe:**

| File | Line | What it reads |
|---|---|---|
| `relationships.mjs` | 133, 139 | `readCompanySignal(r.company)` → `.heat` only |
| `score-inbox.mjs` | 99-101 | `readCompanySignal(entry.company)` → `.heat`, `.layoff_risk` |
| `compute-fit.mjs` | 759, 477-478 | `readCompanySignal(company)` → `.heat`, `.layoff_risk` |

No other file in the repo reads `.signals.funding`, `.signals.reddit`, `.signals.linkedin`, `.signals.github`, `.signals.velocity`, or `.velocityMeta` directly (grepped `rg -n "readCompanySignal|company-signals.json|\.signals\."` across `*.mjs`/`*.ts`, excluding `compute-heat.mjs` itself and unrelated files that happen to use the word "signals" for something else — `reply-matcher.test.mjs`, `invite-match.mjs`, `process-quality.test.mjs` all matched on `.signals` but for a completely unrelated `analyzeInvite()`/reply-matching result shape, not company signals).

**Proposed new record shape** (not yet implemented):

```json
{
  "company": "Acme Inc",
  "heat": 62,
  "deterministic": { "github": 80, "velocity": 40, "velocityMeta": {"newRoleCount": 3, "insufficientHistory": false}, "updatedAt": "2026-08-10T03:00:00.000Z" },
  "researched": { "funding": 70, "reddit": 20, "linkedin": 55, "updatedAt": "2026-07-29T18:00:00.000Z" },
  "layoff_risk": 40,
  "layoff_signals": {},
  "updatedAt": "2026-08-10T03:00:00.000Z"
}
```

## Code Analysis

- `signal-agent/compute-heat.mjs` — `computeHeat({funding, github, reddit, linkedin, velocity})` (pure function, weighted composite, self-tested at lines 163-169). The actual `WEIGHTS` constant (line 60-66): `{ velocity: 0.30, funding: 0.25, github: 0.20, linkedin: 0.15, reddit: 0.10 }` — **velocity (the free, deterministic signal) already carries the single highest weight in the composite**, more than funding despite funding being the most research-intensive signal to produce. Relevant to direction (a): a new repost-detection signal would need its own weight carved out of this set (or folded as a negative modifier on velocity itself, since both read the same `scan-history.tsv` source) — not yet decided which., `githubActivityScore(org, {fetchImpl})` (async, hits GitHub public REST API, self-tested with a stubbed fetch), `jobPostingVelocity(company)` (delegates to `compute-velocity.mjs`, returns `{score, newRoleCount, insufficientHistory}`), `readCompanySignal(company)` / `writeCompanySignal(company, record)` (the two functions this design touches), `normalizeCompany()` (imported from `tracker-utils.mjs`, shared key-normalization used consistently across the tracker/blacklist/signal systems).
- `signal-agent/compute-stability.mjs` — `computeLayoffRisk({events, trend})` (pure scoring: `events===1 → +40`, `events>=2 → +70`, negative headcount trend adds `clamp0to100(-trend*2)`), `writeCompanyStability(company, {layoffRisk, signals})` (the correct-merge pattern to generalize), `readCompanyStability(company)`.
- `signal-agent/SKILL.md` — documents the workflow an agent follows for on-demand full scoring; explicitly separates deterministic (auto-computed by the script) from agent-researched (requires WebSearch) signal categories; instructs "if a company has no discoverable signal for a given axis... score that axis `0` rather than guessing" — this instruction is about *research quality* (be honest when you found nothing), not the storage bug, and stays valid under the new design (a genuine "found nothing" `0` still means calling `writeResearchedSignals` explicitly with `0`, not omitting the flag).
- `web/src/app/api/run/route.ts` — the actual caller of the full on-demand workflow (`claude -p`-style invocation per `AGENTS.md`'s headless-mode table), currently gates re-scoring on a single `updatedAt` with a 7-day staleness window; needs updating to check `researched.updatedAt` specifically once the split lands (flagged as a follow-on fix, not yet scoped as its own phase).
- **`compute-fit.mjs:405-417` — `blendRank()`, the exact formula heat/layoffRisk feed into for full JD evaluations:**
  ```js
  export function blendRank({ domainFit, netEffectiveValueInr, hireability, heat = 50, layoffRisk = 0, effectiveValueCeilingInr = 6_000_000 }) {
    if (domainFit < DOMAIN_FIT_GATE_THRESHOLD) return { rank: 0, excluded: true, reason: ... };
    const effectiveValueScore = clamp0to100((netEffectiveValueInr / effectiveValueCeilingInr) * 100);
    const stabilityScore = clamp0to100(heat - layoffRisk + 50); // neutral heat=50/risk=0 centers at 50
    const rank = Math.round(effectiveValueScore * RANK_WEIGHTS.effectiveValue + hireability * RANK_WEIGHTS.hireability + stabilityScore * RANK_WEIGHTS.stability);
    return { rank, excluded: false, effectiveValueScore, stabilityScore };
  }
  ```
  Note the default `heat = 50` (neutral, not 0) when no signal exists at all — an unscored company is treated as average, not penalized. This matters for direction (b) in "Where We're Going": any proactive nudge mechanism should key off a company's *actual* stored heat crossing a threshold, not the neutral default, or it'll fire on every never-scored company.
- **`compute-fit.mjs:438-442` — `computeInboxRank()`, the simpler formula used for raw pending-inbox ranking (no comp figure available yet):**
  ```js
  const INBOX_RANK_WEIGHTS = { domainFit: 0.6, stability: 0.4 };
  export function computeInboxRank({ domainFit, heat = null, layoffRisk = null }) {
    const stabilityScore = clamp0to100((heat ?? 50) - (layoffRisk ?? 0) + 50);
    const rank = Math.round(clamp0to100(domainFit) * INBOX_RANK_WEIGHTS.domainFit + stabilityScore * INBOX_RANK_WEIGHTS.stability);
    return { rank, stabilityScore };
  }
  ```
  Same `?? 50` neutral-default pattern. Both formulas already treat "no data" as neutral rather than 0 — worth preserving that same philosophy in whatever the split-storage `heat` recompute does when `researched` has never been set (should default the missing researched sub-scores to `0` for computing `heat` itself — that's a documented, honest "no signal found" — but the *consumers* of `heat` already separately handle "no heat at all" via their own `?? 50`/`heat = 50` defaults; don't conflate the two null-handling layers when implementing.

**Recent commit history on `main`, most recent first (from `git log --oneline -20`, run this session) — the two most recent are the prior, now-complete work stream; everything before that is older, unrelated context:**

| Commit | Summary |
|---|---|
| `3c1991f` | Make relocation gate and skill-gap vocab read from the user's real profile |
| `2e14e24` | Finish removing hardcoded AI-archetype taxonomy from mode instructions |
| `e18033e` | Add blacklist gate to inbox triage, close Explore's blacklist gap |
| `26ff23f` | Explore relevance overhaul: word-boundary domain-fit matching, keyword-field seeding, company-first (seed) discovery by default |
| `40ef57e` | Add automatic triage on Explore adds + a FILTERED pipeline tab |
| `d4bc839` | Add job-posting velocity as a free 5th compute-heat signal — the commit that originally added the deterministic velocity signal this handoff's fix protects |

**For "think bigger" direction (a) — the two existing-but-unconnected scripts, with real signatures (not yet wired into `compute-heat.mjs` in any way):**
```js
// detect-reposts.mjs:100 — already computes exactly the "struggling to fill" signal direction (a) wants
export function detectReposts(rows, windowDays = DEFAULT_WINDOW_DAYS)
// parseScanHistory (line 58) turns data/scan-history.tsv rows into the shape detectReposts consumes —
// the same source file compute-velocity.mjs already reads for the deterministic velocity signal, so
// wiring this in would reuse an already-open data source, not add a new one.
```
`compute-stability.mjs`'s `computeLayoffRisk({events, trend})` (documented in Code Analysis above) only takes manually-supplied `--layoffs-fyi-hits`/`--headcount-trend-pct` flags today — it has no sentiment-research step at all. The live Glassdoor/Blind WebSearch done ad hoc during report #049's evaluation (prior work stream, not part of this chain) is the shape of research that would need to become a systematic, repeatable step here — not yet designed, would need its own scoring rubric the way `sources/funding-news.md` already has one for funding signals.

**A genuinely surprising, concrete gap found while researching this (read `signal-agent/sources/funding-news.md` in full):** its scoring rubric already has a "Negative signal override" — *"if the search surfaces layoffs, a funding round falling through, or a 'pausing hiring' statement within the last 90 days, score `0` regardless of any older positive funding history."* So the funding-research step **already actively watches for layoff signals during its normal WebSearch** — but today that evidence only zeros out the `funding` sub-score; it's never passed to `compute-stability.mjs`'s `layoff_risk` at all, even though it's the exact same category of evidence. This is the single cheapest possible win for direction (a): the funding-research workflow step should also emit whatever layoff/hiring-pause evidence it happens to find into a `writeCompanyStability()` call, not just silently fold it into a `0` and discard it.

**`compute-velocity.mjs`'s 14-day insufficient-history threshold** (referenced in `SKILL.md`, confirmed live 2026-07-29 per that file's own comment — every company's velocity read as "insufficient history" because scan history only spanned 2 days at the time) is the other deterministic signal's real behavior to know before touching any of this: it counts distinct NEW roles (deduped from reposts) first seen in the last 14 days, contributing `0` to the composite when there isn't 14 days of `data/scan-history.tsv` history yet for that company — same "honest 0, not silently missing" philosophy the whole subsystem uses.

## Files Changed

### Config & tooling (this session, unrelated to the code fix itself)
- `modes/_custom.md` (user-layer, gitignored) — added first-ever customization: `/handoffplan` house rule (output to `.claude/plans/`, not skill default), beads stealth-mode setup note
- `.beads/` (new, git-excluded via `.git/info/exclude`) — beads database, stealth mode, 0 issues so far
- `~/.claude/projects/-Users-adium-career-ops/memory/project_signal_agent_design.md` (new) — the design-state memory note this handoff was mined from; still valid, not superseded, this handoff is a superset with the full code evidence added
- `~/.claude/projects/-Users-adium-career-ops/memory/MEMORY.md` — index entry added pointing at the above

### Not yet changed (the actual implementation, all pending)
- `signal-agent/compute-heat.mjs` — needs `writeCompanySignal` split into `writeDeterministicSignals()`/`writeResearchedSignals()`, CLI flag defaulting fix
- `web/src/app/api/run/route.ts` — needs its 7-day staleness check updated to read `researched.updatedAt` once the split lands
- `signal-agent/compute-stability.mjs` — likely needs zero changes (its existing shallow merge already correctly preserves opaque `deterministic`/`researched` sub-objects it doesn't touch), but should be re-verified once the schema change lands, not assumed

## User Feedback & Preferences

- User wants the discuss→design-here / delegate-to-fresh-session→implement / verify-back-here workflow maintained — explicitly re-confirmed multiple times across this whole session (both in this chain and the prior, now-complete work stream).
- User explicitly does NOT want me spawning implementation agents myself — design/discussion only in this session type ("architecture session," named that way by the user via `/rename`).
- User pushed back hard ("wdym you are hallucinating, double check") when I stated something about `modes/_profile.md`'s content from memory without re-verifying against the live file — the lesson (already saved to memory pre-session, reinforced live here): always re-read/re-derive from the actual current file state before asserting it, never assert purely from a remembered summary.
- User asked "are we sure, no more structural integrity bugs, right?" — I gave a calibrated, non-overclaiming answer distinguishing "verified," "known and deliberately deferred," and "genuinely untested" categories rather than a blanket reassurance. This tone/rigor was not corrected — implicitly validated as the right calibration.
- User corrected an imprecise term I used ("auto-pipeline") by asking "wdym, the one that runs scan.mjs nightly, right??" — I re-checked the actual code rather than assuming my own prior phrasing was right, and found I actually had conflated two different things (`modes/auto-pipeline.md`, an interactive mode, vs `auto-evaluate-top-picks.mjs`, the real nightly script, which itself follows `modes/oferta.md` not `auto-pipeline.md`). Corrected precisely rather than just restating more confidently.
- User wants to "think broader and code broader, not small minded" when discussing this specific subsystem (Signal-agent) — an explicit request to go beyond the narrow bug-fix framing and propose genuinely higher-value directions, not just structural correctness. This is why the "3 bigger directions" exist in this handoff at all.
- User initiated `/handoffplan` unprompted mid-session once told the session was getting long — then, when I flagged the tooling mismatch (no `bd`, no repo convention) and asked whether to skip/adapt/run-literally, the user's actual intent turned out to be "install beads for real, adopt this permanently" — a case where the right move was surfacing the conflict rather than either blindly running the skill or blindly declining it.
- User cares about session cost/token efficiency but wants substantive answers, not hedged/generic advice — the /status-panel question got a direct, specifically-grounded answer (tied to the actual percentages shown), not generic "here are some tips."

## Where We're Going

1. **Next session (fresh, via the paste prompt from the paired PLAN file): implement the split-storage fix** in `compute-heat.mjs` (writeCompanySignal split, CLI flag fix) — this is Phase 1, already fully designed, no further discussion needed, can start coding immediately.
2. **Update `web/src/app/api/run/route.ts`'s staleness check** to read `researched.updatedAt` instead of the top-level field, so the 7-day re-score gate still works correctly once deterministic-only nightly writes exist.
3. **Re-verify `compute-stability.mjs` still behaves correctly** against the new nested shape (likely a no-op given its existing shallow-merge pattern, but confirm, don't assume).
4. **Separately, still fully open and NOT yet chosen by the user:** which of the 3 "think bigger" directions to design next — (a) fold in stability-sentiment/`detect-reposts.mjs` as new signals, (b) proactive heat-threshold nudges into `agent-inbox.mjs`/`portals.yml` scan cadence, (c) offer/interview-stage stability alerts. This should be a **separate discussion in a fresh architecture session**, not bundled into the implementation session for the merge-fix — the merge-fix is mechanical and ready to build; the 3 directions still need the same discuss-first treatment the merge-fix already got.
5. **Independent verification pass required after implementation**, same discipline as the prior work stream: diff review + running `compute-heat.mjs --self-test` and `compute-stability.mjs --self-test` directly (not trusting the delegated session's self-report), plus a live `--read`/write round-trip test with a real company to confirm the merge actually preserves prior researched values across a deterministic-only write.

## Implementation Sketch (for Phase 1 of the paired PLAN — not final code, but the concrete shape)

```js
// Replaces writeCompanySignal() at compute-heat.mjs:142-148

function mergeSignals(existing, updates) {
  return { ...existing, ...updates, updatedAt: new Date().toISOString() };
}

function recomputeHeat(record) {
  const d = record.deterministic || {};
  const r = record.researched || {};
  return computeHeat({
    github: d.github ?? 0, velocity: d.velocity ?? 0,
    funding: r.funding ?? 0, reddit: r.reddit ?? 0, linkedin: r.linkedin ?? 0,
  });
}

export function writeDeterministicSignals(company, { github, velocity, velocityMeta }) {
  const signals = loadSignals();
  const key = normalizeCompany(company);
  const existing = signals[key] || {};
  const deterministic = mergeSignals(existing.deterministic || {}, { github, velocity, velocityMeta });
  const record = { ...existing, company, deterministic };
  record.heat = recomputeHeat(record);
  record.updatedAt = new Date().toISOString();
  signals[key] = record;
  writeFileAtomic(SIGNALS_PATH, JSON.stringify(signals, null, 2) + '\n');
  return record;
}

export function writeResearchedSignals(company, { funding, reddit, linkedin }) {
  // Same shape, mirrored: merges into existing.researched only, leaves
  // existing.deterministic untouched, recomputes heat from both.
  // Partial input (e.g. only `reddit` passed) should merge just that key —
  // see Open Questions #1, not yet confirmed with the user.
}
```
CLI (`main()`) needs restructuring so it calls `writeDeterministicSignals` unconditionally (github/velocity are always either freshly computed or explicitly disabled via `--no-github`/`--no-velocity`, which should still count as a real `0` write, not an omission — these two flags are deliberate overrides, not silence) and calls `writeResearchedSignals` **only when at least one of `--funding`/`--reddit`/`--linkedin` is actually present in `argv`** (check with `args.includes('--funding')` etc., not just `parseArg`'s return value, to correctly distinguish "flag present with explicit 0" from "flag absent").

## Dependencies & Sequencing Notes

- Phase 1 (the storage-split fix) has no dependency on any of the 3 "think bigger" directions — it should ship first and independently, since it's the correctness fix protecting against a bug that exists today regardless of which direction gets built next.
- Direction (a) (fold in stability-sentiment + `detect-reposts.mjs`) depends on Phase 1 landing first — it needs `writeCompanyStability`'s existing merge behavior re-verified against the new nested shape before adding a new call site to it.
- Direction (b) (proactive nudges) and direction (c) (offer-stage alerts) do not depend on Phase 1 at the code level, but both consume `heat`/`layoff_risk` values that are more trustworthy once Phase 1 ships (no more nightly-cron data loss) — sequencing them after Phase 1 is a quality choice, not a hard technical dependency.
- The nightly cron for deterministic signals (Open Question #2) is a prerequisite for direction (a)'s repost-detection piece to run automatically, but not for the funding-research negative-signal-override wiring, which already happens during the existing on-demand agent workflow regardless of any cron.

## Risks & Blockers

- **Schema migration for existing records — confirmed real, not hypothetical.** `data/company-signals.json` exists with 39 real companies already scored, e.g. (verbatim, Broadcom's actual current record): `{"company": "Broadcom", "heat": 55, "signals": {"funding": 75, "github": 100, "reddit": 50, "linkedin": 75, "velocity": 0}, "velocityMeta": {"newRoleCount": null, "insufficientHistory": true}, "updatedAt": "2026-07-29T10:35:51.010Z"}` — all 39 in the OLD flat `signals: {...}` shape. Phase 1 needs either a one-time migration step (read old shape, write new `deterministic`/`researched` split once) or `readCompanySignal`/`recomputeHeat` tolerating both shapes during a transition window. Not yet decided which — make this an explicit Phase 1 sub-task, not an afterthought discovered mid-implementation.
- **`web/src/app/api/run/route.ts:61`'s staleness-check fix is trivial (a one-line prompt-string edit, confirmed — see Where We Are) but easy to forget entirely**, since it's not in the same file as the main bug and there's no test that would catch a missed update (it's LLM-prompt prose, not asserted code). If missed, the nightly-cron path would leave the on-demand researched-scoring route thinking a deterministic-only-refreshed record is "fresh" and skip a genuinely-needed re-score. Low engineering risk, real omission risk — put it on the plan's phase checklist explicitly.
- **No nightly cron for the deterministic half actually exists yet** — this whole design assumes a future cron calls `compute-heat.mjs` with only `--github-org` (no funding/reddit/linkedin flags). That cron itself is not part of this handoff's scope and hasn't been designed. Confirm with the user whether the merge-fix alone is worth shipping now (protects against a *future* nightly job, and also fixes any manual partial-flag invocation today) or whether the cron should be designed in the same pass.
- **compute-stability.mjs's self-test (lines ~120-145) writes real data into `data/company-signals.json`-shaped test fixtures** — when re-verifying it against the new schema, follow the same backup-before-test/restore-after-test discipline established in the prior work stream (real `data/needs-input-queue.json` was backed up before running `relocation.mjs --self-test`, restored after) if any self-test in this subsystem turns out to touch real, non-isolated data files rather than a temp path. (`compute-heat.mjs`'s own self-test already uses `tmpSignalsPath` — confirm `compute-stability.mjs`'s does too before running it.)

## Related Handoffs

None — this is the first `/handoffplan` handoff ever written in this repo (confirmed: `ls plans/handoffs/` and `ls .claude/handoffs/` both returned "No such file or directory" during Step 1A this session, before this file was created at the repo's actual convention path, `.claude/plans/`). No sibling or ancestor handoffs exist to cross-reference.

## Open Questions

0. Migration strategy for the 39 existing real records in `data/company-signals.json` — one-time rewrite vs. dual-shape tolerance (see Risks & Blockers).
1. Partial-merge vs. always-together for the 3 researched signals (funding/reddit/linkedin) on an on-demand agent update — leaning partial-merge, not confirmed with the user.
2. Should the deterministic-signals nightly cron itself be designed now, or is this handoff scoped to just the storage-bug fix (protecting future/manual use) with the cron left for later? `SKILL.md`'s "When to run" section already names the mechanism if/when this gets designed: "As a scheduled daily job (via `/loop` or `/schedule`, if the user opts in during onboarding-style setup — mirrors how `modes/AGENTS.md`'s Step 6 offers a recurring scan)" — i.e. the same opt-in pattern `AGENTS.md`'s Step 6 already uses for the portal scanner, not a new mechanism to invent — verbatim from `AGENTS.md:230-232`: *"Want me to scan for new offers automatically? I can set up a recurring scan every few days so you don't miss anything... use the `/loop` or `/schedule` skill (if available) to set up a recurring scan entrypoint... If those aren't available, suggest adding a cron job."* A deterministic-signals cron would follow the identical offer/confirm/configure shape, just for `compute-heat.mjs --company X --github-org slug` (no funding/reddit/linkedin flags) instead of `scan.mjs`.
3. Which of the 3 "think bigger" directions to pursue — entirely open, user has not indicated a preference yet.

## Quick Start for Next Session

```bash
# Restore context
cat /Users/adium/career-ops/.claude/plans/HANDOFF_standalone-50b78d94_signal-agent-automation_2026-08-10.md
cat /Users/adium/career-ops/.claude/plans/PLAN_standalone-50b78d94_signal-agent-automation_2026-08-10.md

# Prior context in memory
cat ~/.claude/projects/-Users-adium-career-ops/memory/project_signal_agent_design.md

# Key files to read first
signal-agent/compute-heat.mjs        # the bug + what to change
signal-agent/compute-stability.mjs   # the pattern to generalize (writeCompanyStability, lines 81-93)
signal-agent/SKILL.md                # documents the deterministic-vs-researched split this fix protects
web/src/app/api/run/route.ts         # the 7-day staleness check that needs updating (grep "updatedAt")

# Verify current state before changing anything
node signal-agent/compute-heat.mjs --self-test
node signal-agent/compute-stability.mjs --self-test

# Next action
Read the paired PLAN file's Phase 1 and start implementing writeCompanySignal's split-storage fix in compute-heat.mjs
```
