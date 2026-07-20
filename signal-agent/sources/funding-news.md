# Signal source: funding / news (last 90 days)

Produces the `funding` sub-score (0-100) for `signal-agent/compute-heat.mjs`.

## How to research

Run a WebSearch for the company's recent funding and major news:

```
"{Company}" funding round OR raised OR Series {A,B,C,...} OR acquisition OR IPO
```

Scope the search to the last 90 days. Also check the company's own
`/newsroom` or `/press` page if a WebSearch turns up nothing — smaller
companies sometimes announce funding only on their own site before it's
picked up by press aggregators.

## Scoring rubric

Anchor the 0-100 score to concrete evidence, not vibes:

| Score | Evidence |
|-------|----------|
| 100   | Funding round announced in the last 30 days, or a major growth signal (large new enterprise contract, notable expansion) in the last 30 days |
| 75    | Funding round or major growth signal 31-60 days ago |
| 50    | Funding round or major growth signal 61-90 days ago, or a smaller/quieter signal (modest headcount growth news, a minor product launch with hiring implications) within 30 days |
| 25    | Only a stale (>90 days) funding signal, or a small ambiguous signal within 90 days |
| 0     | Nothing found in the last 90 days |

**Negative signal override:** if the search surfaces layoffs, a funding round
falling through, or a "pausing hiring" statement within the last 90 days,
score `0` regardless of any older positive funding history — recent negative
signal outweighs stale positive signal for this purpose (we're scoring
current hiring heat, not lifetime company health).

Don't fabricate a score from a company's reputation or size alone — a
household-name company with no recent news scores `0` on this axis just like
an unknown one. This axis measures *recent* signal only.
