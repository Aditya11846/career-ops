# Relationship Pipeline — technical design

Scoping doc for a proposed new career-ops feature: tracking outreach targets (people/companies) for off-market senior hiring, running alongside the existing scored-job pipeline. Design only — no code written.

## 0. Precedent already in the codebase (load-bearing finding)

career-ops already has a near-identical mechanism for a different purpose: **the follow-up cadence system** (`followup-cadence.mjs`, `followup-seed.mjs`, `data/follow-ups.md`, `web/src/app/api/followups/route.ts`). It tracks per-application follow-up state with a `next-follow-up-date`, computes urgency (`computeUrgency(status, daysSinceApp, daysSinceLastFollowup, followupCount)`), and resolves the next date (`computeNextFollowupDate`). Crucially, **there is no cron or scheduler anywhere in this codebase** — the API route comment calls it "the DEMAND loop": urgency is recalculated on every read by comparing stored dates to `today()`, the same way `/api/doctor` recomputes health on demand instead of caching a background check. This is the exact pattern to reuse for relationship-pipeline reminders — no new scheduling infrastructure needed, and it de-risks gotcha (5) below entirely: the capability already exists, just for the wrong entity type.

Also relevant: `followup-seed.mjs`'s docstring describes a real historical bug — "the follow-up system was born dead" because seeding only happened on manual mode invocation, not automatically when a row changed to Applied. Lesson for this design: **wire the seed/reminder-creation step into whatever action creates a relationship-tracking row**, don't leave it as a manual step a user has to remember, or this feature dies the same way.

## 1. Data model

Confirmed existing pattern: flat files under `data/`, no database. `data/applications.md` is a markdown table; `data/pipeline.md` is a markdown checklist; `data/follow-ups.md` uses a hybrid: markdown table rows for *sent* follow-ups plus non-tabular "pin directive" lines (`- next #<n> <date> (set <date>)`) for *scheduled-but-not-yet-sent* state — deliberately NOT a table row, because a table row means "a follow-up was SENT". This distinction matters and should be copied.

Proposed file: **`data/relationships.md`**, same hybrid shape:

```
# Relationships — Outreach Pipeline

| # | Added | Target | Type | Company | Role/Context | Source Signal | Status | Last Contact | Report Link | Notes |
|---|-------|--------|------|---------|---------------|----------------|--------|---------------|--------------|-------|
| 1 | 2026-07-26 | Jane Doe | person | Acme Corp | VP Eng, hiring signal | manual | drafted | — | — | Met at conference 2024 |
| 2 | 2026-07-20 | Acme Corp | company | Acme Corp | Series C funding | signal:funding | not_contacted | — | — | Auto-added from funding signal |

## Pending outreach (pin directives — scheduled, not yet sent)
- next #1 2026-08-02 (set 2026-07-26)
```

