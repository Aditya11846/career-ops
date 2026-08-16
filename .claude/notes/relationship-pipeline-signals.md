# Relationship pipeline — signal detection technical research

Pathway: what data signals indicate a company is likely to have a senior opening soon, and how to actually pull each one programmatically. Evaluated for real API access, cost, legal risk, and honest signal strength (not career-advice hand-waving).

---

## 1. New executive/leadership hires

**Correlation strength: real, moderate-strong, and time-bounded.** McKinsey data: 62% of externally-hired CEOs take 6+ months to become fully productive; HBR/executive-transition literature converges on leadership teams typically being reshaped by day 60, with "problem" reports/hires addressed after ~6-8 weeks of observation. Practical read: a new VP/Director hire predicts elevated hiring probability on THEIR team in roughly the 2-6 month window after their start date, not immediately, and not indefinitely — this is a decaying, time-boxed signal, not a permanent flag.

**Access options, ranked by legitimacy:**
- **SEC EDGAR full-text search** (`efts.sec.gov/LATEST/search-index?q=...`, official, free, no auth) — for PUBLIC companies only, executive officer changes are a mandatory Item 5.02 disclosure in 8-K filings, filed within 4 business days of the event. This is the single most reliable, legally clean signal for public companies: structured, mandatory, timestamped, zero scraping. Third-party wrappers (sec-api.io, SEC-API-io/sec-api-python) exist to make this queryable by keyword/CIK if the raw EDGAR full-text search UI/API is too low-level to work with directly, but the underlying official API is free and sufficient on its own. **Limitation: covers public companies only** — most of Aditya's target list (startups scanned via Greenhouse/Ashby/Lever) are private and file nothing with the SEC. This signal is strong but narrow in applicability to career-ops's actual company list.
- **Company newsroom/blog RSS** — free, zero legal risk, but coverage is inconsistent; only larger/PR-conscious companies maintain one, and format isn't structured (requires text parsing/NLP to extract "who + what role + started when").
- **PR Newswire / Business Wire RSS** — both offer real RSS/Atom feeds filterable by 250+ industry/subject keywords. Distribution is free to consume (RSS reading is free); the cost sits on the company's side to distribute a release, not on the consumer's side to read it. Legitimate, low-risk, but same caveat as above: signal quality depends on companies choosing to issue a press release for the hire — a VP-level hire below C-suite frequently doesn't get one.
- **Google News RSS keyword query** (`news.google.com/rss/search?q="{company}" appoints OR names OR hires`) — free, no auth, real RSS output. Aggregates across many outlets so catches more than any single newswire. Noisier (needs de-duplication and false-positive filtering for the word "hires" showing up in unrelated contexts).
- **LinkedIn company page "recent hires"** — explicitly out of scope per the earlier scraping-risk research; not evaluated further here.

**Verdict**: legitimate and worth building for public companies (SEC EDGAR path), useful-but-noisier for private companies (press/news RSS, needs an NLP extraction step). Not a signal career-ops can get for free-form arbitrary startups reliably — press coverage of a Director-level hire at a 50-person startup is genuinely rare. Best framed as "a bonus signal that fires occasionally," not a primary pipeline input.

---

## 2. Funding rounds / M&A / PE buyouts

**Correlation strength: well-established directionally** — post-funding hiring waves are one of the most cited patterns in startup-ecosystem literature (headcount growth is a standard use-of-funds category in raise announcements). Timing lag is real but variable (weeks to a few months after close, depending on the round size and function being scaled).

**Access options:**
- **Crunchbase API** — confirmed as of 2026: **free tier is gone.** Basic paid plan starts at $49/month, full API access effectively requires Pro ($99/month) or higher; enterprise custom pricing for bulk/programmatic use. Not a "cheap" option anymore — this is a real ongoing cost, not a one-time setup.
- **PitchBook** — enterprise-only, no realistic individual-developer path. Excluded.
- **SEC EDGAR** — same mechanism as above but for M&A (8-K Item 2.01 "Completion of Acquisition," proxy statements for larger deals). Free, but public-company-only — misses almost all VC-funded private startup activity, which is exactly the population career-ops mostly tracks.
- **TechCrunch / press RSS** — same free-RSS-feed mechanism as executive hires above; TechCrunch and similar outlets do have RSS feeds, filterable by category. Free, legitimate, but coverage-dependent (only funding rounds newsworthy enough to cover, meaning mid-size/later rounds more than small seed rounds).

