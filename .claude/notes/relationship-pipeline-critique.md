# The case against building a bespoke "relationship pipeline" — critique

Written as the deliberate counter-argument in the redesign brainstorm. Not softened for agreeableness, not manufacturing false balance. Lands on a real position.

---

## 0. The finding that changes this whole discussion

Before getting to the five questions asked: **a company-signal-tracking system already exists in this repo, unused.**

`signal-agent/compute-heat.mjs` (+ `signal-agent/sources/{funding-news,reddit,github-activity}.md`) computes a 0-100 `company_heat` score per company from four signals — funding/news, GitHub org activity, Reddit hiring chatter, LinkedIn hiring-cadence signals — and persists it to `data/company-signals.json`. This is not a sketch; it's a working scorer with a self-test, a documented weighting rationale, and explicit non-goals (never mixed into the core scoring formula — applied as a post-scoring adjustment instead). It was built to run daily, "before Apply Agent fires," to make sure a target company's heat score is fresh.

It is not wired into the web dashboard anywhere. It doesn't run on any cadence — its own SKILL.md says it needs `/loop` or `/schedule` opt-in, meaning nobody has actually turned it on. `data/company-signals.json` was one of the files archived (wiped) earlier this session as part of the clean-slate reset, alongside all the other dead apply-agent artifacts.

This is the single most important fact for this critique: **the instinct to build new bespoke signal-tracking software here is not a fresh idea, it's rebuilding something that was already built once, then abandoned before it was ever turned on.** That is a stronger, more concrete version of the batch-apply-agent pattern already documented this session (complex custom tooling, built with real engineering effort, that never once produced a working result because nobody checked if the simple/existing thing worked first). The lesson from that incident wasn't "the orchestrator had bugs" — it was "the effort went into new construction before verifying what already existed." Same shape here, arguably worse: this time the thing that already exists is sitting right in the repo, not even hypothetical.

**Anything proposed below has to answer: why does this need new code, when `signal-agent` already does most of the "detect who/what to pay attention to" job and has simply never been switched on?**

---

## 1. Non-bespoke version — what already covers 80% of this, today, free

| Tool | Setup cost | What it covers | What it genuinely misses vs. a bespoke tracker |
|---|---|---|---|
| **Google Alerts** | 2 min/company, free | Keyword+company mentions emailed as they're indexed. Covers funding news, press mentions — same axis as `signal-agent`'s "funding" signal, arguably fresher (real-time vs. daily) | No GitHub-activity signal, no Reddit-specific filtering, no composite score, no per-person tracking, no linkage to career-ops's applications data |
| **A spreadsheet / Notion / Airtable database** | 15-30 min to set up columns | Full manual control: person, company, last-contact date, next-action date, notes. Sortable, filterable, has a phone app, works completely offline of any of this tooling | No automated signal detection at all — pure manual entry. Does not replace `signal-agent`'s value; replaces the "pipeline UI" half only |
| **LinkedIn's native "Follow"/notify-me on companies and people** | Seconds per target, free | Job-change notifications, company update posts — arguably the single best low-effort signal for "this person moved, this company is growing" since it's LinkedIn's own first-party data | No composite scoring, no export, tied to LinkedIn's own notification cadence (can be sparse), no integration with anything else |
| **Crunchbase free tier alerts** | Free tier exists but rate-limited, some alerting behind paywall | Funding-round tracking specifically | Redundant with Google Alerts for the funding axis specifically; adds nothing `signal-agent`'s funding signal doesn't already conceptually cover |

**Combined for zero engineering cost**: Google Alerts (2 companies/day to set up) + a spreadsheet (30 min one-time) + following target people/companies on LinkedIn (ambient, ongoing) covers company-signal detection AND person/contact tracking AND cadence/reminders (spreadsheet next-action-date column, sorted) — the three things a "relationship pipeline" feature would nominally add. It's slower to check (manual, not surfaced in one dashboard) and has zero composite scoring — that's the real, honest gap. Everything else is redundant with what's free.

---

## 2. Maintenance-burden argument

Confirmed by reading the codebase directly: career-ops's data layer is exclusively plain files — markdown (`applications.md`, `pipeline.md`), YAML (`portals.yml`, `config/profile.yml`), JSON (`data/company-signals.json`, `data/*.json`), TSV. No database anywhere. `followup-cadence.mjs` — the closest existing analog to a "cadence/reminder" feature — is **not a scheduled job**. It's a pure function: parse `applications.md` + `data/follow-ups.md` on demand, compute which entries are overdue based on a date-diff against "today," print the result. It only "knows" something is overdue because it's re-run and re-computes from scratch every time — there is zero persistent scheduling infrastructure anywhere in this codebase. `signal-agent`'s own docs confirm this independently: it explicitly says a daily cadence requires opting into Claude Code's own `/loop` or `/schedule` mechanism, because career-ops itself has nothing built in for recurring execution.

