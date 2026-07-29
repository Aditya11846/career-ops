# Brainstorm session — 2026-07-26

Running notes from a live redesign brainstorm. Goal: think broad on each section of career-ops, then narrow down. Not a plan doc, not commitments — just a working record so nothing said gets lost mid-session.

---

## 1. Job Discovery

### How it works today (confirmed, mechanical)
- Two access points, same underlying capability:
  - `scan.mjs` + `portals.yml` — zero-LLM, deterministic. Loops a hand-maintained `tracked_companies` list in `portals.yml` (each entry: company, ATS type, slug), hits that ATS's public JSON API, applies a title allow/blocklist.
  - Web `/explore` page (`lib/explore.ts` + `scan.ts`) — thin wrapper over `scan-ats-full.mjs --dry-run`. Same 4-ATS ceiling underneath, just a different access pattern.
- **It's real API calls, not scraping.** Greenhouse/Ashby/Lever/Workday all expose a public, unauthenticated JSON API that a company's own careers page fetches client-side to render itself — `scan.mjs` calls that exact same endpoint. That's why it's fast, free, no login, doesn't break on HTML/CSS changes.
- **Model is pull, not push**: only ever looks at companies explicitly listed in `portals.yml`. Cannot discover an unknown company. Cannot see any company not on one of the 4 supported ATS platforms — LinkedIn, Naukri, Indeed, custom career pages, aggregators are all structurally invisible, not just unconfigured.
- Ceiling, precisely: **known-company list × 4 supported ATS dialects.**

### Known bug (separate from the ceiling above, cheap to fix, not yet done)
- `portals.yml`'s title filter excludes "Intern" (Aditya's real, honest current level) while doing nothing to exclude senior-only signal words like "Founding" — direct cause of the Glean (Founding FDE, 4+ yrs required) mismatch. Agreed: remove the Intern exclusion. Not yet applied.

### Cheap widening options found (config-only, no new adapter code)
- Merge in `career-ops-india`'s `portals/india.yml` (more companies, same 4 ATS types).
- Add Paytm + Fampay directly — both already run on `jobs.lever.co`.

### Vision discussion — breadth (2026-07-26)

**Q: why is direct-ATS-API scanning "better" than an account on Greenhouse/Ashby/Lever?**
Not really a fair comparison — these aren't marketplaces, they're B2B hiring software each company licenses separately. No cross-company search exists on their end to sign up for. Our method gets real-time structured data for companies we've listed, no login/rate-limit/HTML-breakage risk. Tradeoff is narrowness (known companies only), not an alternative to some broader "account" option that doesn't exist.

**Q: why shouldn't more job boards be added?**
Nothing stops it — but each candidate board sits at a different risk tier, not a free win like adding another Greenhouse company:
- LinkedIn — ToS explicitly forbids scraping, has litigated against scrapers (hiQ v. LinkedIn). High legal risk, no public jobs API for individuals.
- Indeed — public jobs API discontinued years ago. Scraping-only, fragile.
- Naukri/Foundit/Instahyre — no real public API (confirmed earlier research pass), scraping/login-wall only.
- Bespoke company career pages (non-ATS) — one-off scraper per company, not reusable.

**Q: does scraping more sources hurt or help evaluation quality?**
Both, depending on execution. More sources = better recall (more raw shots at a good match). But raw scraped listings tend to be messier (incomplete requirements, stale/duplicate postings, inconsistent formatting) — feeding that straight into `oferta.md` risks worse scoring, since a badly-parsed JD gives the evaluator less to ground itself in (works against the "never fabricate" design). Fix: normalize any new source into the SAME clean shape the ATS path already produces (title, company, full JD text, requirements) before it hits evaluation. Done that way, more sources is a real net positive, not a quality risk.

**Q: can this genuinely be built into the existing web app/codebase?**
Yes — `lib/explore.ts` is architecturally the intended seam for discovery beyond the hand-maintained company list; extending it with new source adapters (scraper, headless-browser session via the already-installed Playwright MCP, or a paid-API integration where one exists) fits the existing pattern rather than bolting something foreign on. The assistant already does ad-hoc internet fetches for its "research" action, so pulling from arbitrary web sources isn't new territory for this codebase.

### Open — still narrowing down
- Next: which specific new sources/boards to prioritize, and what the normalization contract should look like concretely. Aditya's ideas pending.

---

## 2. Job Sources — deep research (senior/veteran search strategy + broader source landscape)

Context for this section: this isn't just for Aditya — he's building/extending career-ops for his father too (22 years professional experience, unemployed 1.5 years). That's a materially different search problem than early/mid-career job hunting, so it's treated separately below.

### A. How does a 22-year veteran with an 18-month gap actually find a job?

**The hidden job market is real, not an urban legend — but the exact number is soft.** Multiple independent 2025-2026 sources converge on the same order of magnitude: a cited 2025 LinkedIn workforce report puts 85% of jobs filled through networking; referral-based hiring converts at ~43% vs. ~6% average across job boards; 54% of a 2025 US worker survey said they were hired through a personal connection. The specific percentage varies 60-85% depending on source and most of the citing sites are career-content/resume-service blogs rather than primary research — so treat the exact figure as soft, but the directional claim ("most senior roles are filled off-market, before or without ever being publicly posted") as well-supported across independent sources, not folklore.

**ATS bias against senior/overqualified candidates is real and documented, not paranoia.** Over 90% of employers filter by ATS criteria (skills/credentials/years) before human review; systems can specifically flag a candidate as "overqualified" when seniority exceeds the posting's level, screening them out pre-human-review. Practical countermeasure found in current guidance: trim to ~2 pages, lead bullets with outcomes not duties, avoid over-signaling total tenure where it triggers overqualification filters.

**Executive search — real mechanics, and an important nuance for an unemployed candidate:** Retained search firms (30-33% fee, paid BY THE EMPLOYER, 60-90 day timelines) are typically hired by companies to proactively headhunt *already-employed, passive* candidates — they're structurally harder for an actively-job-hunting unemployed person to "engage" in the way you'd engage a service, since the firm's client is the employer, not the candidate. Contingency firms/staffing agencies (20-30% fee, faster, ALSO employer-paid) are the more realistic engagement path for someone actively applying. **Important flag: legitimate recruiters and search firms never charge the candidate a fee** — this matters specifically because a vulnerable long-term-unemployed senior candidate is exactly the profile predatory "pay us to place you" resume-mill services target. Worth stating this explicitly to Aditya's father as a filter.

**Outplacement services** are real and effective (executive programs recommend 9-12 months of support, cite landing in half the average time) — but the standard delivery model is an **employer-paid severance benefit given at the time of departure**, not something typically purchased fresh 18 months into unemployment. If his father's employer didn't provide it at exit, direct-to-consumer executive coaching is a separate (paid-by-candidate) category worth being cautious about, not the same thing as outplacement proper.

**Informational interviews are a real, structured tactic**, not just "network more": brief, specific outreach (why this person specifically, what you want to learn — never an attached resume or an immediate job ask), explicit information-not-job framing during the conversation, and a follow-up thank-you. This is the concrete mechanic behind accessing the hidden job market described above.

**Executive-specific job boards**: general boards (LinkedIn/Indeed/Glassdoor) all have senior-role filters; FT.com's exec-appointments.com is a real dedicated senior-executive board. Search did not turn up a clearly-dominant India-specific senior-executive-only board (IIM Jobs exists and skews MBA/mid-senior, but wasn't strongly confirmed as senior-specific in this pass) — this needs a direct follow-up look, not confirmed either way.

### B/C. Source landscape + automation risk, combined (risk classification per source)

**Tier 1 — legitimate public API, safe to automate:**
- Greenhouse/Ashby/Lever/Workday (already have this).
- Hacker News "Who's Hiring" — genuinely free: RSS (`hnrss.org/whoishiring/jobs`, keyword-filterable) or the free Algolia HN API (deterministic, no auth). Real, low-risk, zero cost. **Caveat: skews startup/tech hiring** — likely low value for a 22-year veteran unless his background is tech-adjacent; high value if it is.

**Tier 2 — structured data harvesting, legally low-risk (public data meant for indexing), but not a single feed to query:**
- **schema.org `JobPosting` markup** — most modern company career pages (regardless of underlying ATS/CMS) embed this JSON-LD specifically so Google for Jobs can index them. This is legitimate, public, meant-to-be-crawled data — a fundamentally different risk profile than scraping a platform's private interface. **Correction to my original hypothesis going in:** there is no single "query Google for Jobs" endpoint — Google deprecated their Jobs API for third-party querying, so this isn't a feed you subscribe to. The real mechanic is: visit an individual company's own career page directly and parse its embedded JobPosting JSON-LD. **The value isn't "one feed," it's a universal parser** — write ONE JobPosting-schema reader, and it works on ANY company's career page that embeds it, regardless of whether that company is on Greenhouse/Ashby/Lever/Workday or something else entirely. This is a genuine way to broaden company coverage beyond the current 4-ATS ceiling without building N platform-specific adapters — but it only works for companies that actually embed the markup (most do, for SEO, but not universal, and smaller/older sites may not).

**Tier 3 — no longer a cheap/free win (correcting initial hypothesis):**
- **Reddit** — as of May 2026, unauthenticated `.json` endpoints return HTTP 403; the free OAuth tier is non-commercial-only with a 2-4 week manual approval wait and 100 req/min cap; the real commercial tier costs $0.24/1,000 calls with a **$12,000/year minimum commitment**. Since career-ops here is personal/non-commercial use, the free tier's *terms* may technically apply, but it now requires manual approval (not the instant, frictionless source I assumed) — flag as usable-but-slower, not the free instant win originally hypothesized.

