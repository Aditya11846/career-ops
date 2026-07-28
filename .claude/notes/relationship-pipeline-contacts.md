# Relationship pipeline — contact discovery (technical reference)

Scope: once a target company is identified, how to legitimately find and reach the right specific person. Not job-board scraping — this is people-finding. Written as a technical reference, not motivational content.

---

## 1. Public-identity sources (no tooling cost, variable automatability)

| Source | Structure | Automatable? | Risk |
|---|---|---|---|
| Company "Team/Leadership" pages | Low — every company's HTML differs | Manual-only in practice; a generic scraper breaks constantly | None (public, published to be read) |
| Engineering/product blogs (bylined posts) | Medium — often has an author byline + link | Semi-automatable per-platform (Medium, Substack, Ghost have predictable markup); custom CMS = manual | None |
| Conference speaker pages | Medium-high — most conf sites use a template per event | Automatable per-event, not generalizable across all conferences | None |
| Patents (named inventors) | High — USPTO/Google Patents have structured, queryable public data | Fully automatable (Google Patents Public Data on BigQuery, USPTO PatentsView API) | None — this is a genuinely strong, underused source for finding senior technical/R&D people by name at a target company |
| Published research papers | High — arXiv, Google Scholar, Semantic Scholar all have public APIs | Fully automatable | None |
| GitHub org members | High — GitHub REST API (`/orgs/{org}/members`) is public and free | Fully automatable, zero risk | None (respects whatever visibility the org set) |

**Verdict**: patents, papers, and GitHub org members are the only three that are both structured AND fully automatable with a public API — genuinely buildable. Team pages, blogs, and speaker pages are real signal but each needs bespoke parsing per site; treat as a manual/semi-manual research aid, not something to build a generic scraper for.

---

## 2. Email-finder tools

| Tool | Mechanism | Price (2026) | Accuracy | Legal/ToS standing |
|---|---|---|---|---|
| **Hunter.io** | Domain-pattern guessing (firstname.lastname@domain, etc.) + SMTP/deliverability verification. Not a scraped database. | From ~$34/mo annual | ~91–96% verified-email accuracy; independent tests found ~97% of "high confidence" results legitimate | Lower risk than the others — largely pattern-inference + public MX/SMTP checks, not bulk-scraping a social platform |
| **Apollo.io** | Combines a large contact database (210M+ contacts) built partly via scraping (incl. LinkedIn) with enrichment/verification | $74–299/mo depending on tier (credit-based) | Not independently documented as cleanly as Hunter's | **Actively enforced against**: LinkedIn removed Apollo's company page (along with Seamless.ai and Prosp.ai) on 2025-03-06/07, widely attributed to Apollo's LinkedIn-scraping data pipeline. Apollo's CEO said core platform "not disrupted," but this confirms LinkedIn is willing to act against tools built on scraping its data, even when the underlying data was publicly visible. |
| **RocketReach** | Database lookup, 700M+ profiles, includes phone data on paid tiers | Pro ~$99/mo annual | ~60–70% phone accuracy; email accuracy not as cleanly documented | Similar profile-database-of-scraped-origin risk category as Apollo, lower public profile of enforcement so far |

**Verdict**: Hunter is the better bet of the three specifically because its core mechanism (pattern-guess + verify) doesn't depend on having scraped a platform in the first place — it's inferring a likely address from a known name + known domain, which is a fundamentally different (and safer) technique than Apollo/RocketReach's database-of-profiles model. Given Apollo just got its LinkedIn presence pulled for exactly this reason, I'd treat Apollo/RocketReach as tools with real platform-risk baked into their own supply chain, not just "use at your own risk" boilerplate.

---

## 3. LinkedIn — the manual/automated boundary

