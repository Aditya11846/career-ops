# Skill: signal-agent — company_heat scoring

Computes a `company_heat` score (0-100) per company, combining four signals
into one number that feeds the evaluation pipeline as a post-scoring
adjustment (never edited into `modes/_shared.md`'s formula — see
`compute-heat.mjs`'s file header for why).

**Cadence:** run this daily, not per-scan — company signals (funding, GitHub
activity, hiring chatter) don't meaningfully change hour to hour, and each
run costs a handful of WebSearch calls per company. Don't run it inline
during a `/career-ops pipeline` or `/career-ops scan` pass.

## When to run

- The user asks to "compute company heat," "score company signals," or
  similar.
- As a scheduled daily job (via `/loop` or `/schedule`, if the user opts in
  during onboarding-style setup — mirrors how `modes/AGENTS.md`'s Step 6
  offers a recurring scan).
- Before Apply Agent fires on a Tier 1/2 job (Phase 4/5), to make sure the
  target company's heat score is fresh before it's folded into that job's
  final fit score.

## Workflow

For each company (either one the user names, or every `enabled: true` entry
in `portals.yml`'s `tracked_companies`):

1. **Funding/news** — follow `sources/funding-news.md`. Produces a 0-100
   `funding` sub-score.
2. **Reddit hiring signal** — follow `sources/reddit.md`. Produces a 0-100
   `reddit` sub-score.
3. **LinkedIn hiring signal** — follow `sources/github-activity.md`'s sibling
   guidance is GitHub-specific; LinkedIn has no public API for this, so
   research it the same way as funding/Reddit: WebSearch for "{company}
   hiring" / recruiter posting cadence over the last 30 days, and judge a
   0-100 `linkedin` sub-score using the same rubric shape as the other two
   (see `sources/funding-news.md`'s scoring rubric — apply the same 0/25/50/75/100
   anchors to hiring-cadence evidence instead of funding evidence).
4. **GitHub activity** — this one is deterministic, not agent-researched.
   Pass `--github-org <slug>` to `compute-heat.mjs` (see
   `sources/github-activity.md` for how to find the org slug) and it computes
   the `github` sub-score itself via GitHub's public REST API — no WebSearch
   needed for this signal.
5. **Compute and persist:**
   ```bash
   node signal-agent/compute-heat.mjs --company "{Company}" \
     --funding {0-100} --reddit {0-100} --linkedin {0-100} \
     --github-org {org-slug}
   ```
   This writes/updates `data/company-signals.json` (keyed by
   `normalizeCompany()`, same normalization the tracker uses) and prints the
   resulting record, including the composite `heat` score.
6. **Report back** to the user: company name, composite heat, and the one or
   two strongest contributing signals (e.g. "Acme: heat 78 — Series B closed
   3 weeks ago, GitHub org shipped 4 releases this month").

If a company has no discoverable signal for a given axis (no news, no GitHub
org, nothing on Reddit), score that axis `0` rather than guessing — a
missing signal is not the same as a bad signal, but `compute-heat.mjs` has
no way to distinguish "genuinely cold" from "no data found" unless you're
honest about scoring `0` only when you actually found nothing, not when you
didn't look.

## Reading a stored score

```bash
node signal-agent/compute-heat.mjs --read "Company Name"
```

Returns the stored record (or `null`) — useful before Apply Agent fires, or
when the user asks "what's {Company}'s heat score."

## Verification

Run `node signal-agent/compute-heat.mjs --self-test` after any change to
`compute-heat.mjs` — it exercises the scoring math and the GitHub API
integration (via a stubbed fetch, no network needed) without touching real
data.