So: a "relationship pipeline" that implies proactive reminders ("reach out to X, it's been 3 weeks") is not "one more page" — it is either (a) another pure on-demand recompute function in the exact same style as `followup-cadence.mjs` (cheap, consistent with the codebase's existing architecture, no new category of system), or (b) an actual scheduled/background job, which would be the FIRST piece of always-on infrastructure this repo has ever had. Option (a) is nearly free architecturally. Option (b) is a real, novel cost — new failure modes (what happens if it doesn't run for a week), new operational surface (where does it run — the user's machine has to be on), and it's not something career-ops has ever needed to solve before. Given `signal-agent` already chose option (b)-avoidance (defer to `/loop`/`/schedule` rather than build its own scheduler), the precedent in this exact codebase is: don't build (b).

---

## 3. The actual bottleneck test

For an 18-month-unemployed, 22-year-experience candidate, there are three candidate bottlenecks, and they are not equally likely:

- **"I don't have a system to track who to contact"** — a tooling gap. Solvable by software.
- **"I don't know who to contact, or am not doing outreach at all yet"** — a behavior/confidence gap. Not solvable by better tracking software; solvable by literally starting, with help identifying the first 10 names.
- **"I don't have the network density senior outreach requires"** — a topology gap. Not solvable by tooling at all — this is what executive recruiters, alumni networks, and industry associations exist to partially compensate for, and no tracker manufactures a network that isn't there.

Eighteen months of unemployment with (presumably) no organized outreach system yet visible in this codebase is much more consistent with bottleneck #2 (behavior/confidence — outreach hasn't started, or has been sporadic) than bottleneck #1 (an existing outreach practice that's merely disorganized). Building sophisticated tracking software for an outreach practice that doesn't exist yet solves a problem one step ahead of the real one. The blunt version: a system to organize 50 ongoing relationships is not useful to someone who hasn't started reaching out to 5 people yet.

**Fair counter-argument, stated honestly**: a simple, visible tracker can itself be the intervention that starts the behavior — an empty "people to contact" list with a blank row inviting a name is a lower-friction first step than "figure out your networking strategy" in the abstract. This is a real, evidence-consistent effect (visible checklists / trackers do measurably drive follow-through in habit-formation and job-search-coaching literature broadly, not specific to this case). But note precisely what this argument supports: it supports a **dead-simple, manually-populated list** (which is exactly what the free spreadsheet in Section 1 already is), not a bespoke, signal-scored, auto-populated pipeline. The accountability-effect argument justifies the cheapest possible version, not the expensive one.

---

## 4. Opportunity cost

Ranked by what's already been sized this session:

| Item | Real cost | Value |
|---|---|---|
| Fix `portals.yml` Intern/Founding filter bug | ~10 min | Directly fixes an already-observed real failure (Glean mismatch). Highest certainty of value per minute spent of anything on this list. |
| India `portals.yml`/Paytm/Fampay source merge | Well under a session, config-only | More real postings, zero new code, zero new risk. |
| `schema.org JobPosting` structured-data parser | ~1 session | Legitimate, low-risk, generalizes past the 4-ATS ceiling — the strongest NEW-capability candidate identified this whole research session. |
| Cover-letter chat-loop wiring | 1-2 sessions | Real feature, but conversational/state-machine work, genuinely bigger. |
| Turn ON existing `signal-agent` (wire into dashboard, decide a cadence) | Unclear, but almost certainly LESS than building new — it's already-written code needing integration, not invention | Gets most of "company-level relationship pipeline" value without writing new detection logic |
| **New bespoke person/contact relationship-pipeline software** | Multi-session (new data model, new UI, and — per Section 2 — possibly new scheduling infrastructure this repo has never needed before) | Most exciting idea in the conversation. Least certain value. Competing for attention against four items above that are all cheaper and more certain. |

The honest read: the relationship pipeline is the most emotionally compelling idea in this session (it's the one most directly tied to "how do I actually help my father"), which is exactly the profile of idea most likely to get built for the wrong reason — not because it's the highest-leverage next step, but because it feels the most like Doing Something about a situation that's genuinely stressful. That instinct is understandable and not a criticism of Aditya's judgment; it's a very normal way priorities get miscalibrated under emotional weight, and naming it plainly is more useful than pretending it isn't a factor.

---

## 5. Verdict

**Don't build it now — not as bespoke software.** In order:

1. **Fix `portals.yml` today.** Already agreed, already cheap, already has a concrete observed failure it fixes. Do this first regardless of anything else in this document.
2. **Turn on `signal-agent` before writing anything new.** It already does the company-signal half of "relationship pipeline" — funding, GitHub activity, Reddit/LinkedIn hiring chatter, composite heat score, persisted to `data/company-signals.json`. The work here is integration (wire it into the dashboard, pick a cadence via `/loop` or manual runs) not invention. This directly tests whether the underlying idea has real value BEFORE any new code gets written — exactly the verification-before-construction discipline this session's earlier retrospective said was missing.
3. **For the person/contact side specifically** (which `signal-agent` doesn't cover at all): start with the free spreadsheet, today, for real, with his father actually using it. Real trigger condition for when bespoke software would earn its keep: **once he is doing outreach consistently for 4+ weeks using the spreadsheet, and the specific pain point is "the spreadsheet itself is the bottleneck" (too slow to update, can't see priority, missing a signal it should have caught) rather than "I'm not using it enough."** If the complaint after 4 weeks is about volume/behavior, more software doesn't fix that. If the complaint is specifically about the tool's limits, that's real signal to build.
4. **Structured-data harvesting (`schema.org JobPosting`) is a better use of a build-slot than the relationship pipeline** if the question is "what should we build next" — it's cheaper, lower-risk, and expands the pool of postings for BOTH Aditya and his father, whereas the relationship pipeline serves one narrower workflow that hasn't been validated as the actual bottleneck yet.

Building the bespoke tracker now would repeat the exact shape of mistake already documented this session: real engineering effort spent on new construction, ahead of verifying (a) that existing/simpler alternatives don't already cover it, and (b) that the problem it solves is actually the bottleneck rather than the most emotionally salient idea in the room.
