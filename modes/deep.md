# Mode: deep — Deep Research Prompt

Generate a structured prompt for Perplexity/Claude/ChatGPT with 6 axes:

```text
## Deep Research: [Company] — [Role]

Context: I am evaluating a candidacy for [role] at [company]. I need actionable information for the interview.

### 1. Domain Strategy
- What is the company's core technical domain (read the JD and company overview — do not assume AI/ML)?
- What does their technical stack look like in that domain?
- Do they have an engineering blog, security advisories, or published research? What do they publish?
- What recent talks, papers, or patents have they produced?

### 2. Recent moves (last 6 months)
- Relevant hires in the candidate's target domain (security, systems, engineering leadership — read `modes/_profile.md`)?
- Acquisitions or partnerships?
- Product launches or pivots?
- Funding rounds or leadership changes?

### 3. Engineering culture
- How do they ship? (deployment cadence, CI/CD)
- Monorepo or multirepo?
- What languages/frameworks do they use?
- Remote-first or office-first?
- Glassdoor/Blind reviews about engineering culture?

### 4. Likely challenges
- What scaling problems do they have?
- Reliability, cost, latency challenges?
- Are they migrating anything? (infrastructure, models, platforms)
- What pain points do people mention in reviews?

### 5. Competitors and differentiation
- Who are their main competitors?
- What is their moat/differentiator?
- How are they positioned vs competitors?

### 6. Candidate angle
Given my profile (read from cv.md and profile.yml for specific experience):
- What unique value do I bring to this team?
- Which of my projects are most relevant?
- What story should I tell in the interview?
```

Personalize each section with the specific context of the job being evaluated.
