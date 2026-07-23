#!/usr/bin/env node
/**
 * apply-agent/tier2/driver-core.mjs — shared Tier 2 (LinkedIn/Naukri) apply flow
 *
 * Talks to the Next.js apply API over HTTP (WEB_APP_URL, default
 * localhost:3000) — same lesson as Tier 1's orchestrator.ts fix: session.ts's
 * page.evaluate() closures break when tsx/esbuild-transpiles them from a
 * direct root-level import, but work correctly under Next's own SWC build.
 * See apply-agent/orchestrator.ts's file header for the full bug writeup.
 *
 * Unlike Tier 1 (score-gated, one-shot per job), Tier 2 runs against a QUEUE
 * of jobs per platform per day, so pacing/cap checks happen per-job inside
 * the loop, not once at the top — a capped or out-of-window day should still
 * let already-decided jobs finish gracefully, not abort mid-fill.
 *
 * LIVE-SESSION DEPENDENCY: LinkedIn/Naukri Easy Apply requires an
 * authenticated session. /api/apply/session resolves a saved storageState
 * (cookies + localStorage) from apply-agent/session-store/{platform}.json
 * when `platform` is 'linkedin' or 'naukri' — see that file's route.ts.
 * That file is created by the candidate running
 * `node apply-agent/session-store/login.mjs linkedin` (or naukri) ONCE and
 * logging in themselves in the visible browser window; this code never
 * enters their credentials. Until that file exists, /api/apply/session
 * opens a fresh, logged-out context and every real job correctly hits the
 * "login-wall" pause trigger below — annotated, never silently broken.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import { mapFields } from '../field-mapper.mjs';
import { checkRelocationGate } from '../gates/relocation.mjs';
import { checkWarmIntroGate } from '../gates/warm-intro.mjs';
import { checkPauseTriggers } from '../pause-triggers.mjs';
import { withinApplyWindow, randomDelayMs } from '../pacing.mjs';
import { checkAndIncrement, isCapped } from '../../budget-tracker.mjs';
import { logSubmission, screenshotPath } from '../submission-log.mjs';
import { addEntry } from '../../needs-input.mjs';
import { addEntry as addApproveEntry } from '../approve-queue.mjs';

const TIER2_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(dirname(TIER2_DIR));
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000';

export function loadProfile() {
  return yaml.load(readFileSync(join(CAREER_OPS, 'config/profile.yml'), 'utf-8'));
}

async function apiPost(path, body) {
  const res = await fetch(`${WEB_APP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `${path} failed (${res.status})`);
  return json;
}

async function apiPostSubmit(sessionId) {
  const res = await fetch(`${WEB_APP_URL}/api/apply/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, confirm: true }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.error || `submit failed (${res.status})`);
  return json;
}

function saveShot(dataUri, path) {
  if (!dataUri || !path) return;
  const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUri);
  if (!m) return;
  writeFileSync(path, Buffer.from(m[1], 'base64'));
}

/**
 * Run ONE Tier 2 job through the full pipeline: pacing gates -> relocation
 * gate -> warm-intro gate (LinkedIn only, needs connectionDegree supplied by
 * the caller's own connections lookup) -> open session -> pause-triggers ->
 * field mapping -> fill(+submit if job.autoSubmit and the fill is clean, else
 * +handoff to the human-review queue). Returns a decision object; never
 * throws for an expected pause (only for a genuine transport/API failure) so
 * the caller's queue loop can move to the next job.
 *
 * @param {{
 *   platform: 'linkedin'|'naukri', url: string, company: string, role: string,
 *   location?: string, reportRef?: string|null, autoSubmit?: boolean,
 *   connectionDegree?: number|null, connectionName?: string|null,
 * }} job
 */
