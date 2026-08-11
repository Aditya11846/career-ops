# Swap Playwright for Stagehand in the apply flow

**Date:** 2026-08-11
**Status:** PLANNED
**Epic:** Apply Flow — ATS Reliability

---

## Problem

The apply stack's core brittleness is in `web/src/lib/apply/extract.ts` and the fill phase in `session.ts`. Both use CSS selectors and `page.evaluate()` DOM introspection to find form fields. This works fine for clean ATS platforms (Greenhouse, Lever, Ashby) but breaks on:

- **Workday** — React SPA with randomized class names and dynamic selectors that change per company and per render
- **iCIMS / SmartRecruiters** — multi-step wizards where selectors shift between steps
- **Custom career pages** — no predictable DOM structure

Stagehand replaces CSS selectors with AI vision — `page.act("fill the work authorization dropdown with 'Yes, I am authorized'")` — so the field is found by meaning, not by fragile DOM attributes that ATS vendors change at will.

Note: `drive.ts` already has an agentic Claude CLI observation loop for navigating to the form. Stagehand replaces the *extract* and *fill* phases, not the navigation/drive phase.

## Auth — Already Solved

Stagehand in `LOCAL` mode connects to the system Chrome installation where Amit is already logged into every job board. No credential management, no cookie injection, no login flows to automate. This is the auth layer opencli uses — same Chrome profile, same sessions.

## What Changes vs. What Stays

**Stays unchanged:**
- `run-approved.mjs` — queue management and routing
- `orchestrator.ts` — gates, relocation check, field-mapper
- `field-mapper.mjs` — profile → field value mapping (this is the good part, keep it)
- `submission-log.mjs`, `approve-queue.mjs`, `needs-input.mjs`
- Existing Next.js API routes for Greenhouse/Lever/Ashby (they work fine)
- `drive.ts` navigation/observe loop (keep as-is)

**Changes:**
- `web/src/lib/apply/stagehand-driver.ts` — NEW: Stagehand-based extract + fill driver
- `web/src/app/api/apply/stagehand-session/route.ts` — NEW: API route for Stagehand sessions
- `run-approved.mjs` — add ATS detection → route Workday/iCIMS to new Stagehand route
- `web/package.json` — add `@browserbasehq/stagehand`

## Plan

### Phase 1: Install + bare proof of concept

1. `npm install @browserbasehq/stagehand` in `web/`
2. Create `web/src/lib/apply/stagehand-driver.ts`:
   - `openStagehandSession(url)` — init Stagehand LOCAL, navigate to URL, return session
   - `extractWithStagehand(page)` — use `page.extract({ instruction: "find all application form fields: labels, types, required status, options", schema: ApplyFieldsSchema })` to get structured fields
   - `fillWithStagehand(page, mappedFields)` — iterate `field-mapper.mjs`'s output, call `page.act("fill [field label] with [value]")` for each
   - `verifyAndSubmitWithStagehand(page, dryRun)` — `page.observe()` to confirm fields look correct, then `page.act("click the Submit Application button")` only if not dryRun
3. Validate against one live Greenhouse URL (easy, already works — confirms Stagehand baseline) and one live Workday URL (the hard case)

### Phase 2: ATS routing in run-approved.mjs

Add `detectAts(url)` helper:
```js
function detectAts(url) {
  if (/myworkday\.com/.test(url)) return 'workday';
  if (/icims\.com/.test(url)) return 'icims';
  if (/smartrecruiters\.com/.test(url)) return 'smartrecruiters';
  return 'standard'; // Greenhouse/Lever/Ashby → existing path
}
```

In `runTier1(entry, dryRun)`:
- `detectAts === 'standard'` → existing `npx tsx apply-agent/orchestrator.ts` path (unchanged)
- anything else → call new `/api/apply/stagehand-session` route via fetch

This is a surgical addition — the existing Tier 1 path is untouched for ATS platforms that work.

### Phase 3: Chrome profile auth

Configure Stagehand LOCAL mode to use the same Chrome profile as opencli:
```ts
const stagehand = new Stagehand({
  env: "LOCAL",
  localBrowserOptions: {
    userDataDir: process.env.CHROME_USER_DATA_DIR || `${os.homedir()}/Library/Application Support/Google/Chrome`,
    channel: "chrome"
  }
});
```

This gives authenticated sessions for LinkedIn, Workday (saved credentials), any gated ATS — same session the user already has open.

## Validates With

- Dry-run against a real Workday posting: `--dry-run` mode logs what fields Stagehand found and what it would fill — no actual submission
- Compare field extraction output (Stagehand vs. current extract.ts) on a known Greenhouse form — should be equivalent or better
- Live submission test on one approved Workday entry in a staging-equivalent run

## Risks & Mitigations

- **Stagehand LOCAL requires Chrome installed (not Chromium):** Amit has Chrome; the `localBrowserOptions.channel: "chrome"` targets it explicitly
- **Stagehand makes LLM API calls per `act()`/`extract()` call:** Each field fill is a Claude/OpenAI call (~$0.001–0.005 each). For a 15-field form that's a few cents. Acceptable for apply — much cheaper than a wasted application.
- **The existing Greenhouse/Lever path stays intact:** routing is additive, not a replacement. If Stagehand has issues, the standard path is one line-change to route back.
- **`verifyFill()` in diagnose.ts won't run on Stagehand sessions:** That's fine — Stagehand's `observe()` replaces it semantically. Add a basic post-fill check: `page.extract({ instruction: "are there any error messages or unfilled required fields?", schema: z.object({ hasErrors: z.boolean(), errors: z.array(z.string()) }) })`

## Success Criteria

- A Workday application form is correctly extracted (all visible fields identified) and filled (correct values, correct field targeted) via Stagehand
- The Playwright-based path for Greenhouse/Lever/Ashby is unaffected
- `node apply-agent/run-approved.mjs --dry-run` correctly routes Workday entries to Stagehand and standard entries to the existing orchestrator

## Quick Start

```bash
# Install
cd web && npm install @browserbasehq/stagehand

# Key files to create
web/src/lib/apply/stagehand-driver.ts   # new
web/src/app/api/apply/stagehand-session/route.ts   # new

# Key file to modify
apply-agent/run-approved.mjs   # add detectAts() + routing

# Test command (dry run, no submission)
node apply-agent/run-approved.mjs --dry-run
```