Columns, with rationale:
- `Type`: `person` | `company` — a company-only row (no named contact yet) is valid and common; the model must not force a person name before one is known.
- `Status` enum (mirrors the existing `Status` normalization pattern in `followup-cadence.mjs`'s `normalizeStatus`): `not_contacted` → `drafted` → `sent` → `responded` → `meeting` → `dead`. Five meaningful transitions, not more — resist adding "warm/cold" temperature scoring as a v1 feature, it's subjective and not actionable.
- `Source Signal`: free text or a tagged value (`manual`, `signal:funding`, `signal:leadership-change`, `signal:referral`) — this is the plug point for the OTHER research track (signal detection), kept as a simple string so this design has zero dependency on that work landing first.
- `Report Link`: optional, nullable — a relationship is NOT required to link to an existing scored-job report, because (per the brainstorm rationale) a person can be relevant with zero current open postings at their company. This is the key structural difference from `applications.md` rows, which always represent one specific job.
- Pin-directive block: identical mechanic to `follow-ups.md`, reused verbatim rather than reinvented — `next #<id> <date> (set <date>)`, last pin wins, re-seeding is always safe.

A companion `relationships-cadence.mjs` would mirror `followup-cadence.mjs` almost line for line: `computeOutreachUrgency(status, daysSinceAdded, daysSinceLastContact)` replacing `computeUrgency`, same `today()`/`daysBetween`/`addDays` helpers (candidates for extracting into a tiny shared module rather than copy-pasting, if doing this for real — flag as a minor refactor opportunity, not a blocker).

## 2. UI / page design — `/network`

Day-to-day usage model for a user like Aditya's father:

- **Table view**, same visual language as the existing `/pipeline` page (score→urgency swap): columns Target, Type, Company, Status, Last Contact, Next Follow-up, Source. Sortable by urgency (overdue first — mirrors `/api/followups`'s "overdue first" ordering already proven on the home page).
- **Manual add**: a simple form (name optional, company required, context/notes, initial status defaults to `not_contacted`) — this MUST work with zero dependency on any signal feed, since that's separate future work and this page needs to be useful on day one with just manually-added targets.
- **Signal-populated add (future plug point, not built here)**: the interface contract this page exposes is simply "append a row to `data/relationships.md` with `Source Signal` set to a `signal:*` tag." Whatever future signal-detection system exists just needs to write in this shape — no coupling required today.
- **Row detail / drawer**: click a row → shows notes history, a "Draft outreach" button (see §3), and a manual status-change control (mirrors the existing `setStatus` confirm-card pattern on `/pipeline`).
- **Urgency banner**: reuse the home page's existing "N overdue follow-ups" banner pattern (`/api/followups`) — add a parallel "N relationships need outreach" banner sourced from `relationships-cadence.mjs --json`, same DEMAND-loop mechanism, zero new infra.

## 3. Human-in-the-loop integration — `draftOutreach` action envelope

Must follow the proven apply-flow rule exactly: **AI drafts, human reviews, human sends manually outside the app** (there is no "send" integration proposed here at all — no email API, no LinkedIn messaging API. The app's job ends at producing a reviewed draft the human copies out. This sidesteps entirely the LinkedIn ToS/automation risk flagged earlier in the brainstorm — outreach drafting is pure text generation, sending is 100% manual, same as how CV/cover-letter generation never touches the actual application submission).

Proposed action envelope, added to the existing fixed list in `web/src/app/api/assistant/route.ts`'s system preamble:

```
- draftOutreach {"targetId":"3","angle":"referral ask via mutual connection"} —
  draft a short outreach message (email or LinkedIn-style DM) for relationship
  row #3. Uses cv.md + config/profile.yml + the target's notes/context for
  grounding, same honesty rules as cover-letter generation (real experience
  only, no fabricated shared history). Shows the draft in chat for the user
  to edit/approve. NEVER sends anything — there is no send action. Once
  approved, emits setRelationshipStatus {"targetId":"3","status":"drafted"}.
```

Gate design, mirroring `setStatus`'s existing confirm-before-write pattern: `draftOutreach` itself is read-only (just generates text in the chat reply, nothing written to disk) — no confirm card needed for the draft itself, exactly like how the assistant can already freely suggest CV edits in chat without writing anything. Only the status transition (`drafted`, `sent`, etc.) needs the same confirm-card gate `setStatus`/`setProfile` already use, since that's the one write. This keeps drafting cheap/frequent (no permission friction to iterate on wording) while keeping the one real mutation gated.

Honesty constraint worth stating explicitly since this touches interpersonal claims (higher stakes than a cover letter's company-research paragraph): the draft generator must ONLY reference things present in `cv.md`/profile/the relationship row's own notes — it must never invent a shared connection, a fabricated prior interaction, or a mutual contact that wasn't recorded by the user. This is a stricter honesty bar than cover letters (which at least draw on public company research) because a fabricated "great meeting you at X conference" is a much easier lie to get caught in.

## 4. Separate system vs. bolted-on pipeline lane — verdict

**Argument for bolting on** (adding new statuses to `data/applications.md`): reuses the existing table, existing `/pipeline` UI, existing `merge-tracker.mjs`/`setStatus` machinery entirely — genuinely less new code.

**Argument for separate** (own file + page): every existing `applications.md` row is anchored to one specific job posting + one evaluation report (`Report Link` is effectively mandatory in practice, always populated). A relationship row structurally often has **no** report to link to — a person can be worth tracking with zero currently-open postings at their company. Forcing relationships into the applications table means either (a) a required-but-meaningless Report column for most rows, or (b) fabricating a placeholder report just to satisfy the schema, which is exactly the kind of structural dishonesty this whole project has been trying to eliminate elsewhere (see the CV fact-verification gate). The two entities have genuinely different lifecycles too: an application is closed out (Offer/Rejected) and essentially archival after; a relationship persists indefinitely regardless of any single job's outcome (someone you stay in touch with after a rejection is exactly the point of a *relationship* pipeline).

**Recommendation: separate file + separate page.** The data-model mismatch (report-link optionality) is a real structural conflict, not a cosmetic one — bolting on would either break the schema's meaning or force a dishonest placeholder. The marginal cost of a second small file + page is low given how directly this reuses the follow-up-cadence pattern (§0), so the "less new code" argument for bolting on is weaker than it first appears.

## 5. Effort sizing — phased, honest

- **Phase 1 (data model + page, read/write, manual add only) — one session.** `data/relationships.md` file format, a `/network` page with table view + manual-add form + row detail drawer + manual status change (mirrors existing `/pipeline` UI patterns closely, so this is mostly adaptation, not invention). No cadence/urgency yet, no assistant integration yet.
- **Phase 2 (cadence + urgency banner) — half a session.** `relationships-cadence.mjs` is largely a fork of `followup-cadence.mjs` with the status enum swapped (§0) — genuinely small given the direct precedent. Wire the seed-on-row-creation step in immediately (don't repeat the "born dead" bug from `followup-seed.mjs`'s own documented history).
- **Phase 3 (`draftOutreach` action + assistant wiring) — one session.** New system-prompt section, new envelope parsing, the honesty-constraint prompt engineering (§3) needs real iteration/testing to get right, not just wiring — this is the part most likely to run long, budget for it.
- **Out of scope entirely for this design**: any signal-detection feed (funding news, leadership changes, job-posting-adjacent signals) that would auto-populate rows — that's the other research track's territory and this design only defines the row-append interface it would need to satisfy (§2). Do not conflate sizing of that separate, likely-larger effort with the phases above.

**Total for a usable-but-manual-only version (Phases 1-2): roughly 1.5 sessions.** Full version with AI-drafted outreach (Phase 3): roughly 2.5 sessions. Signal-feed auto-population is unscoped/unsized here by design.