export async function runTier2Apply(job) {
  const { platform, url, company, role, location = '', reportRef = null } = job;

  // Test-only override: never set in normal operation. Lets a manual test
  // run exercise the fill/pause-trigger path outside the real 8am-11pm IST
  // window without touching the pacing logic itself. Nothing downstream
  // ever auto-submits regardless of this flag.
  const skipPacingGate = process.env.APPLY_AGENT_SKIP_PACING_GATE === '1';
  if (!skipPacingGate && !withinApplyWindow()) {
    return { decision: 'skipped', reason: 'outside the 8am-11pm IST apply window' };
  }
  const budgetKind = platform === 'linkedin' ? 'tier2_apply_linkedin' : 'tier2_apply_naukri';
  if (isCapped(budgetKind)) {
    const entry = addEntry({
      source: 'budget_cap',
      reason: `${platform} has hit its daily apply backstop — resumes tomorrow.`,
      company, role, report_ref: reportRef,
      context: { url, platform },
    });
    return { decision: 'skipped', reason: 'daily_cap', entry };
  }

  const relocation = checkRelocationGate({ company, role, location, url, reportRef });
  if (relocation.blocked) {
    return { decision: 'paused', reason: 'relocation', entry: relocation.entry };
  }

  if (platform === 'linkedin') {
    const warmIntro = checkWarmIntroGate({
      company, role, url, reportRef,
      connectionDegree: job.connectionDegree ?? null,
      connectionName: job.connectionName ?? null,
    });
    if (warmIntro.blocked) {
      return { decision: 'paused', reason: 'warm_intro', entry: warmIntro.entry };
    }
  }

  const profile = loadProfile();
  let session;
  try {
    session = await apiPost('/api/apply/session', { url, platform });
  } catch (err) {
    // openSession() throws for HARD blocks (login-wall, bot-challenge,
    // expired, listing-page, no-form) rather than returning them in
    // session.issues — soft issues (e.g. captcha-present) DO come back in
    // issues and are handled by checkPauseTriggers below. Until
    // session-store/ wires a persistent logged-in session, every real
    // LinkedIn/Naukri URL will hit login-wall HERE, every time — so this
    // must pause-and-continue, never crash the day's queue.
    const message = err instanceof Error ? err.message : String(err);
    const entry = addEntry({
      source: 'apply_pause',
      reason: message,
      company, role, report_ref: reportRef,
      context: { url, platform },
    });
    logSubmission({ company, role, url, reportRef, tier: 2, variant: null, formData: {}, outcome: 'paused', pauseReason: 'open_session_failed' });
    return { decision: 'paused', reason: 'open_session_failed', entry };
  }

  const staticTrigger = checkPauseTriggers({ issues: session.issues });
  if (staticTrigger.paused) {
    const entry = addEntry({
      source: 'apply_pause',
      reason: staticTrigger.reason,
      company, role, report_ref: reportRef,
      context: { url, issueCode: staticTrigger.code, sessionId: session.id, platform },
    });
    logSubmission({ company, role, url, reportRef, tier: 2, variant: null, formData: {}, outcome: 'paused', pauseReason: staticTrigger.code });
    await apiPost('/api/apply/close', { sessionId: session.id });
    return { decision: 'paused', reason: staticTrigger.code, entry };
  }

  const { answers, unmapped, salaryFields } = mapFields(session.fields, profile);
  const beforePath = reportRef ? screenshotPath(reportRef, 'before') : null;
  saveShot(session.shots[session.shots.length - 1], beforePath);

  const fieldTrigger = checkPauseTriggers({ unmapped, salaryFields });
  if (fieldTrigger.paused) {
    const entry = addEntry({
      source: fieldTrigger.code === 'unmapped_field' ? 'unmapped_field' : 'apply_pause',
      reason: fieldTrigger.reason,
      company, role, report_ref: reportRef,
      context: { url, sessionId: session.id, platform, unmapped: unmapped.map(f => ({ id: f.id, label: f.label })), salaryFields: salaryFields.map(f => ({ id: f.id, label: f.label })) },
    });
    logSubmission({ company, role, url, reportRef, tier: 2, variant: null, formData: answers, beforeScreenshot: beforePath, outcome: 'paused', pauseReason: fieldTrigger.code });
    // fill what WAS mapped, then hand off for the human to finish + review
    await apiPost('/api/apply/fill', { sessionId: session.id, answers, fields: session.fields, handoff: true, company });
    return { decision: 'paused', reason: fieldTrigger.code, entry };
  }

  const fillResult = await apiPost('/api/apply/fill', { sessionId: session.id, answers, fields: session.fields, handoff: true, company });

  const afterPath = reportRef ? screenshotPath(reportRef, 'after') : null;
  saveShot(fillResult.steps[fillResult.steps.length - 1]?.thumb, afterPath);
  checkAndIncrement(budgetKind, { company, role, reportRef });

  const fieldsFilled = fillResult.steps.filter(s => s.ok).length;
  const fieldsTotal = fillResult.steps.length;

  // Same auto-submit rule as Tier 1's orchestrator.ts: a clean fill (every
  // field ok, no post-fill issues) submits immediately when the caller
  // (apply-agent/run-approved.mjs) passes autoSubmit — this job already went
  // through the human approve step upstream. Anything less than clean still
  // queues for a human below, since that's a genuine ambiguity, not a
  // redundant recheck.
  const clean = fieldsFilled === fieldsTotal && fillResult.issues.length === 0;
  if (job.autoSubmit && clean) {
    try {
      const submitResult = await apiPostSubmit(session.id);
      logSubmission({
        company, role, url, reportRef, tier: 2, variant: null,
        formData: answers, beforeScreenshot: beforePath, afterScreenshot: afterPath,
        outcome: 'submitted',
      });
      return { decision: 'submitted', fieldsFilled, fieldsTotal, cvAttached: fillResult.cvAttached, ...submitResult };
    } catch (err) {
      // fall through to the human-review queue — never leave a
      // half-submitted job unaccounted for.
    }
  }

  logSubmission({
    company, role, url, reportRef, tier: 2, variant: null,
    formData: answers, beforeScreenshot: beforePath, afterScreenshot: afterPath,
    outcome: 'paused', pauseReason: 'awaiting-human-review',
  });

  // Queue this filled session for fast batch review, same as Tier 1's
  // orchestrator.ts — previously Tier 2 fills left an orphaned browser tab
  // with no way to find it again outside this one process's stdout.
  const queueEntry = addApproveEntry({
    sessionId: session.id, company, role, score: null, reportRef,
    url, fieldsFilled, fieldsTotal, issues: fillResult.issues,
  });

  return {
    decision: 'filled-awaiting-human-review',
    fieldsFilled,
    fieldsTotal,
    cvAttached: fillResult.cvAttached,
    approveQueueId: queueEntry.id,
  };
}

/** Randomized human-like pause between jobs in a Tier 2 queue run. */
export async function pacingDelay(minSec = 45, maxSec = 240) {
  await new Promise(resolve => setTimeout(resolve, randomDelayMs(minSec, maxSec)));
}
