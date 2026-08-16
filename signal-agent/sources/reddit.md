# Signal source: Reddit hiring/interview mentions (last 60 days)

Produces the `reddit` sub-score (0-100) for `signal-agent/compute-heat.mjs`.

## How to research

Run a WebSearch scoped to Reddit:

```
site:reddit.com "{Company}" (hiring OR interview OR "phone screen" OR onsite OR offer)
```

Prefer subreddits relevant to the candidate's target roles —
r/cscareerquestions, r/developersIndia, r/ExperiencedDevs — but don't
restrict the search to only those; a company-specific thread anywhere on
Reddit is still signal. Scope to the last 60 days.

## Scoring rubric

| Score | Evidence |
|-------|----------|
| 100   | Multiple (3+) recent threads describing active interview processes or recent hires at the company within 60 days |
| 75    | 1-2 recent threads describing an active interview process or a recent hire |
| 50    | Mentions of the company in a hiring context, but vague or secondhand (e.g. "heard they're hiring", no firsthand account) |
| 25    | A single old or ambiguous mention, or the company appears mostly in unrelated contexts (product reviews, complaints unrelated to hiring) |
| 0     | No hiring-related mentions found in the window |

**Sentiment matters, not just volume.** A thread full of "avoid this company,
brutal interview loop with no offer" is still evidence of active hiring
volume — score it on the *hiring activity* axis (this signal), and let any
negative-culture read surface separately if the user asks about it. This
axis is not a culture/red-flag check; `modes/interview-redflag.md` already
owns that job.

Don't fabricate specifics (thread titles, quotes) if you can't find a real
one — a search that turns up nothing scores `0`, plainly.
