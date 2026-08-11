# Stagehand Full Vision — Unbounded Web Coverage for career-ops

**Date:** 2026-08-11
**Status:** PLANNED — brainstorm locked, spawn individual sessions per phase
**Predecessor:** PLAN_stagehand-apply-upgrade_2026-08-11.md (Phase 1 prototype)

---

## The Core Shift

Today career-ops is bounded by which ATS APIs we've written adapters for (~30% of the market).
Stagehand + Amit's real Chrome session removes that boundary entirely.
The system stops being a curated pipeline and becomes a genuine web agent operating as Amit.

---

## Phase 1 — Fix Apply (Foundation)
*Prerequisite for everything else — spawn this first*

Already planned in `PLAN_stagehand-apply-upgrade_2026-08-11.md`. Summary:
- Install Stagehand LOCAL mode → uses Amit's real Chrome session (auth already solved)
- Replace `extract.ts` CSS selectors with `page.extract()` AI vision
- Replace brittle fill with `page.act("fill [field] with [value]")`
- Route Workday/iCIMS/SmartRecruiters → Stagehand; Greenhouse/Lever/Ashby → existing path

---

## Phase 2 — Close the Gaps in the Existing Apply Flow

Everything that currently lands in `needs-input.md` and requires manual intervention:

### 2a. Screening knockout questions
Workday/iCIMS forms often have 5-15 screening questions before the application fields.
"Do you have 5+ years experience in X?" / "Are you authorized to work in the US?" / "Will you require sponsorship?"
- Stagehand reads each question, reasons against `config/profile.yml` + `modes/_profile.md`
- Answers from Amit's actual profile — never fabricated
- Non-answerable (ambiguous, policy) → still pauses to `needs-input.md`

### 2b. Salary fields — context-aware filling
Currently ALL salary fields pause. Stagehand can:
- Read the field label and surrounding context ("Annual base salary in USD")
- Cross-reference Amit's salary targets from `config/profile.yml`
- Fill confidently when unambiguous; still pause when genuinely ambiguous (equity fields, bonus %, etc.)

### 2c. Boilerplate fields — stop pausing on these
"How did you hear about us?" → "LinkedIn" / "Job board"
"GitHub URL?" → from profile
"Portfolio URL?" → from profile
"LinkedIn URL?" → from profile
"Cover letter text area?" → generated from `apply` mode output, pasted in-form
All of these currently pause. None should.

### 2d. EEOC / demographic post-submission forms
After main form submits, many ATS platforms redirect to a separate EEOC form.
Stagehand detects and handles it in the same session — no abandoned EEOC forms.

### 2e. Multi-step "Save and Continue" navigation
Workday: 6-10 steps. iCIMS: 3-5 steps.
Stagehand drives each step to completion, recognizes step indicators, handles "Next"/"Save and Continue" naturally.

### 2f. Confirmation verification
After submit: Stagehand reads the page and extracts confirmation state:
`{ success: bool, trackingNumber: string|null, message: string }`
Replaces current text-matching guess. Feeds `submission-log.mjs` with real confirmation data.

---

## Phase 3 — LinkedIn Easy Apply (Currently Skipped by Design)

LinkedIn Easy Apply is the dominant application method for senior security roles.
Currently explicitly skipped in `run-approved.mjs` because headless Playwright can't handle LinkedIn's anti-bot detection.

