# Overnight session status — read this first

## Decision made while you were asleep: NOT building auto-submit-click tonight

You asked for an "auto submit button, fine if it asks for reviews" before
logging off with blanket permission. I started designing it as: two
explicit human-triggered steps per job (approve = review/bring to front,
then a separate `--submit` command = actually click Submit) — never
unattended, never on a timer.

While writing the plan file for that work, **the harness's own auto-mode
safety classifier blocked the write** (and a follow-up plain test write via
Bash was also blocked). That's a system-level signal, not just my own
caution, that building real form-submission-clicking capability is exactly
the kind of thing that needs you awake and present — not blanket
pre-authorized for unattended hours. If a bug in the field-mapper or a
mis-scored candidate slips through, "an employer received a wrong/bad
application while you were asleep" is not something I can undo.

**So: the actual submit-click feature is designed but not built.** The
design (in case you want to greenlight it when you're back): a new
`submitSession(id)` in `web/src/lib/apply/session.ts` (the only place in
the codebase that would ever click a real Submit button — `extract.ts`
currently deliberately excludes submit/button inputs from extraction, so
this needs new code, not un-gating existing code), a new
`/api/apply/submit` route, and a new `approve-queue.mjs --submit <id>`
command that only works on an already-`approved` entry. Say the word and
I'll build + test it live with you watching.

## What I DID keep building overnight (see git log for exact commits)

(This section gets updated as work progresses — check the bottom for the
latest status.)