**Verdict**: the paid tier (Crunchbase) is the only comprehensive option and it now costs real money monthly — this is a genuine build-vs-buy decision, not a free technical win. The free alternative (RSS-based press monitoring) is real but structurally incomplete: it will miss most funding events below Series B/C visibility. Recommend NOT building a dedicated funding-signal integration initially — treat it as a "nice to have if the paid tier is ever justified by real usage," not a v1 feature.

---

## 3. Job-posting velocity (derived from data career-ops ALREADY has)

**This is the strongest candidate technically** — requires zero new data source, zero new API, zero new legal exposure. It's pure trend analysis on `scan.mjs`'s existing output history.

**What the research says**: hiring-signal industry literature (Autobound, Crustdata, JobsPikr — all commercial "hiring signal" vendors, so treat their marketing claims with appropriate skepticism, but the underlying mechanic is sound) defines velocity as posting count relative to company size, and treats a sudden spike in open-role count as one of the strongest available correlates of active budget allocation/growth — stronger than a single new-hire announcement, because it reflects actual current intent rather than a proxy.

**Important data-quality caveat found**: published research (cited via ACM) notes 50-80% duplicate/repost rates in raw job-posting data in some contexts. A naive "count of postings this week" metric will be noisy — the same role reposted or a listing bumped to the top doesn't mean the company doubled its hiring. Any implementation MUST dedupe by (company, title-normalized) before computing velocity, or the signal is closer to noise than signal.

**Concrete technical shape**: career-ops already writes scan results over time (data/scan-history.tsv per earlier session findings). Compute per-company posting count per scan run, normalize/dedupe, then flag companies whose deduped open-role count has meaningfully increased over a trailing window (e.g. 2-4 weeks) relative to their baseline. This is a pure data-analysis feature on top of existing storage — no new adapter, no new legal surface, no new cost.

**Verdict**: build this first. It's the only signal in this entire research pass that is simultaneously (a) free, (b) zero legal risk, (c) requires no new infrastructure, and (d) has genuine, non-hand-wavy predictive grounding. Everything else in this document is secondary to this.

---

## 4. GitHub org activity (tech companies only)

**Access**: GitHub's REST API is free, well-documented, and requires no auth for public data (though authenticated requests get a much higher rate limit). Unauthenticated: 60 requests/hour — too low to be useful. Authenticated (a free personal access token): 5,000 requests/hour, which is workable for monitoring a modest watchlist of companies' public orgs (new repos created, contributor count changes, commit frequency).

**Correlation strength**: plausible but narrow and noisy. New repo creation or contributor growth in a company's public GitHub org can indicate a new team/initiative forming — but it's confounded heavily by open-source strategy choices unrelated to headcount (a company open-sourcing an existing internal tool, a hackathon repo, a doc-only repo). Also **only applicable to companies with real public-facing open-source activity** — the majority of companies, including most of the ones on a typical Greenhouse/Ashby scan list, either have no public org or only publish marketing-adjacent repos, not signal-bearing engineering activity.

**Verdict**: legitimate, zero-risk, easy to build technically — but low general applicability. Worth it only as an optional per-company enrichment for known tech-forward companies, not a broad pipeline feature. Deprioritize relative to #3.

---

## 5. Conference speaker lists / published papers / patent filings

**Access**: PatentsView (developer.uspto.gov) and the newer Open Data Portal (data.uspto.gov) are both free, public, require no API key/auth, updated weekly (PatentsView) — genuinely frictionless to query the full US patent corpus by assignee (company) name.