- **Fine, zero risk**: a human manually searching LinkedIn, viewing profiles, sending a normal connection request or InMail through LinkedIn's own UI. This is just using the product as intended — no different from browsing any website.
- **LinkedIn Sales Navigator** (a real, legitimate paid product, not scraping): Core tier ~$79.99/mo annual, Advanced ~$139.99/mo annual, Advanced Plus custom-quoted (team-oriented, $1,300–1,600/seat/year, 10-seat minimum — not relevant for individual use). Gives 50+ search filters, real-time job-change alerts, 50 InMail credits/month, unlimited people browsing within LinkedIn's own product. This is the legitimate version of "better contact discovery on LinkedIn" — it costs money but carries none of the ToS risk scraping does, because it's LinkedIn's own tool operating within LinkedIn's own systems.
- **Automated/bulk pulling** (browser automation scripts, headless scraping, third-party database tools built on scraped LinkedIn data): this is the risky category, already covered in the prior research pass (hiQ settlement, Apollo takedown). Confirmed again here via the Apollo case: LinkedIn enforces even against publicly-visible data when the access pattern is automated/bulk rather than a human browsing normally.

**Boundary in one sentence**: the line isn't "public vs private data," it's "a human looking at one page at a time through LinkedIn's own product" vs "software pulling data at scale outside LinkedIn's product." Sales Navigator is the paid way to get more of the first without crossing into the second.

---

## 4. Warm-path discovery — the actual numbers

Real response-rate data found (multiple independent 2025–2026 sources):

- Referred candidates get interviews at **40–65%** rates, roughly **10–20x** the rate of cold applicants.
- Cold job applications: **2–8%** interview rate. Cold email outreach generally: **2–5%** response rate.
- Warm intros/referrals: **40–60%** meeting/response rate — an order of magnitude higher than cold.

This isn't a marginal effect — it's the single biggest lever in this entire research area. A warm path (shared alumni network, past-employer overlap, mutual connection) converts roughly 10x better than the best paid cold-contact-discovery tool could ever get a cold email to convert.

**Legitimate tools for finding the warm path itself** (not the contact's email, but the *connection*, which is the more valuable output):
- LinkedIn's own native "how you're connected" / mutual connections display — this is a first-party feature, zero scraping, shows exactly what you need (shared connections, shared alumni).
- University alumni association directories/portals — usually opt-in, member-facing, legitimate.
- Past-employer alumni networks (many large companies run official alumni Slack/Discord/LinkedIn groups) — explicitly designed for this exact purpose.

**Implication for the relationship pipeline feature**: given the 10x+ gap between warm and cold, the highest-leverage thing the feature could do is surface *known overlaps* (shared university, shared past employer, shared industry group) between the candidate and people at a target company — not just find any name + guessed email at that company. Finding a warm path to a mediocre contact beats finding a perfect cold email address for the "best" contact.

---

## 5. Email verification

Once you have a name-guessed or tool-found email, verifying it before sending avoids bounces (which can flag a sending domain/IP as spam) — standard mechanism is SMTP handshake verification (connect to the mail server, issue a `RCPT TO`, read the response code without actually sending) or checking against a verification API (Hunter and most competitors bundle this). Risk: doing many raw SMTP verification pings from one IP can itself get that IP rate-limited/greylisted by receiving mail servers — in practice, low-volume individual use (a handful of verifications for a real, targeted outreach list) is not the same risk profile as bulk list-cleaning, and is generally fine.

---

## Overall recommendation

1. **Best legitimate method, ranked**: (1) surfacing warm-path overlaps via LinkedIn's native "how you're connected" feature + alumni networks — 10x the response rate of anything else here, zero cost, zero risk; (2) GitHub org members / patents / papers for structured, zero-risk *cold* contact identification when no warm path exists; (3) Hunter.io for email-pattern-guessing + verification once you have a specific name, paid but low-risk mechanism.
2. **Paid tools verdict**: Hunter.io is worth its cost for what it actually is (a well-verified email-pattern guesser). Apollo.io and RocketReach are not recommended — their core value proposition depends on a database built via the same scraping approach LinkedIn is now actively enforcing against (Apollo's own company page got pulled in March 2025 for this). Sales Navigator is worth it only if the volume of manual LinkedIn research justifies ~$80–140/mo — it's legitimate but is a research/browsing upgrade, not a contact-discovery shortcut.
3. **Overall**: build the warm-path/overlap surfacing first — it has by far the best cost-to-response-rate ratio of anything examined. Treat cold-contact tools (Hunter, patents/papers/GitHub) as a fallback path for target companies where no warm connection exists at all.