**Tier 4 — scraping a platform's own interface against its ToS, real risk (not scaremongering, documented):**
- **LinkedIn**: `hiQ Labs v. LinkedIn` is the case everyone cites as "scraping public data is legal" — true as far as it goes (Ninth Circuit found the CFAA, a *hacking* statute, doesn't cover collecting public data), but **the full story is a cautionary tale, not a green light**: the case ended in a **private settlement in Dec 2022** where hiQ agreed to **completely stop scraping, delete all its code/data/models, pay LinkedIn $500,000 in damages, and stipulate that LinkedIn COULD establish liability under the CFAA and its California equivalent.** The company that "won" the precedent lost the actual fight and was destroyed as a business. Since then: LinkedIn has continued unilateral enforcement independent of any lawsuit — in 2025 it removed the LinkedIn Company Pages of Apollo.io and Seamless.ai (established B2B sales-intelligence companies) as part of an active crackdown, and it routinely sends cease-and-desist letters citing breach-of-contract (ToS violation) rather than CFAA, which sidesteps the hiQ precedent entirely. **The CFAA ruling only protects against one specific legal theory; LinkedIn has others (contract law, DMCA/anti-circumvention) that remain fully available and actively used.**
- **Apify** (the specific tool floated): confirmed it hosts many LinkedIn/Indeed scraper "Actors," but Apify's own legal docs are explicit — *"Apify does not decide whether a target or use case is lawful for your organization"* and users are *solely responsible* for ToS/robots.txt/legal compliance; the platform disclaims all liability for ToS violations, CFAA issues, or lawsuits arising from what you scrape. Using Apify doesn't transfer or reduce risk — it's a tool, not a legal shield.
- **Indeed**: public Job Search API and Publisher/XML feed were **both fully retired in 2024**, no individual-accessible replacement. Current APIs (Job Sync, Sponsored Jobs) are partner-only, gated behind a "multi-month sales process" and, for Sponsored Jobs, **active paid ad spend** ($3/call, requires 3 consecutive months of sponsorship spend) — not viable for an individual job seeker's tool at all.
- **Naukri/Foundit/Instahyre/Cutshort/Hirect**: confirmed earlier in this session — no real public API, scraping/login-wall only.

**Tier 5 — requires login/account, highest risk:** any India platform requiring an authenticated session to view listings (same bucket as the existing unproven `apply-agent/tier2/naukri.mjs`).

### D. Concrete proposals for career-ops

1. **schema.org JobPosting universal parser** — write once, works across any company's career page regardless of ATS, genuinely widens coverage beyond the 4-platform ceiling without per-platform adapters. **Size: one adapter, roughly a session** (parser + integration into the `lib/explore.ts` seam + normalization into the same clean shape `oferta.md` already expects). This is the top recommendation — legitimate data, broadest genuine reach, fits the existing architecture.
2. **HN "Who's Hiring" ingestion** via the free Algolia API/RSS — **size: a few hours**, genuinely free and risk-free, but scope it honestly as tech-skewed and likely low-value unless the target candidate (Aditya or his father) is in a tech-adjacent field.
3. **A senior/veteran-specific evaluation mode** — given how much senior hiring is off-market, a mode that shifts philosophy from "does this JD match" toward: (a) flagging companies with visible active senior-hiring signals (leadership changes, funding events, org-chart gaps) as informational-interview targets rather than scored postings, (b) tracking a parallel "relationship pipeline" of people-to-contact alongside the existing scored-job pipeline, (c) explicit overqualification-safe CV formatting guidance. **Size: fundamentally new capability, multi-session** — new data model (contacts, not just jobs), new mode file, likely a new tracker table alongside `applications.md`. Not a quick add.
4. **Do NOT build LinkedIn/Indeed scraping automation.** Not a moral judgment — a factual cost-benefit one: the personal LinkedIn account itself (his father's, or Aditya's) is the highest-value asset for the ONE channel proven to matter most for senior hires (informational interviews, referrals, direct outreach — see section A). LinkedIn has real, demonstrated enforcement (2025 company-page takedowns, active cease-and-desist practice) independent of the narrow CFAA question hiQ settled. Automating scraping on that same account risks the account itself — trading away the highest-yield channel to gain a marginal, replaceable data source (job listings, which are also visible via Tier 1/2 sources above with zero account risk). If any India platform's listings are truly needed, the schema.org route or manual/low-volume checking carries none of this risk.

### Summary verdict
Widening job discovery is worth doing, but the two genuinely low-risk, architecture-fitting wins are the schema.org universal parser and HN ingestion — both real, both buildable now. The senior/veteran angle is less about scraping more job boards and more about building a *different kind of pipeline* (relationships/signals, not just scored postings) — that's the bigger, more valuable, and more honest response to "22 years experience, 18 months unemployed" than trying to out-scrape LinkedIn's bot detection.

---

## 3. Dad's actual remote-role history — what it tells us (discussion, not action)

Confirmed employer sequence, all remote: Akamai → Symantec (now Broadcom) → PrimaryIO (nPrimary.io) → Nuance (now Microsoft).

**Quick facts checked (informational only, no action taken):**
- Broadcom's careers run on Workday — one of the 4 ATS types career-ops already knows how to read.
- Akamai runs on Oracle Cloud HCM/Fusion Recruiting — confirmed via Oracle's own docs that the job-requisition REST endpoints are internal-use-only, not a public feed like Greenhouse's. Different animal from the ATS-API model entirely.
- Microsoft's careers system is likewise a large proprietary in-house platform, not one of the 4.
- nPrimary.io = PrimaryIO, a small hybrid-cloud/disaster-recovery-as-a-service company — too small to read much into as an ATS data point.

**The actual point of this, per Aditya's correction: this is about reading the shape of a career, not about which ATS each past employer happens to run.** The sequence draws a lane: CDN/edge infrastructure (Akamai) → enterprise cybersecurity (Symantec) → hybrid-cloud/DR (PrimaryIO) → speech/conversational AI (Nuance/Microsoft). All infrastructure-adjacent enterprise software, all remote-friendly (or at least were, for him), all large-scale platform companies rather than consumer-facing ones.

**Resolved (2026-07-26):** title doesn't matter, geography doesn't matter (Germany/Europe/USA/anywhere), only comp matters heavily. The real ambition, per Aditya: not "widen India job discovery," but build the equivalent of a tireless human researcher whose sole job is finding senior-level roles for his dad, anywhere in the world, running 24/7. Hypothetical home for config + visibility: the career-ops website (existing `/explore` seam + dashboard), extended — not built yet, purely architectural at this stage.

## 4. "Tireless researcher" architecture — four-layer breakdown (2026-07-26)

**1. Coverage layer — see everything posted, globally, regardless of title.**
Since title is noise, `scan.mjs`'s title-filter can't be the primary gate anymore for this use case — it would wrongly drop a great-comp senior role just because it's titled "Staff Engineer" instead of a matched keyword. Coverage has to cast wide (everything from target-domain companies/sources, any title) and push all narrowing downstream. Real lever: US pay-transparency laws (Colorado, California, New York, Washington, etc.) legally force many postings to disclose a comp range up front — useful structural signal for comp-first filtering.

**2. Judgment layer — comp-weighted scoring, not title-keyword filtering.**
Real tension: `scan.mjs` is deliberately zero-LLM/zero-cost (string matching only). Comp-floor + seniority-from-scope (not from title) + domain-fit (infra/security/platform, inferred from JD body) can't be done with keyword matching — needs content-level reading. Proposed shape (not built): two-stage funnel — stage 1 stays zero-cost (pull everything from target companies/sources, no title filter), stage 2 is a cheap-model classification/scoring pass doing the real judgment before anything reaches full `oferta.md` evaluation.

**3. Off-market layer — most senior roles never get posted at all.**
Un-scoped from India specifically (see section 2 above) — alumni-network outreach (ex-Akamai/Symantec/Nuance networks, legitimate LinkedIn alumni search, not scraping), signal-tracking (funding events, leadership moves) as outreach targets rather than scored postings.

**4. Persistence layer — always-on, never stops.**
Mechanically the easiest piece — `/loop` or `/schedule` skill already gives career-ops a recurring-run primitive. The hard part isn't "run forever," it's whether layers 1-3 produce good results each cycle.

### Comp normalization — resolved direction (2026-07-26)
Since he'll be tax-resident in India regardless of employer country, "effective value" doesn't need multi-country tax modeling — it collapses to one formula: convert gross offered comp to INR at current FX → run through Indian income tax slabs → one comparable annual net-INR number across a Germany, US, or India posting alike. Real wrinkles to keep honest, not yet solved:
- Some postings (esp. German/EU) quote "cost to company," which includes employer-side social contributions the employee never sees — needs to be distinguished from true employee gross, or effective-value would overstate some offers.
- Senior comp often includes bonus/equity/RSUs, not just base — still open how to value/discount these (haircut unvested equity? cash-only ranking?).

### Can-they-hire-in-India — resolved direction (2026-07-26)
Researched two real facts (not guesses):
- **Permanent Establishment (PE) tax risk is the actual legal reason many companies exclude India from remote-eligible countries** — a foreign employer letting someone work remotely from India without a local entity risks Indian tax authorities deeming the employer to have a taxable "business connection"/PE in India. Compounded by India having no digital-nomad-visa framework.
- **This is a solved, mainstream problem via EOR (Employer of Record) providers** — Deel, Remote.com, Multiplier, Papaya Global, Rippling, Oyster all explicitly support India; they become the local legal employer and absorb the PE risk.

Signal framework for scoring "can they hire him in India" (ranked by confidence, not a hard binary — same shape as the comp scorer):
- Strongest: company already has an India entity/office (existing India job postings from same company, India LinkedIn presence).
- Strong: company/careers page explicitly names an EOR partner ("we hire globally via Deel/Remote/Multiplier").
- Direct but rare: the JD itself states an eligible-countries list.
- Majority case: no evidence either way — genuinely ambiguous, can't be cleanly automated to yes/no; needs to feed a weighted confidence score, with truly unclear cases resolved by asking (outreach/apply) rather than inferred.

### Ranking architecture — resolved direction (2026-07-26)
Not four independent scores bolted together. Shape agreed: **domain fit (infra/security/platform-adjacent) acts as a near-gate** — even a perfectly-paid, definitely-hireable-in-India role that's a domain mismatch (e.g. sales) shouldn't surface. Anything clearing that gate gets **one blended rank from comp effective-value × India-hireability-confidence**, not separate scorecards.

### Self-tuning feedback loop — resolved direction (2026-07-26)
Agreed: the system shouldn't rank once with static weights forever — it should learn from real outcomes (interview vs. silent rejection) and adjust. Real precedent already in career-ops, not hypothetical: `analyze-patterns.mjs` already tracks per-ATS-vendor advance rates (motivated by the Algorithmic Monocultures in Hiring paper). Same idea extends here — track outcomes against comp-band / India-hireability-tier / domain-fit-strength, let the blended ranking's weights shift based on what's actually converting for him, rather than staying fixed.

### Equity/bonus valuation — resolved direction (2026-07-26)
Given 18 months unemployed, priority is reliable income now, not speculative upside — so equity should NOT be co-equal with cash in the ranking:
- **Cash (base + guaranteed/target bonus) is the primary effective-value number** — this is what gets converted to net INR and drives the main ranking.
- **Public-company RSUs = secondary, heavily discounted factor** (real, liquid, but volatile — thinking ~40-50% off face value for price/vesting-cliff risk), not counted at face value.
- **Private-company options = informational flag only, not counted in ranking** — illiquid, real chance of going to zero, wrong thing to optimize toward for someone who needs stable income first. This is a values judgment as much as a technical one: optimizing for "get him working and earning reliably again," not "maximize theoretical total comp."

### Resume-grounded domain fit — resolved correction (2026-07-26)
Read Amit Kumar Singh's actual CV (`/Users/adium/Downloads/amit_kumar_singh_cv (1).pdf`, 7 pages, converted via poppler `pdftotext -layout`). Corrects the earlier fuzzy "infra/security/platform" domain definition to something much more specific:

**Real domain: deep, low-level systems engineering, not generic cloud/security.** C/C++ at kernel/UEFI/embedded level, compiler backend work (VLIW-TI, register allocation), drive/endpoint encryption (Symantec Endpoint Encryption — UEFI, TCG Opal V2), DLP plugin development (Symantec DLP), VPN/Zero Trust security software (current-era Akamai role — MAC/Windows/Linux/iOS/Android, UDP/TCP/IP, C/C++, Golang, Swift, Kotlin), speech SDK architecture (Nuance Dragon Medical Speech Kit — Desktop/iOS/Android SDKs), cloud VM-migration caching engines (PrimaryIO — ReadAhead, adaptive cache retention, aerospike NoSQL), embedded/IoT platforms (KOKO Networks IoT+cloud sales-promotion engine at ~1M concurrent users; Azingo Linux/LIMO mobile framework). Narrower, higher-signal target domain: **endpoint security & encryption, embedded/kernel systems, VPN/Zero Trust, SDK-level architecture** — not "cloud infra" broadly.

**Genuinely dual-track: senior IC AND engineering management.** Current title "Lead Principal Software Engineer" (pure IC) at Akamai, but Senior Engineering Manager at KOKO Networks and Engineer Manager II (managed 15 engineers) at Nuance earlier. Real fluidity across the IC/EM boundary — addressable role universe should include Principal/Staff/Distinguished Engineer AND Engineering Manager/Director titles, reinforcing "title doesn't matter."

**Employment gap clarified:** resume lists Akamai as "May 2023 –" with no end date (reads as still-current). Confirmed with Aditya: Akamai actually ended ~18 months ago (~early-mid 2025). Resume is stale on this point — will need the end date added before `cv.md`/outbound material is built from it. Not yet done — noted here as a known fact, not yet applied to any file.

**Pedigree note, worth being deliberate about, not ignoring:** B.E. Computer Science from Mahatma Jyotiba Phule Rohilkhand University (1998-2002) — a regional university, not a pedigree-heavy institution. Positioning should lean on 22 years of hands-on technical depth and delivery track record as the lead signal, not credentials.

### 2026 market-reality check — resolved (2026-07-26)
Researched before going further, since the whole architecture hinges on whether this domain is actually still in demand:
- **Embedded/low-level systems engineering is scarcer than ever, not fading.** Universities stopped emphasizing this ~2015; pipeline of new engineers has been thin since. Demand described as having "extraordinary momentum" (defense, aerospace, industrial automation, automotive, edge-AI). AI reshapes the role (productivity assistant) rather than replacing it — reshaping specifically favors senior engineers (junior hiring down ~25% at Big Tech, focus shifting to experienced people who validate AI-assisted output). 22 years of this depth is becoming MORE valuable, not less.
- **Cybersecurity has a large, real demand-supply gap** — cited 3.4-3.8M global role shortfall, demand +18% YoY vs supply +9% YoY.
- **Nuance/caveat:** hottest cybersecurity specializations right now are cloud security/IAM/DevSecOps/container security — more cloud-native than his classic endpoint/DLP/encryption background. BUT his current Akamai role is literally Zero Trust enterprise access security — one of the most modern, actively-hiring corners of the field. His most recent experience is his most market-aligned experience.
- **Explicitly ruled out: pivoting toward "AI Engineer" framing.** Real pay premium exists for hands-on production AI/ML experience, but his resume shows none beyond a buzzword line — forcing that positioning would misrepresent him. Not the right move.
- **Verdict/decision:** don't reframe toward AI. Build the whole architecture around what's real and market-favored — Zero Trust/enterprise security, endpoint encryption, embedded/kernel systems — leaning hardest on the Zero Trust angle since it's both his most recent role and the most in-demand part of his background.

### Coverage layer — candidate company categories (discussion, not a finalized watchlist) (2026-07-26)
Geography clarified: "Germany/Europe/USA" was illustrative of "anywhere in the world, no regional bias" — not a specific pull toward Germany. Coverage is genuinely global, any relevant company anywhere.

Candidate categories discussed, anchored on the market-validated domain (Zero Trust/enterprise security, endpoint encryption, embedded/kernel systems):
- **Zero Trust / enterprise access security** (direct competitors to his current Akamai work): Zscaler, Palo Alto Networks (Prisma Access), Cloudflare Zero Trust, Netskope, Cisco (Duo), Fortinet, CrowdStrike, Check Point, Ivanti, Citrix, Twingate. Small, well-known vendor set — genuinely tractable as a curated list, not broad scanning.
- **Endpoint encryption / DLP / data protection** (direct lineage from his Symantec work): Broadcom (already covered), McAfee/Trellix, Digital Guardian, Sophos, ESET, Thales (CipherTrust), Forcepoint, Check Point's disk-encryption line.
- **Embedded/kernel/low-level systems, broader than security:** Bosch, Continental, Siemens (automotive/industrial embedded — would need to bridge from security/encryption embedded work, not a direct line), Nokia, Ericsson (telecom infra embedded), Wind River (embedded RTOS specifically), secunet Security Networks (German VPN/Zero-Trust-adjacent government/enterprise security firm, cited as one example of a relevant company anywhere, not a Germany-specific priority).

Estimated to land at ~30-50 real companies once fully built out — small enough that a curated watchlist is clearly the right shape, consistent with the earlier "curated watchlist vs. open scanning" conclusion, now with real names instead of a category label.

### Watchlist freshness — resolved direction (2026-07-26)
Two-cadence model, not one mechanism:
- **High-frequency (persistence layer)** — scan the known/curated watchlist often (daily/every few days), since postings themselves change frequently. Cheap, already the existing `/loop`/`/schedule` primitive.
- **Low-frequency "watchlist refresh" pass** — periodic (e.g. monthly), whose job is finding NEW companies worth adding, not new postings. Legitimate real sources for this: analyst category pages (Gartner Magic Quadrant, G2 category rankings for "Zero Trust Network Access," "Endpoint Protection," etc.) that exist specifically to enumerate every player in a market segment and get refreshed periodically by the analysts themselves — a low-effort, legitimate way to catch new entrants without inventing a discovery mechanism. Funding-round news (new well-funded cybersecurity startups) is another natural signal, since newly-funded companies are often about to hire senior people.
- **Self-driven growth, secondary:** if the judgment layer reads JD content for domain fit (not just pre-approved companies), a posting that scores well on domain fit from a company NOT yet on the watchlist is itself a signal to add that company — watchlist growth partly driven by the scoring system's own findings, not purely separate research.

### Off-market/outreach layer — resolved direction (2026-07-26)
Two lanes, not just alumni:

**Lane 1 — alumni (warm, shared history).** Pool is broader than the 5 headline employers: Akamai, Broadcom/Symantec, Microsoft/Nuance, PrimaryIO, KOKO Networks, Innominds, Azingo, Aztecsoft, Computer Associates, Synergy Infotech — 22 years of colleagues, many since scattered into companies possibly already on the Zero-Trust/endpoint-security watchlist. Mechanism confirmed legitimate and free: LinkedIn's native People-search "Past company" filter (no premium needed) — not scraping, exactly what the platform is built for. Opener: reconnection first ("been a while since Symantec days, would love to hear what you're working on"), not an immediate job ask — consistent with the informational-interview research from section 2.

**Lane 2 — cold-but-targeted (no shared history).** Aditya's explicit addition: outreach shouldn't be limited to existing connections — also reach genuinely new people at watchlist companies. Same LinkedIn mechanism, different filter: "Current company" = target watchlist company, narrowed by relevant title keywords (Zero Trust, security engineering, endpoint protection) or recruiter/Talent-Acquisition titles. Opener has to be genuine-interest-based since there's no shared history to lean on ("saw you lead the Zero Trust team at X, I've spent 22 years in exactly this space...").

**Shared rules across both lanes:**
- Same prioritization logic as the jobs side, re-pointed at people: highest value = people at watchlist companies, people who are themselves senior/hiring-manager level, or recruiters/TA.
- Volume discipline is critical, especially for cold lane — a handful of personalized reach-outs a week, never bulk/automated (that's exactly the behavior that gets accounts flagged and reads as spam).
- Draft-only, matching career-ops' existing pattern (`contacto`/`email` modes are already draft-only — write the message, human sends it). Whatever this becomes, never auto-send.
- Needs its own relationships-tracking structure parallel to the jobs pipeline (who contacted, when, response, next follow-up) — same shape as the existing `followup-cadence.mjs`/`data/follow-ups.md`, just for people. Not yet built.

### Company stability / layoff-risk signal — resolved direction (2026-07-26)
New weighted signal added to the judgment layer, alongside comp effective-value and India-hireability-confidence — same blended-rank shape, not a separate gate.

**Concrete, legitimate sources (not hypothetical):**
- **layoffs.fyi** — well-known, crowd-sourced, publicly maintained tracker built specifically to log tech-industry layoffs by company and date.
- **LinkedIn company-page employee-count trend over time** — catches slow headcount bleed, distinct from headline layoff announcements.
- **Funding recency, reused from the off-market layer** — a recent raise is both a hiring-likelihood signal AND a stability signal; a stale last-round with no news since is a soft warning (runway concern), not a hard disqualifier by itself.
- **Public companies:** 10-K/10-Q "restructuring"/"cost reduction" language, stock performance, earnings-call headcount mentions — real, disclosed information.

**Weighting decision: soft down-rank, not a hard exclude.** Explicitly discussed and confirmed — a stable company can still run a strategic layoff in one org while hiring in another, so a hard exclude would wrongly kill good leads. Layoff-risk lowers a company's rank within the blended score; it doesn't disqualify outright.

**Continuity note:** career-ops already has an `interview-redflag` mode doing company-health/red-flag analysis, currently scoped to run post-offer (pre-joining check). This would reuse the same instinct and likely overlapping signal sources, just earlier — at discovery/ranking time instead of only after an offer. (Not yet verified against the actual mode file in this session — worth confirming exact scope before any build.)

### Feedback-loop data source — resolved direction (2026-07-26)
Splits into two honest halves:

**Job-side outcomes — reuses the existing tracker, no new mechanism needed.** `data/applications.md` already records status transitions (Evaluated → Applied → Responded → Interview → Offer → Rejected → Discarded) via the canonical `set-status.mjs` path — already normal, established usage. If this new architecture's findings flow into that same tracker as pipeline entries, outcome data accumulates automatically as part of ordinary use. Only new requirement: tag each entry at evaluation time with the new signal metadata (comp-band, India-hireability-confidence tier, company-stability tier) so a periodic analysis pass can correlate outcome against those dimensions — same idea `analyze-patterns.mjs` already applies to per-ATS-vendor advance rates, just extended to more tags.

**Relationship-side outcomes (alumni/cold outreach) — an honest manual gap, not a design flaw.** No mechanism can observe a LinkedIn DM thread or know a call happened unless told. Needs the relationships-tracker already flagged (parallel to `data/follow-ups.md`), filled in by an actual person as it happens. The one place a "tireless researcher" still needs a human to report back — not a missing piece of architecture, that data genuinely doesn't exist anywhere else.

### Open — still narrowing down
- Full build-out of the curated watchlist (more categories/companies beyond the candidates listed above) — not yet exhaustive.
- Separate, not-yet-started task (outside this brainstorm): updating the real `cv.md`/profile with the corrected Akamai end date once this session moves past brainstorming.
- Everything above is still architecture/direction only — no build has started, per explicit instruction to stay in brainstorm mode until told otherwise.

---

## 5. Build log — 2026-07-27/28 (brainstorm exited, real builds shipped)

Real git history is the actual source of truth for what changed (`git log`); this is a summary index, not a replacement for it.

**Consolidation (`4c97b97`):** wiped Aditya's own personal data (archived to `data/archive/2026-07-28-reset/`, not deleted) and promoted Amit's data into the primary `cv.md`/`config/profile.yml`/`portals.yml` slots — one workspace, no isolation layer needed anymore. `senior-search/` deleted; `compute-stability.mjs` moved to `signal-agent/`, `compute-fit.mjs` moved to repo root.

**Domain-fit pipeline triage (`6f31725`):** new `filter-inbox-by-fit.mjs`, runs after every scan, moves title/location-irrelevant postings out of `data/pipeline.md` into `data/pipeline-filtered.md` (gitignored, both are personal data). Title-length-calibrated threshold (`TITLE_FIT_MIN_SCORE = 1`), separate from the full-JD gate.

**Scoring wired into real evaluations (`c2d208a`):** `compute-fit.mjs --score` CLI, four new additive Machine Summary fields (`domain_fit_score`, `comp_effective_value_inr`, `india_hireability_confidence`, `fit_rank`) documented in `batch/batch-prompt.md`'s schema (source of truth for both `oferta.md` and batch workers), registered in `analyze-patterns.mjs`'s allowlist. Verified against a real evaluation (`reports/001-broadcom-2026-07-27.md`).

**Domain-keyword broadening (`346fa18`):** the real Broadcom evaluation exposed `scoreDomainFit()`'s original keyword list as too narrow (scored a genuinely relevant role 12/20). Rebuilt into 3 tiers grounded in `cv.md`'s actual breadth, not just the 3 specializations named early in the brainstorm. Real Broadcom JD: 12 → 48.

**Watchlist expansion, 8 → 13 confirmed companies (`ee41bff` + local `portals.yml`, gitignored):** verified real ATS/ direct APIs for Zscaler, CrowdStrike, Trellix, Thales, Forcepoint, Twingate, Cloudflare, Netskope, Ivanti, Sophos, Palo Alto Networks, Continental, Digital Guardian (Broadcom already had one). Added listing-discovery mode to `providers/jsonld-jobposting.mjs` (`job_link_pattern` field) to fix a real gap: some sites (Continental) only carry schema.org markup on individual job pages, not the listing page. Real lesson worth remembering: check the actual JSON API before assuming a JS-shell marketing page means "unscannable" — Digital Guardian's Workday tenant worked fine even though its human-facing page was a dead end (same insight that unblocked Netskope's Greenhouse board).

**Still unconfirmed / genuinely blocked, not force-fit:** Check Point (confirmed custom CMS, no schema.org), Siemens (confirmed custom, no schema.org, no unified tenant), Citrix (right tenant/slug, API still 422s — deeper block, not a config gap), Bosch (JS-shell, no real links to crawl).

**Current live state:** 13 companies scanning, 142 postings in the active pipeline after domain-fit triage.

### Next steps, in agreed priority order (2026-07-28)
1. ~~Make scoring visible in the UI~~ — **done, see §6 below.**
2. **Widen the watchlist further** *(up next)* — the two-cadence refresh idea (periodic Gartner/G2 category pages + funding news) to find new companies beyond the ~14 hand-picked ones, instead of manually researching one at a time.
3. **Automate the cadence** — wire `scan.mjs` + `filter-inbox-by-fit.mjs` (+ now `score-inbox.mjs`) into `/loop`/`/schedule` now that the ranked view (step 1) makes the output worth checking regularly.
4. **Outreach/relationships** — still deliberately parked per `relationship-pipeline-critique.md`'s own reasoning; only build if a spreadsheet proves to be the real bottleneck after actual use.

---

## 6. Build log, continued — 2026-07-28 (scoring visibility pass)

### Problem → decision → why (flow, not just outcome)

**Problem:** `compute-fit.mjs`'s signals only existed attached to a full evaluation report's Machine Summary. Only 1 of 142 pending postings had ever been evaluated — the Inbox tab had nothing to sort by except freshness.

**Decision 1 — don't reuse `blendRank()` for inbox-time ranking.** `blendRank()` requires a real comp figure to mean anything; raw scanned postings essentially never carry one (confirmed: 0/142). Building a *separate*, simpler `computeInboxRank()` (domain-fit + company-stability only) kept the evaluation-time ranking logic (used once a real report exists) completely untouched, rather than forcing `blendRank()` to handle a case it wasn't designed for.

**Decision 2 — no re-gating inside `computeInboxRank()`.** First draft reused `DOMAIN_FIT_GATE_THRESHOLD` (20, calibrated for full JD text) as a gate here too — caught in review before shipping: `filter-inbox-by-fit.mjs` already gates entries into `pipeline.md` at a much lower, title-calibrated bar (`TITLE_FIT_MIN_SCORE = 1`). Re-gating at 20 would have wrongly nulled out almost every already-correctly-included entry — the exact shape of bug the original Broadcom domain-fit miscalibration was. Fixed by removing the gate entirely: this function only ranks what already passed the real gate upstream.

**Decision 3 — new store, not a new `pipeline.md` column.** Considered appending a 6th pipe-delimited field to each inbox line for the score. Rejected: `scan.mjs`'s `loadSeenUrls()` and other scripts already parse that line format; a positional change risks silent breakage elsewhere. Instead followed the established `readScanDates()` → `pipelineSummary()` join pattern (same technique already used for `postedAt`) — a separate URL-keyed JSON store (`data/posting-signals.json`), read and joined in-memory, `pipeline.md` itself untouched.

**Real bug found and fixed along the way, not part of the original plan:** `readInbox()` was mis-assigning `scan.mjs`'s trailing `"posted: YYYY-MM-DD"` label as `compensation` for 111 of 142 real rows (confirmed never consumed anywhere in the web app — silent, harmless-so-far, but real corruption). Fixed while touching this exact function.

### What shipped (`bdabcda`)
- `compute-fit.mjs`: `computeInboxRank({domainFit, heat, layoffRisk})`, self-tested.
- `score-inbox.mjs` (new): runs after `filter-inbox-by-fit.mjs`, scores all pending entries, writes `data/posting-signals.json` (gitignored).
- `web/src/lib/career-ops.ts`: `readPostingSignals()`, `InboxJob.fitRank`, the compensation-parsing fix.
- `InboxTriage.tsx`: sort comparator now fit-rank-primary, freshness-secondary (was freshness-only) — using the file's own documented single extension point.
- `TriageRow.tsx`: `fit N` badge replaces "not scored" once a posting has a rank.

**Verified live, by Aditya in a real browser, not just automated checks:** confirmed working on `/pipeline`.

---

## 7. Watchlist widening, first pass — 2026-07-28

**Method used:** the two-cadence refresh idea from §4 — G2 category pages (Zero Trust Networking, Endpoint Protection Platforms, DLP) + recent (2026) cybersecurity funding news, rather than more hand-picked names from memory.

**Honest result: 1 of 8 candidates confirmed and added.** **Proofpoint** (DLP, direct Symantec DLP lineage overlap) — Workday, 168 real postings verified live via the API, added to `portals.yml`, 15 companies now scanning.

**7 candidates found but not addable yet** (ThreatLocker, Cynet, Safetica, Varonis, Elisity, Zero Networks, Cyolo) — real, domain-relevant companies, but ATS unconfirmed within the research budget spent. Worth a future verification pass, same as the original 12-unconfirmed-companies pass.

**Real limitation surfaced, worth remembering before trying this method again:** WebSearch against G2's category pages returned summarized/aggregated text, not the actual rendered vendor list — the "8-12 companies per category" target wasn't really met, since the underlying pages are the same kind of JS-heavy listing that direct fetches struggle with elsewhere in this project. A future pass should try fetching G2 category pages directly (WebFetch/curl) rather than relying on WebSearch's summarization, or accept a lower per-pass yield as the norm for this method.

**Live pipeline state after this pass:** 15 companies scanning, 153 relevant postings in the ranked pipeline (up from 142).

**PARKED, explicitly not forgotten (2026-07-28) — resume after the orchestrator (§8) is scoped/built:**
- G2 WebFetch retry hit a 403 (G2 blocks direct fetch) — needs a different access method, not just swapping WebSearch for WebFetch.
- 7 unverified watchlist candidates from the widening pass: ThreatLocker, Cynet, Safetica, Varonis, Elisity, Zero Networks, Cyolo.
- Original priority-3 item: automate the scan cadence (`/loop`/`/schedule`).
- Original priority-4 item: outreach/relationships (still parked per the critique doc's own trigger condition).

---

## 8. Orchestrator agent — scoped and first piece shipped (2026-07-28)

**New standing requirement (see also the persistent project memory `project_careerops_orchestrator_vision.md`):** the dashboard needs a real embedded orchestrator agent (LLM-with-tools, WebSearch/WebFetch-equivalent) so Amit can run everything from the web app himself — no live Claude Code session required. Everything built earlier this session (ATS verification, G2 research) had depended on Claude driving research interactively; that was a real gap against this target, not a finished feature.

**Key discovery during scoping: most of this already existed.** `web/src/app/api/run/route.ts` already spawns `claude -p` with `WebFetch`/`WebSearch`/`Write`/`Edit`/`Bash` allowed for its `evaluate`/`fix-portal`/`pdf` kinds — real, live, headless research + file-editing triggered by a plain HTTP request, not something requiring me interactively. `fix-portal` was the near-exact precedent (verify + edit `portals.yml`, just scoped narrower — Greenhouse/Ashby/Lever only, fixing a known-broken slug, not discovering new companies or covering Workday/schema.org).

**OmniRoute integration confirmed working live** (tested directly, not theorized): `CLAUDE_CONFIG_DIR=~/.claude/profiles/<profile> ANTHROPIC_AUTH_TOKEN=<any value> claude -p "..."` genuinely routes a non-interactive call through OmniRoute's local server — any non-empty token was accepted, no strict validation. Means the existing spawn-based architecture can get Claude-Pro-primary/DeepSeek-fallback for free via two env vars, zero new tool-calling code. **Wiring deferred at Aditya's explicit request** ("that was a question, don't need to wire it in now") — do this later, not forgotten.

**Shipped and verified for real (`df390dc`):** new `kind: "widen-watchlist"` in `run/route.ts`, reusing `fix-portal`'s exact plumbing, extended to check Workday (which `verify-portals.mjs` misses) and schema.org markup as a fallback, plus true new-company discovery mode (empty input). New "Widen watchlist" button on `/portals`.

**Real end-to-end test, not simulated:** triggered via a plain `curl` POST to `/api/run` (no Claude Code session driving it) against ThreatLocker. The agent independently: checked Greenhouse's API directly, confirmed 33 live postings, read `portals.yml`'s format, and edited it correctly — verdict: `1/5 — ThreatLocker (confirmed Greenhouse)`. Independently re-verified afterward: entry format correct, 33 live jobs confirmed via the real provider. **This is the first concrete instance of "Amit-shaped" capability — a task getting done through the app itself, not through me.**

**Explicitly still unsolved, not glossed over:** this only runs wherever the Next.js server process is actually running (Aditya's machine, `npm run dev`). Real hosting/deployment so the app works independent of Aditya's laptop being on is a separate, larger, unscoped initiative.

**Live pipeline state after this pass:** 16 companies scanning (was 15, +ThreatLocker), 159 relevant postings.

**Full UI verification, not just curl (2026-07-28, `acb1a1d`):** Aditya clicked "Widen watchlist" directly on `/portals` (empty input → discovery mode) — first real test of the button itself, not the API route. It streamed to a `/jobs/{id}` page as expected and completed in 5 turns, $0.82, 62.9k tokens. Result: 5 new companies found and verified, all real, all domain-relevant, zero broken/guessed entries — Illumio (Ashby, 62 live), Cato Networks (Greenhouse, 129 live), Okta (Greenhouse, 362 live), Menlo Security (Ashby, 19 live), Tanium (Greenhouse, 43 live). Watchlist now 21 companies, 21 live, 0 broken. **This confirms the orchestrator-agent capability end-to-end through the actual dashboard UI, not just the backend** — the "Amit clicks a button" requirement is now demonstrated, not just architecturally plausible.

Notably, discovery mode surfaced better/different candidates than the earlier hand-run G2 pass did (Okta, Cato Networks, Illumio weren't on the original 7-candidate G2 list at all) — the agent's own research method found real, strong matches the manual approach missed. The 7-candidate G2 list (ThreatLocker resolved; Cynet, Safetica, Varonis, Elisity, Zero Networks, Cyolo still unconfirmed) remains parked, but is now lower-priority — running "Widen watchlist" again is likely more productive than manually chasing that specific list.

**Re-run #2, same session (2026-07-28, `e74c46f`):** ran discovery mode again via curl — +3 companies: Tailscale (Greenhouse), Teleport (Ashby), Xage Security (Lever), all confirmed live, all ZTNA/microsegmentation. Honestly rejected StrongDM, NordLayer/Nord Security, Beyond Identity, Elisity (no live postings/unresolvable ATS). Watchlist → 24.

## 9. Automation — daily scan cron + weekly widen-watchlist cron (2026-07-28)

**Scope, per Aditya's direct instruction ("daily re-scan cron, plus rerun widen-watchlist weekly"):** two unattended jobs on his own Mac via **launchd** (chosen over crontab — launchd catches up on missed runs after sleep/wake, crontab silently skips them; relevant since this only runs while the laptop is awake, no hosting yet).

**Schedule (confirmed with Aditya via AskUserQuestion before installing):**
- Daily scan: midnight (`com.careerops.dailyscan.plist`) — `scan.mjs` → `filter-inbox-by-fit.mjs` → `score-inbox.mjs`. Zero LLM cost (deterministic scripts only), so safe to run unattended with no cost risk.
- Weekly widen-watchlist: Monday 9:00 AM (`com.careerops.weeklywiden.plist`) — real `claude -p` call, real cost (~$1–1.30/run based on the 3 manual runs today), real WebSearch/WebFetch/Write/Edit tool use.

**New files:**
- `scripts/cron-daily-scan.sh` — thin wrapper, logs to `.claude/notes/cron-logs/daily-scan-{date}.log` (gitignored, runtime-generated).
- `scripts/cron-weekly-widen.sh` — calls `claude -p` **directly**, independent of the Next.js dev server, so the weekly job doesn't silently no-op if `npm run dev` isn't running. Deliberately duplicates `web/src/app/api/run/route.ts`'s `buildPrompt(kind==="widen-watchlist", input="")` prompt text and exact tool-scope (`Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep` / disallow `Task,NotebookEdit`) verbatim — commented at the top of the script that it must be kept in sync if that branch ever changes. Detects whether `portals.yml` actually changed (hash before/after) before snapshotting+committing, so a "nothing confirmed" run doesn't create an empty commit.
- **Auto-commit + auto-push confirmed explicitly with Aditya before enabling** (AskUserQuestion) — the weekly script snapshots `portals.yml` and pushes to `origin/main` unattended if it changes anything, matching the manual checkpoint habit used all session. Daily scan never touches git (read-only pipeline data, already gitignored).
- Both `~/Library/LaunchAgents/com.careerops.*.plist` loaded via `launchctl load` and confirmed present via `launchctl list | grep careerops`.

**Both scripts smoke-tested manually before being trusted to the schedule, not just assumed correct from the plist:**
- Daily scan: ran clean, 190 pending entries scored, exit 0.
- Weekly widen: ran clean standalone (no dev server running) — found+added 5 more companies (NetBird, Cyberhaven, Nightfall AI, Sentra, BigID), correctly rejected two false-domain-fits mid-run (Abnormal Security = email security, a "concentric" Greenhouse slug = physical executive protection, neither this domain), auto-committed and auto-pushed as designed (`6091470`). This was the 3rd widen-watchlist run today — cumulative: 8 companies from the UI/curl runs earlier + 5 more from this standalone test = **watchlist now 30 companies**.

**Not yet solved, consistent with the standing note:** still laptop-dependent (launchd doesn't help if the Mac is fully off, only asleep). Real hosting remains the separate unscoped initiative.

**Real force-triggered verification, not trusted from the manual bash test (`453e8f0`, `0bcc482`):** Aditya asked "so i dont need to manual test this right??" — correct instinct to check, because running the scripts manually via `bash` is NOT the same as launchd actually firing them (launchd's default PATH excludes Homebrew, no ssh-agent/keychain access by default). Force-triggered both jobs via `launchctl kickstart -k gui/$(id -u)/<label>` (the real unattended path) instead of assuming. This caught a real bug: claude's own SessionEnd hook failed with `node: command not found` under launchd's stripped PATH — didn't corrupt anything (git commit still succeeded) but was a genuine gap. Fixed by exporting `PATH="/opt/homebrew/bin:$PATH"` at the top of both scripts, then re-triggered via launchd AGAIN to confirm the fix under the same real conditions (clean, no errors, second confirmed run). While verifying, the scheduled jobs kept running for real and added 10 more companies (JumpCloud, Delinea, BeyondTrust, Britive, Vectra AI, Saviynt, SGNL, Material Security, Nudge Security, Axonius) — **watchlist now 40 enabled companies** (16 → 40 in one session).

## 10. Relationship pipeline — built despite the critique's recommendation (2026-07-28)

**Explicit user override, not a reversal I initiated:** `.claude/notes/relationship-pipeline-critique.md` (§5) recommended NOT building bespoke relationship/outreach software yet — its trigger condition (4+ weeks of real spreadsheet-based outreach hitting a genuine tool limit) hadn't fired. I surfaced that critique directly when Aditya asked "what was priority 4 again." He responded: "no i want to build the relaton shop pipeline" — a clear, informed decision to override, not a case of the critique never being seen. Recorded here for honesty/revert-safety, not as a disagreement to relitigate.

**Scope, per two AskUserQuestion confirmations before building:** (1) both person/contact tracking AND turning on `signal-agent`'s existing company-heat scoring (not person-tracking alone), (2) a real dashboard page, not a CLI-only data file (consistent with the standing orchestrator-agent goal — Amit shouldn't need a live session to use this either).

**Built, matching existing architectural conventions exactly rather than inventing new patterns:**
- `relationships.mjs` — pure on-demand recompute function, same shape as `followup-cadence.mjs` (explicitly the shape the critique's §2 said would be "nearly free architecturally" if built this way, vs. new scheduled infrastructure). `data/relationships.md` markdown table (`# | Name | Role | Company | LastContact | NextAction | Status | Notes`), gitignored (real names, PII). CLI: `--add`, `--touch`, `--json`, `--summary`. Self-test suite (8 cases) covers parse/serialize round-trip, overdue computation, `nextNum` (max+1, not length+1, per the #749 race lesson elsewhere in this codebase), and company-heat lookup returning `null` gracefully when unscored.
- `signal-agent` turned ON for real, not just wired: new `kind: "compute-heat"` in `web/src/app/api/run/route.ts`, following `signal-agent/SKILL.md`'s real workflow verbatim (WebSearch funding/Reddit/LinkedIn, GitHub API via `compute-heat.mjs --github-org`, never writes `company-signals.json` directly). Tested live end-to-end against a real company (Broadcom): WebSearch found real signals (VMware-layoff chatter, a new OpenAI accelerator partnership, no new funding round), GitHub org activity scored 100 (156 repos, very active), composite heat **74**, correctly persisted to `data/company-signals.json`. Cost: $0.38, 36.6k tokens for one company.
- `web/src/app/api/relationships/route.ts` — same shape as the existing `/api/followups` route (shell out to the core script, read its JSON, never reimplement tracking logic in TypeScript).
- New `/relationships` dashboard page + `RelationshipsView` component — add-contact form, per-contact company-heat badge (🔥, live-joined from `data/company-signals.json`), overdue highlighting, "Contacted today" touch button, "Refresh company signals" button reusing the exact `useJobs()`/`startJob` pattern the Portals page's "Widen watchlist" button already established. Added to `nav-items.ts` (single source of truth for desktop+mobile nav).

**Verified for real, not just type-checked:** `tsc --noEmit` clean, then full round-trip through the ACTUAL running dev server — `curl` against `/api/relationships` (add + list), `curl` against `/api/run` with `kind:"compute-heat"` (real WebSearch+Bash agent run, real persisted score), then a full browser click-through via claude-in-chrome (navigate to `/relationships`, click "Add contact," fill the form, submit, confirm the row renders WITH the correct 🔥74 heat badge joined live, click "Contacted today," checked console for JS errors — none). Test contact removed after verification; the real Broadcom heat score (74) was left in place since it's genuine, not fabricated data.

**Consistent with `AGENTS.md`'s Data Contract:** `relationships.mjs` documented in the Main Files table as a System Layer file; `data/relationships.md` documented as User Layer (gitignored, PII).

## 11. contacto turned on — actual person-finding + draft outreach (2026-07-28)

**Real gap Aditya caught immediately:** after §10 shipped, he asked "so the refresh company signals finds actual referals?" — correctly noticing that `compute-heat` is company-level only (funding/GitHub/Reddit/LinkedIn *chatter*), not person-level. He then stated the actual point plainly: "no i want a center that finds these people, and the also drafgts message them." This is a distinct, pre-existing mode (`modes/contacto.md` — "LinkedIn power move": WebSearch for hiring manager/recruiter/peers/interviewer tied to a specific application, classify, draft a ≤300-char message per persona) that, like `signal-agent`, existed in the repo and had never been wired into the dashboard.

**Hard boundary stated up front, not negotiated:** drafting only, never auto-sending — this isn't a scope choice, it's this app's own standing safety rule (sending a message on the user's behalf requires explicit per-action confirmation in chat; nothing here can bypass that). `modes/contacto.md` was already designed this way independently.

**Scoped via two AskUserQuestion confirmations:** (1) trigger surface = a "Find contacts" button on each evaluation report page (report already carries the company/role/JD context contacto needs — the alternative, a free-text company/role box on `/relationships`, was rejected as worse since it'd require re-typing what a report already has), (2) found contacts auto-add to the relationship tracker with the drafted message saved in Notes (closes the loop with §10's build rather than being a disconnected research tool).

**Built:**
- New `kind: "contacto"` in `run/route.ts` — deliberately does NOT duplicate `modes/contacto.md`'s persona-engine text inline (unlike the widen-watchlist/compute-heat cron scripts, which DO duplicate `run/route.ts`'s prompts for standalone operation) — instead instructs the agent to read and follow the real mode file directly, same pattern `evaluate` already uses for `modes/oferta.md`. Lower drift risk than duplicating persona-engine prose that's more likely to be hand-edited later.
- `FindContactsButton` component (mirrors `GeneratePdfButton`'s exact running/done/idle shape), wired into `report-view.tsx` next to the existing PDF/Apply buttons.
- The prompt's step 4 requires the agent to persist each found contact via `node relationships.mjs --add` (never edit `data/relationships.md` directly) — same discipline as `compute-heat` never writing `company-signals.json` directly.

**Real end-to-end test against report #001 (Broadcom, Staff Security Engineer, Cork) — genuinely good result, not a rubber-stamp:**
- Found 2 real people via WebSearch: Egan Meek (Peer, Principal Security Engineer/Offensive Security, ex-VMware) and Rachel Pullman (Recruiter, Technical Recruiter) — both drafted messages fit the 300-char budget, correctly persona-differentiated (peer message references his actual career move + asks a genuine technical question, no job ask; recruiter message leads with hard-requirements fit + explicit CTA).
- **Correctly SKIPPED a third candidate** (a plausible hiring-manager name) because further research showed his current employer was First Advantage, not Broadcom — used stale info as a reason NOT to include a contact rather than including it anyway. This is the same "honest zero, not a guess" discipline `signal-agent`/`widen-watchlist` already demonstrated elsewhere.
- Correctly flagged uncertainty in Rachel Pullman's notes (her LinkedIn profile reads US/semiconductor-focused, not confirmed as the actual EMEA/security-req owner) rather than presenting it as settled.
- Confirmed persisted correctly in `data/relationships.md` AND joined correctly with the real Broadcom heat score (74) from §10's test in the `/api/relationships` response.
- Cost: $1.08, 77.6k tokens, 14 WebSearch calls.
- Button verified rendering correctly on the actual report page (`/pipeline/001`) via a real browser screenshot; not re-triggered through the UI a second time (the click→job-store→API wiring is identical, already-proven code to the PDF/Widen-watchlist buttons — re-running would just spend another ~$1 to prove the same plumbing twice).
- **Test output kept, not cleared** — confirmed explicitly with Aditya (AskUserQuestion): these are real, honestly-verified contacts with usable drafts, not throwaway smoke-test data.

**Aditya also tested it live himself, independently** — a second real run against report #001 (separate from my test) found 3 MORE real people, including an actual Hiring Manager (Ken Williams, PSIRT Lead) my run hadn't found. Good real-world signal that repeat runs surface genuinely different people, not duplicates.

## 12. Real data-loss bug, caused and fixed same session (2026-07-28)

**What happened:** Aditya asked "where is their contact info??" — a legitimate gap: the 5 real people found by contacto had names/roles/drafts but no LinkedIn URL/email, so there was no actual way to reach them. Fixing this required adding a `Contact` column to `relationships.mjs`'s schema. The parser was changed to require the NEW minimum cell count (8) — but the live `data/relationships.md` on disk still held rows in the OLD (7-cell) shape, written before this session's edit. The stricter parser silently dropped every old row as unparseable (`cells.length < 8 → continue`), so `load()` returned an empty array. The very next `--add` call (a plumbing smoke test) then `serialize()`'d that near-empty row set back to disk — **destroying all 5 real contacts**, 3 of which (Kent Button, Ken Williams, Yashdeep Saini — the second batch Aditya's own live click had found) existed in NO snapshot anywhere and are **permanently unrecoverable**. Egan Meek and Rachel Pullman were recovered from the `.claude/notes/config-snapshots/relationships-2026-07-28.md` snapshot taken earlier that morning (10:27), before the loss.

**Root cause, stated plainly:** a schema change to a live gitignored data file, verified only against fresh-CLI-created test data, never against the actual production file already on disk. The "parse then serialize the full set back" pattern (shared by every `--add`/`--touch` call) turns any silent parse failure into a silent delete — this is the same shape of danger `atomicWrite`/`backup()` in `web/src/lib/core/safe-write.ts` were built to guard against for the web layer, but `relationships.mjs`'s CLI-side writes go through `writeFileAtomic` (atomic, not backup-preserving) with no such net.

**Fixed for real, not just patched around today's specific file:**
- `parseRelationships` now accepts BOTH the old (7-cell) and new (8-cell) row shapes, disambiguated purely by `cells.length` (reliable because both schemas have a fixed field count regardless of note content) — added as a genuine backward-compat path, not a one-time migration script, with an explicit code comment naming this exact incident so a future column addition doesn't repeat it.
- Added a regression test to the self-test suite asserting an old-format row parses correctly (name/contact/lastContact/notes all land in the right fields) — this test would have caught the bug before it shipped.
- Recovered 2 of 5 (Egan Meek, Rachel Pullman) by hand from the snapshot; told Aditya the other 3 (Kent Button, Ken Williams, Yashdeep Saini) were permanently gone.

**Correction, same session, minutes later:** that "permanently gone" claim was WRONG — checked too fast. `web/src/app/api/runs/save/route.ts` persists every finished worker's full output to `.career-ops-web/runs/job-{id}.md` (built earlier this session for the CLI assistant's own "what did we find on that role" recall, not with this recovery case in mind, but it applied directly). Found the exact contacto run (`job-1785214818996-0.md`, 10:32am) with all 3 people's full drafted messages verbatim, and restored them by hand via `relationships.mjs --add`. All 5 are now back, none actually lost. Lesson: check `.career-ops-web/runs/` before declaring agent-research output unrecoverable — it's a genuine backup layer that was easy to forget existed.

**Second real bug found in the same conversation, also fixed same session:** the Relationships page only auto-reloaded when a `compute-heat` job finished, not a `contacto` job — so a "Find contacts" run completed successfully (visible in the sidebar) but its results never appeared in the list without a manual page reload. Fixed in `relationships-view.tsx`: now tracks the latest DONE `contacto` job's id and reloads on change, same as the existing `compute-heat` watcher. Verified in the actual browser after the fix — full reload showed all 5 contacts correctly.

**Third thing surfaced in the same exchange, not a bug — an operational hazard worth naming:** two of Aditya's own "Refresh company signals" runs showed "Connection error" / "hit an error before finishing." Root cause: `run/route.ts` (the file behind BOTH `contacto` and `compute-heat`) was being actively edited by me at the same time those jobs were live in his browser — Next.js dev's hot-reload can drop an in-flight streaming request when its route file changes mid-request. Not a lasting bug (retrying after edits stop works fine), but a real reminder that live-editing a route file other people are actively hitting has a cost, even in a single-user dev setup.

**Process lesson, added explicitly so it isn't just "learned this once":** `snapshot-config.mjs` needs to run BEFORE a schema-affecting edit to a live gitignored file, not just after — snapshotting after the fact only protects the NEXT loss, not this one. The 10:27 snapshot that saved 2 of 5 contacts was a lucky accident of timing (taken for an unrelated reason earlier that morning), not a deliberate pre-edit safety step. Separately: `.career-ops-web/runs/` is a real safety net for agent-research output specifically and should be checked before concluding something is unrecoverable.

## 13. Contact info split into LinkedIn + Email, applying yesterday's lesson correctly (2026-07-29)

**Request:** Aditya re-ran "Find contacts," it wasn't finding contact info (checked: the run he was recalling predated the LinkedIn-capture requirement — no actual new run had happened), and he explicitly wants BOTH LinkedIn AND email captured, not one blended field.

**Applied the exact discipline written down after yesterday's incident, this time BEFORE touching the schema:** ran `snapshot-config.mjs` first, then made the change, then re-verified the live file parsed correctly before writing anything back — the inverse order of what caused the data loss yesterday.

**Schema now: 3-way backward-compatible** (`parseRelationships` disambiguates purely by `cells.length`, each version has a fixed field count regardless of note content):
- 7 cells → oldest (pre-Contact column, before 2026-07-28 morning)
- 8 cells → middle (single blended Contact column, 2026-07-28 midday) — content-routed: `@`-containing non-URL values go to `email`, everything else to `linkedin`
- 9+ cells → current (separate `LinkedIn` + `Email` columns)

Self-test suite grew to 20 cases, including explicit coverage of all 3 historical shapes (the oldest-format regression test from yesterday, plus two new middle-format tests — one URL-shaped, one email-shaped — proving the content-routing heuristic works both ways).

**contacto's prompt updated** (`run/route.ts`) to require attempting BOTH: a real LinkedIn URL (required, skip-with-note if genuinely not found) AND a real, *publicly verifiable* email — with an explicit, forceful non-fabrication rule: never pattern-guess an email (e.g. never assume `firstname.lastname@company.com`), since an unconfirmed guessed email is worse than none — it looks real but may not work or may reach the wrong person.

**Verified for real:**
- `node relationships.mjs --self-test` — 20/20 pass.
- Re-ran `contacto` against report #001 for real ($1.07, 81k tokens) — this run found ZERO new contacts, correctly declining a candidate (Edward Hawkins, ex-VMware vSRC lead) because his own LinkedIn headline said "Ex-VMware," i.e. not currently there — good evidence the non-fabrication discipline extends naturally to the new LinkedIn/email fields too, though it didn't produce a positive add to verify against.
- Separately verified the LinkedIn+Email plumbing itself (CLI → `/api/relationships` → JSON) with a synthetic add — both fields round-tripped correctly through the real API, not just the CLI. Removed the synthetic test row by hand afterward (no `--delete` command exists yet), re-ran self-test + `--json` to confirm exactly the 5 real contacts remain, re-snapshotted.
- Browser-level UI verification (LinkedIn/Email badges rendering, form fields) was NOT completed this pass — the claude-in-chrome extension disconnected mid-session. Relying on: clean `tsc --noEmit`, the proven API-level round-trip, and that the badge-rendering logic reuses the exact same conditional-render pattern already proven working for the company-heat badge. Should be visually confirmed next time the browser extension is available.

**Aditya then re-ran "Find contacts" himself and it worked** — captured a real LinkedIn URL (`linkedin.com/in/kentb/`) for a newly found contact (a second Kent Button lead, different role), correctly leaving email blank rather than guessing. First real-world proof the LinkedIn/email fix works in practice, not just synthetically.

## 14. `--delete` added to relationships.mjs (CLI + API + UI), 2026-07-29

Small gap flagged by hand-editing test data out all session. `node relationships.mjs --delete <#>` — numbers stay stable IDs, not re-sequenced (same convention as report numbers elsewhere). Self-test added (22 total now), tested against real data with a throwaway entry (all 6 real contacts survived). Wired into `/api/relationships` (`action: "delete"`) and the UI (trash icon, inline two-click "Confirm delete"/"Cancel" — deliberately NOT a native `confirm()`, since that would block claude-in-chrome browser-automation testing and doesn't match this app's UI style elsewhere).

## 15. Planning-doc synthesis + "contacts need outreach" home banner (2026-07-29)

**Read all 5 pre-existing planning docs in full** (`mega-plan-next-sessions.md`, `job-search-automation-precious-pearl.md`, `relationship-pipeline-{architecture,contacts,signals}.md`) via a forked subagent to avoid burning context on raw reads, before proposing new work — per the standing discipline this session established (verify what exists before building new). Findings:
- Confirmed what's already built this session matches/supersedes the docs' Phase 1-3 relationship-pipeline plan.
- Ranked what's NOT yet built: (1) a home-page "contacts need outreach" banner [built this section], (2) job-posting velocity as a free signal (highest-rated idea in the original signals research, zero new cost — derived from `scan-history.tsv` which already exists), (3) warm-path/alumni-overlap detection for `contacto` (the single highest-leverage idea across all 5 docs — cross-referencing `cv.md`'s work history against found contacts; original research cites 5-10x better response rates for warm vs. cold outreach), (4) GitHub-org-member/patent/paper contact sourcing.
- Explicitly flagged as NOT to resurrect: Crunchbase/paid APIs, Apollo/RocketReach-style scraping (LinkedIn actively shuts these down), and — most importantly — `mega-plan-next-sessions.md`/`precious-pearl.md`'s full auto-**submit** Apply Agent architecture, which is written for Aditya's own (pre-pivot) job search and matches a pattern his own memory already diagnosed as a dead end (real engineering effort, zero completed submissions). Different problem from what this session has built (sourcing + relationships), not a gap to fill.
- Aditya chose to build (1) now, defer discussion of (3) for later.

**Built:** `web/src/components/home/relationship-followup-card.tsx` (new — mirrors `follow-up-card.tsx`'s exact one-tap shape: "Contacted today" calls `/api/relationships {action:"touch"}`, optimistic clear; "Snooze" is a client-only dismiss). Wired into `today-dashboard.tsx`: a new `overdueRelationships` state fetched alongside the existing followups/fresh-matches fetches (same `refetch()` callback, same `co-job-done` event trigger), folded into the hero headline's "N new · M follow-ups · K contacts need outreach" pattern and `allClear` logic, plus a new "Contacts need outreach" Section using the exact same `Section` component the other two demand-loop sections already use.

**Verified:** `tsc --noEmit` clean. Confirmed via the real API that overdue count is computed correctly (0 currently — none of the 6 real contacts have a `nextAction` date set yet, so the banner won't show until one is overdue). Added a temporary overdue test entry, confirmed the API's `overdue` flag flipped to 1, then cleaned it up using the newly-built `--delete` (nice validation that #14 and #15 compose correctly). **Browser-level screenshot verification NOT done** — claude-in-chrome was disconnected for this whole build. The banner only populates client-side after hydration (same as the existing follow-up banner), so a plain `curl` of the page HTML can't confirm it either; relying on identical wiring to the already-proven follow-up banner pattern. Needs a visual check next time the browser extension is available.

## 16. Job-posting velocity — priority-2 item, and a real methodology bug caught before shipping (2026-07-29)

**Scope:** the highest-rated idea from the original signals research that isn't built yet — a free 5th `compute-heat` sub-score derived entirely from `data/scan-history.tsv` (which `scan.mjs` already writes), zero new API/WebSearch cost.

**Reused existing infrastructure rather than reinventing dedup:** `detect-reposts.mjs` already solves the "is this the same role reposted" problem via `roleFuzzyMatch` (from `role-matcher.mjs`) + `parseScanHistory` (both already exported). New `signal-agent/compute-velocity.mjs` reuses both: single-linkage clusters a company's postings by fuzzy title match, takes each cluster's EARLIEST `first_seen` as that role's "birth date," and counts a cluster as "new" only if its birth date falls inside the lookback window (default 14 days) — so a role reposted 5 times doesn't inflate the count, and an old role resurfacing recently doesn't either (only its true birth date matters).

**Real bug caught by testing against real data before shipping, not just self-tests:** running it against Broadcom and Zscaler returned `newRoleCount: 213` / `174`, both maxing the score at 100 — implausibly high. Root cause: `data/scan-history.tsv` only spans 2026-07-27 to 2026-07-28 (2 days total — scanning only really started this session). Every currently-open role at a company necessarily has a "first seen" date inside ANY lookback window right now, not because of real hiring acceleration, but simply because that's when scanning began. A confidently-wrong 100 is worse than an honest "don't know" — same discipline this whole session has followed elsewhere (`githubActivityScore` returning `null` on a failed call, `signal-agent/SKILL.md`'s "score 0 only when you genuinely found nothing").

**Fixed with an explicit insufficient-history guard:** if a company's OWN earliest recorded posting is itself younger than the lookback window, `jobPostingVelocity()` returns `{ newRoleCount: null, score: null, insufficientHistory: true }` instead of a number. Self-test suite (9 cases) rewritten to include an old "anchor" row per test dataset (so the guard doesn't mask the actual assertions under test) plus a dedicated regression test reproducing the exact real bug found on Broadcom/Zscaler.

**Wired into `compute-heat.mjs` as a genuine 5th signal**, not bolted on: `WEIGHTS` rebalanced (velocity 0.30, funding 0.25, github 0.20, reddit 0.10, linkedin 0.15 — velocity/github both free+deterministic so weighted highest) rather than just appended at low weight. Auto-computed in the CLI's `main()` exactly like `github` already is (no flag needed, `--velocity N` override / `--no-velocity` disable available same as github's pattern). The persisted record carries `velocityMeta.insufficientHistory` so a 0-contribution from "not enough data yet" is never confused with "genuinely no hiring momentum" downstream. `signal-agent/SKILL.md` and the `compute-heat` orchestrator prompt (`run/route.ts`) both updated to explain this is automatic, free, and may honestly come back insufficient right now.

**Verified for real, three ways:** (1) both self-test suites pass (9 + 9 cases, including the new regression tests). (2) `node signal-agent/compute-heat.mjs --company "Broadcom" --funding 50 --reddit 75 --linkedin 75 --github-org Broadcom` — using the SAME real funding/reddit/linkedin values Broadcom already had on record (not fabricated test input) — correctly returned `insufficientHistory: true`, `velocity: 0`, heat recalculated to 51 under the new weights (down from 74 under the old 4-signal weights — an honest, expected drop, not a regression, since the 5th signal genuinely can't be measured yet). (3) A real run through the actual dashboard orchestrator (`curl` against `/api/run`, `kind: "compute-heat"`, targeting Broadcom specifically to force a fresh score) — the agent correctly reported the gap as "honest 'not enough data' — not an error" per the updated prompt wording, persisted `heat: 55`, confirmed by reading the record directly afterward.

**Honest state going forward:** every company's velocity will read `insufficientHistory` for about the next 12 days (until `scan-history.tsv` spans 14 days), since scanning only started 2026-07-27. This isn't a bug to fix now — the daily cron (§9) is already accumulating the history needed; the signal becomes real automatically once enough days pass.

## 17. Real UI confusion + a real duplicate bug, both fixed (2026-07-29)

**Confusion caught live:** Aditya clicked "Refresh company signals" expecting it to backfill LinkedIn/email for the 5 stale contacts — it never could, that button only scores the COMPANY. Fixed at the UI level FIRST, per his explicit instruction ("before you do that make everything on the website clear") — a visible inline explainer on `/relationships` (not just a tooltip) spelling out which button does what, plus both buttons' tooltips reworded to state plainly what they do NOT do. Committed separately (`6cfbd46`) before touching any logic, exactly as asked.

**The actual missing feature + a real duplicate bug, both confirmed and fixed:**
- No action existed to backfill contact info for an ALREADY-tracked person — only `contacto`'s discovery flow existed, which can only ADD new people. Re-running it just created a second "Kent Button" entry instead of filling in the original's gap.
- New `relationships.mjs --update <#> [--linkedin] [--email] [--role] [--notes]` — only overwrites fields actually passed, never blanks an already-known value. Self-test added (25 cases total now) covering the "backfilling one field must not blank another" property specifically.
- New `kind: "find-contact-info"` in `run/route.ts` — takes a relationship number (not a report number, unlike `contacto`), reads that ONE existing entry's name/role/company (already-confirmed, never re-derived), WebSearches specifically for THAT person's real LinkedIn/email, persists via `--update`. Explicitly scoped to NOT discover new people — a narrower, cheaper, more honest action than re-running full discovery just to fix one gap.
- New per-row button on `/relationships`: the "no contact info" badge is now a **button** ("no contact info — find it") when idle, a spinner when running, wired to `find-contact-info` with `input: r.n`.
- **`contacto`'s own prompt fixed for the root cause**, not just the symptom: step 5 now requires checking `node relationships.mjs --json` for an existing name+company match BEFORE adding — if found, `--update` the existing row instead of `--add`-ing a duplicate.

**Verified for real, four ways, not just self-tests:**
1. `node relationships.mjs --self-test` — 25/25 pass.
2. `--update` tested directly against the real data file with a throwaway value, confirmed it set the target field and left everything else (including email/notes) untouched, then reverted.
3. **Real `find-contact-info` run against Egan Meek (#1)** — found his genuine LinkedIn (`ie.linkedin.com/in/eganmeek`, cross-referenced against a second independent source, The Org), correctly declined to guess an email, persisted via `--update`, confirmed still exactly 1 "Egan Meek" entry afterward (no duplicate).
4. **Real re-run of full `contacto` discovery against report #001** — this is the test that actually proves the dedup fix works, not just the narrower backfill action. It found the SAME Kent Button (#3) already tracked, correctly ran `--update` (backfilled his LinkedIn) instead of `--add`, and — genuinely good behavior — **it also caught and reported the PRE-EXISTING duplicate (#6)** left over from before this fix existed, without deleting it itself ("I did not delete anything since that's a destructive edit... just say the word"). Confirmed #3 and #6 were byte-identical duplicates and deleted #6 by hand. It also surfaced one additional real candidate (Emer O'Neill, a plausibly stronger hiring-manager match given the JD's "vSRC" mention) but correctly did NOT add her since the relevant slots were already filled — offered her as an alternate rather than overriding the mode's own slot-capping rule.

**State after this fix:** 5 real contacts, 0 duplicates, 2 with confirmed real LinkedIn URLs (Egan Meek, Kent Button), 3 still genuinely lacking contact info (can be individually backfilled via the new per-row button whenever useful).

## 18. Autonomous work session while Aditya stepped away (2026-07-29)

Instructions on stepping away: implement more ideas, polish the UI, push/update notes periodically, explain what happened with WebSearch, think about job-data-source "smart routing," and produce a clean summary for manual testing on return — explicitly framed as "close to production v1."

**Priority-3 item shipped: warm-path/alumni overlap detection for `contacto`** — the single highest-leverage idea from the planning-doc synthesis (yesterday, §15), since cold outreach converts ~2-8% vs. 40-65% for a genuine shared-employer/school connection.

Added as a new step in `contacto`'s prompt (`run/route.ts`): for each real person found, check their LinkedIn/bio against Amit's OWN employer/school history from `cv.md` (read fresh each run, not hardcoded — the prompt explicitly says not to trust the copy embedded in the prompt text if `cv.md` has changed). A genuine overlap = the SAME employer/school in both, not "also worked in security." When real, lead the message with it and prefix notes `WARM ({shared employer/school}):`; when not, prefix `COLD:`. No schema change — parsed from the existing notes text in the UI via a regex, not a new relationships.md column (avoids repeating the exact class of migration risk from §12/§13).

**Real test result, genuinely good, not just plausible:** re-ran `contacto` against report #001. It correctly recognized all 5 existing contacts (no duplicates — the dedup fix from §17 held), backfilled 3 missing LinkedIn URLs via fresh search, and found ONE genuine overlap: **Ken Williams worked at "CA Technologies"** — the agent correctly reasoned that CA Technologies is the post-2006 rebrand of "Computer Associates (CA)," where Amit's `cv.md` lists a 2005 role. This is real domain reasoning, not a keyword match (the strings "CA Technologies" and "Computer Associates (CA)" don't share enough characters for a naive fuzzy match — the agent had to know the corporate-history fact that one company became the other). It rewrote Ken Williams' message to lead with the specific shared year and tagged it `WARM (CA Technologies)`; left the other 4 as `COLD` since no genuine overlap existed for them. Confirmed persisted correctly via the API afterward (still exactly 5 entries, Ken Williams' notes correctly prefixed), and verified the UI's badge-extraction regex correctly parses `"CA Technologies"` out of the real persisted string. Cost: $0.81, 61.5k tokens.

**Consistent with the session's honesty discipline:** the agent explicitly declined to retroactively rewrite the other 4 pre-existing entries' messages just to tag them WARM/COLD ("wasn't broken, only backfilled contact info per the dedup rule") — conservative, minimal-touch behavior rather than over-eager rewriting.

**UI polish pass, built additively on the existing design system:** `globals.css` already had a mature, accessibility-conscious editorial design system (documented contrast ratios, warm burnt-orange brand, `prefers-reduced-motion` respected throughout) — not a bare template needing a redesign. Added new reusable utilities rather than a new visual language: `.row-lift` (subtle hover translateY+shadow, matches the existing `hover:border-brand/40` convention), `.grid-collapse`/`.is-open` (a modern `grid-template-rows` height transition — no JS height measurement needed — replacing an abrupt conditional-render for the relationships draft panel), `.animate-stagger-in` (reuses the existing fade-in keyframe shape, applied per-row via a `--stagger-delay` CSS custom property set from React). All three respect `prefers-reduced-motion: reduce` (added to the existing media query block, not a separate one). Applied to `relationships-view.tsx` (row-lift + stagger + smooth draft-panel collapse) and `portals-view.tsx` (row-lift + stagger on all 40 companies), plus the home dashboard's `follow-up-card.tsx`/`relationship-followup-card.tsx` for consistency.

**Deliberately did NOT** extend button press-feedback (`active:scale`) across all 12 files using the primary-button pattern (config-form, apply-view, assistant-console, onboarding-banner, etc.) — those are pages not otherwise touched this session, and with the browser extension disconnected all session (see below), there was no way to visually verify a broader change wouldn't look off in a page I haven't reviewed. Scoped the polish to files already understood well this session rather than risk an unverified regression elsewhere.

**Honest caveat, not glossed over:** claude-in-chrome stayed disconnected for this entire polish pass — every change here is verified via clean `tsc --noEmit` and careful code review (the CSS grid-collapse technique and stagger-delay wiring were checked line-by-line against known-working patterns), but NONE of it has been visually confirmed in an actual browser yet. This is the single most important thing to check first when back.

## 19. `scan-ats-full.mjs` dry-run result — correcting my own earlier recommendation (2026-07-29)

Aditya stepped away with instructions to implement more ideas, polish the UI, and "think about the data sources for jobs, like we need smart routing." Researched via a forked subagent (read `providers/_registry.mjs`, `scan-ats-full.mjs`, `portals.yml`) — found a real, fully-built, zero-LLM-cost second scanner (`scan-ats-full.mjs`, walks public ATS company directories by `title_filter`/`location_filter` instead of the curated `portals.yml` list) that's never been wired into anything. Initially recommended enabling it in the summary report, with the caveat that it hadn't been dry-run yet.

**Ran the actual dry-run (`--dry-run --since 3`) — it took 6+ minutes and returned almost entirely irrelevant results**: Airbus, Alleima, Aliaxis, Alcon, Abbott, Albemarle, AIA, Airzone, ABB, AgeCare, Accenture, AAA Insurance — aircraft manufacturing techs, insurance litigation attorneys, quality assurance supervisors. Zero Zero-Trust/security postings anywhere in the real sample.

**Root cause, not a bug in the script**: `portals.yml`'s `title_filter` is deliberately empty by design (its own header comment: "title doesn't matter for this search... comp + domain fit do. Do not add title keywords here"). `scan-ats-full.mjs` filters ONLY by `title_filter`/`location_filter` — with both empty, it correctly does exactly what it's told: returns the entire public ATS dataset, unfiltered. That's not useful noise reduction for this project's title-agnostic search philosophy.

**Corrected the recommendation given to Aditya mid-session, in the same conversation, as soon as the real data came in** — rather than let an optimistic "just enable it" recommendation stand uncorrected. To make this genuinely useful would require either a real title filter (conflicts with the existing deliberate title-agnostic design) or company-name filtering against a security-industry list first — a real design decision, not a quick toggle. Not wired into cron; left as an open, correctly-scoped question for Aditya to decide, not something I quietly enabled while he was away.