**Correlation strength**: real but slow and indirect. A company filing patents in a new domain does suggest investment/hiring in that area — but patent filing lags actual hiring by many months (filing happens after R&D work has already started, often after the people doing the work were already hired), meaning this is a lagging indicator of past hiring, not a leading indicator of future hiring. Its practical use is closer to "confirms a company is serious about domain X, worth targeting for outreach," not "this company is about to open a role."

Conference speaker lists / published papers were not found to have any comparable free structured API — this would require ad hoc, per-conference scraping/reading, not a reusable integration. Not technically buildable as a general pipeline feature; at most a manual research step a human does for one specific target company.

**Verdict**: patents — cheap to query, but weak/lagging as a hiring-timing signal; better suited as supporting context for an outreach message ("I saw you're filing in X") than as a pipeline-trigger signal. Conference/papers — not a buildable API-driven feature at all, exclude from any v1.

---

## Overall technical recommendation

Ranked by (legitimacy × cost × actual predictive strength), for a v1 build:

1. **Job-posting velocity from existing scan data** — build this first. Free, zero new legal surface, zero new infrastructure, strongest non-hand-wavy grounding of anything researched. The only real engineering work is the dedup logic (50-80% repost-rate problem) and the trailing-window comparison.
2. **SEC EDGAR executive-change + M&A monitoring** — build second, scoped explicitly to "public companies only" (be honest in the UI/report that this won't cover most startups). Free, official, zero legal risk, mandatory-disclosure data (not press-dependent), so it's the most RELIABLE of the non-#1 signals even though its coverage is narrower.
3. **Press/news RSS monitoring** (PR Newswire, Business Wire, Google News keyword query) for executive-hire and funding mentions on private companies — real and free, but noisier and requires an NLP extraction step to turn free text into structured (company, event-type, date) records. Worth building after #1 and #2, not instead of them.
4. **GitHub org activity** — cheap optional enrichment for known tech companies only, not a general feature. Low priority.
5. **Do not build**: Crunchbase/funding-API integration (real ongoing cost, $49-99+/month, only justified if usage volume later proves it out — not a v1 decision), conference/paper monitoring (no reusable API, not buildable as a pipeline feature, manual-research territory only), patent monitoring as a hiring-timing trigger (technically easy but too lagging to trigger outreach timing — fine as supporting context, not as a signal).

Sources:
- [SEC Filing Full-Text Search API](https://sec-api.io/docs/full-text-search-api)
- [sec-api Python SDK](https://github.com/janlukasschroeder/sec-api-python)
- [Crunchbase API in 2026: Free Tier Gone](https://dev.to/agenthustler/crunchbase-api-in-2026-free-tier-gone-what-startup-data-hunters-do-now-1177)
- [Crunchbase Pricing 2026 (G2)](https://www.g2.com/products/crunchbase/pricing)
- [Hiring Signals and How to Track Them in Real Time (Crustdata)](https://crustdata.com/blog/hiring-signals)
- [Labor Market Signals: Job Posts, Hiring Velocity, Role Mix (Potent Pages)](https://potentpages.com/web-crawler-development/web-crawlers-and-hedge-funds/labor-market-signals-job-posts-hiring-velocity-role-mix)
- [Hiring Velocity — Autobound API docs](https://autobound-api.readme.io/docs/hiring-velocity-signal)
- [GitHub API Rate Limits in 2026](https://dev.to/agenthustler/github-api-rate-limits-in-2026-when-web-scraping-is-the-better-choice-hdo)
- [PatentsView API — USPTO Open Data Portal](https://developer.uspto.gov/api-catalog/patentsview)
- [Business Wire RSS/Atom feed options](https://www.businesswire.com/help/feed-options)
- [PR Newswire RSS feeds](https://www.prnewswire.com/apac/rss/)
- [Deloitte — The myth of the first 90 days](https://www2.deloitte.com/us/en/insights/focus/executive-transitions/myth-first-90-days.html)
- [The First 100 Days: A Strategic Framework to Onboard New Executives](https://www.jrgpartners.com/first-100-days-how-onboard-new-executive-success/)
