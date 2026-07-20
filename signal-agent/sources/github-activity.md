# Signal source: GitHub org activity (deterministic, zero-LLM)

Produces the `github` sub-score (0-100) for `signal-agent/compute-heat.mjs`.
Unlike the other three signals, this one is **not** agent-researched —
`compute-heat.mjs`'s `githubActivityScore()` computes it directly from
GitHub's public REST API (no auth required for public repos, 60 requests/hr
unauthenticated — fine for a once-daily run over a tracked-company list).

## Finding the org slug

The GitHub org slug is usually the company's lowercase/hyphenated name (e.g.
`anthropics` for Anthropic, `openai` for OpenAI), but it isn't always a
literal match. If you don't already know it:

1. WebSearch `"{Company}" site:github.com` and look for an org page
   (`github.com/{org}`, not a personal or forked repo).
2. Or check the company's own site — many link their GitHub org from the
   footer or an "Open Source" page.

If no org is found, skip this signal for that company (pass no
`--github-org` and no `--github` override to `compute-heat.mjs` — it
defaults to `0`, which is correct: no public GitHub presence is a real,
honest `0` on this axis, not a research failure).

## What it measures

`githubActivityScore(org)`:
- **Recency (60% weight):** how recently the org's most-recently-pushed repo
  was pushed to, decaying linearly from 100 (pushed today) to 0 (pushed
  `lookbackDays` days ago or longer; default lookback 90 days).
- **Breadth (40% weight):** what fraction of the org's 10 most-recently-pushed
  repos were pushed to within the lookback window — a proxy for org-wide
  activity rather than one lone maintained repo.

## Running it

Usually invoked automatically by `compute-heat.mjs --github-org {slug}` as
part of the `SKILL.md` workflow — you don't need to call
`githubActivityScore()` directly. If you do need the raw score in isolation
(e.g. to sanity-check a result), it's exported from `compute-heat.mjs`:

```js
import { githubActivityScore } from './compute-heat.mjs';
const score = await githubActivityScore('anthropics');
```

A `null` return means the API call failed (org not found, rate-limited, or a
network error) — treat that as "signal unavailable," not a `0`, and don't
silently substitute a guess. Retry later or ask the user before scoring a
company `0` on an axis whose real evidence you were never able to check.