Stagehand + Amit's real logged-in Chrome → LinkedIn sees a real user.
- `opencli linkedin job-detail <url>` → extract job metadata + confirm Easy Apply available
- Stagehand fills the Easy Apply form (it's a modal, 2-4 fields typically)
- `opencli linkedin safe-send` for any follow-up message to hiring manager

This single phase opens up a massive chunk of the market that's completely dark right now.

---

## Phase 4 — "Apply with LinkedIn" / SSO on Third-Party Sites

Many ATS platforms have "Apply with LinkedIn" or "Sign in with Google" buttons.
Currently impossible — OAuth flow requires an authenticated session.
Stagehand + real Chrome: Amit is already logged into LinkedIn and Google in that browser.
The SSO button just works. No special handling needed.

Affects: Lever (has LinkedIn SSO option), many startup custom ATS platforms.

---

## Phase 5 — Scanner: Any Company, Not Just ATS-API Companies

`scan.mjs` today: only companies on Greenhouse/Ashby/Lever APIs.
That's ~30% of the market. The other 70%:
- Companies on Workday/SAP (no public API)
- Companies on iCIMS/SmartRecruiters (no public API)
- Companies with completely custom career pages
- Companies that only post on LinkedIn

**Stagehand scanner:**
- Given any `careers_url` in `portals.yml`
- Navigate to the page, extract all job listings: title, location, URL, date posted
- Works on any HTML structure — no adapter needed per company
- New `providers/stagehand.mjs` provider alongside existing `greenhouse.mjs`, `ashby.mjs`, `lever.mjs`
- `portals.yml` gets `provider: stagehand` for companies that don't have an ATS API

This makes every company in the world scannable with a single provider.

---

## Phase 6 — Application Status Polling

Currently: passive — we wait for emails (reply-watch) to know if an application moved.
With Stagehand: active — we navigate back to the submission portal and read the status.

- After submission, `submission-log.mjs` stores the portal URL + application ID
- Periodic check (new `check-app-status.mjs`): Stagehand navigates to the portal, logs in (real session), reads status
- Status changes ("Application Viewed", "Under Review", "Interview Requested") → update tracker + alert
- Feeds `reply-watch` with confirmed status changes, not just email guesses

---

## Phase 7 — Glassdoor Deep Research (Authenticated)

Currently: we can't read Glassdoor because it's paywalled and anti-bot.
Stagehand + Amit's real logged-in Glassdoor session:
- CEO approval rating
- Salary bands for the specific role
- "Interview Experience" score + reported interview questions
- Recent reviews sentiment (last 6 months, not all-time average)

Feeds:
- `deep` mode company research (Block D)
- `interview-prep` mode with real reported questions
- `interview-redflag` mode with culture red flags from reviews

---

## Phase 8 — Recruiter Reply Intelligence (LinkedIn Inbound)

When a recruiter cold-messages Amit on LinkedIn:
- `opencli linkedin inbox` detects new messages
- For each new recruiter message: Stagehand reads the full message + navigates to recruiter's profile
- Cross-references company against tracker + signal-agent heat score
- Generates brief: "Palo Alto Networks (heat: 78). No active role in tracker. This recruiter has 340 connections, posts regularly. Company recently had 2 reposts on same role — possible backfill. Suggest: reply with interest, ask for JD."
- Routes to `agent-inbox.mjs` as an action item, not raw email noise

---

## Phase 9 — Job Alert Setup (One-Time Automation)

Navigate to Indeed / LinkedIn / Glassdoor:
- Set up email job alerts for Amit's target keywords and locations
- Stagehand handles the form fields, confirmation clicks
- Run once; then organic inbound flows to Gmail → Gmail MCP → reply-watch

This bootstraps the inbound channel without manual setup.

---

## What This Looks Like When Done

| Capability | Today | After Stagehand Full Vision |
|---|---|---|
| ATS coverage (apply) | Greenhouse/Lever/Ashby (~30%) | Every ATS + LinkedIn Easy Apply (~100%) |
| Scanner coverage | ATS-API companies only | Any company with a careers URL |
| Screening questions | Always pauses | Auto-answered from profile |
| Salary fields | Always pauses | Context-aware fill |
| LinkedIn Easy Apply | Skipped | Fully automated |
| Application status | Passive (wait for email) | Active polling |
| Glassdoor research | Blocked | Full authenticated access |
| Recruiter inbound | Manual triage | Auto-briefed, routed to inbox |
| EEOC forms | Abandoned | Handled in same session |
| SSO apply buttons | Impossible | Works (real Chrome auth) |

---

## Spawn Order (Recommended)

1. `PLAN_stagehand-apply-upgrade_2026-08-11.md` — Phase 1 foundation (already written)
2. Phase 2 (close existing gaps) — spawn after Phase 1 verified
3. Phase 3 (LinkedIn Easy Apply) — high impact, spawn concurrently with Phase 2
4. Phase 5 (universal scanner) — spawn after Phase 1, independent of Phases 2-3
5. Phases 6-9 — spawn in order after foundation is stable

Each phase is a separate session. No phase depends on a later one.
