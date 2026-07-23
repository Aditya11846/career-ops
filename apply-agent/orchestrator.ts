#!/usr/bin/env node
/**
 * apply-agent/orchestrator.ts — Tier 1 Apply Agent orchestrator (Phase 4)
 *
 * Reads a score-banded job (from CLI args or, in later phases, the tracker
 * queue), runs the relocation gate and pause-trigger checks, then fills the
 * real application form via web/src/lib/apply/session.ts's fill-only
 * pipeline and hands off to the human for final review.
 *
 * SUBMIT MODEL (revised — the human gate moved to the approve step): a job
 * only ever reaches this orchestrator via apply-agent/run-approved.mjs, which
 * only processes entries the candidate explicitly approved beforehand
 * (data/apply-approved.json, written by apply-agent/approve-for-apply.mjs or
 * the dashboard's approve action). Given that, a CLEAN fill (no unmapped
 * fields, no salary fields, no post-fill issues) submits immediately via
 * session.ts's submitSession() — no second per-form review. A fill that hits
 * a genuine blocker (login-wall, unmapped required field, ambiguous salary
 * field, or any verifyFill() issue) still pauses to data/needs-input.md and
 * apply-agent/approve-queue.mjs exactly as before — those are cases the
 * automation cannot safely resolve, not a redundant check on an already-good
 * fill. Called directly (not via run-approved.mjs) without --auto-submit,
 * this orchestrator behaves as it always did: fill + handoff, no submit.
 *
 * WHY THIS TALKS OVER HTTP, NOT A DIRECT IMPORT (bug fixed 2026-07-22):
 * web/src/lib/apply/session.ts's extractForm() runs page.evaluate(() => {...})
 * closures with named inner helper functions. When this file is imported
 * directly from the repo root and transpiled by tsx/esbuild (as the old
 * `import { openSession } from '../web/src/lib/apply/session'` did), esbuild's
 * name-preservation injects a `__name(...)` helper call into those closures.
 * Playwright serializes the closure to a string and runs it inside the
 * browser's isolated page context, where `__name` does not exist — so every
 * extraction call threw `ReferenceError: __name is not defined`, which
 * pickFormFrame()'s catch swallowed silently, leaving 0 fields extracted and
 * cascading into "this looks like the careers listing" on real, live
 * postings (confirmed against Anthropic + Parloa Greenhouse forms). Next.js's
 * own SWC build of the SAME file does not have this problem — confirmed by
 * calling /api/apply/session directly, which extracted all fields correctly.
 * So this orchestrator now calls the already-correct Next.js API routes
 * instead of re-transpiling web/'s apply library from a different toolchain.
 * Requires the web/ Next dev or prod server running (see WEB_APP_URL below).
 *
 * Run with:
 *   npx tsx apply-agent/orchestrator.ts \
 *     --url <url> --score <X.X> --company <name> --role <role> \
 *     [--location <loc>] [--report <num>]
 * (with `npm run dev` — or a production `next start` — running in web/)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

// @ts-expect-error — plain .mjs, no type declarations
import { mapFields } from './field-mapper.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { checkRelocationGate } from './gates/relocation.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { logSubmission, screenshotPath } from './submission-log.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { addEntry } from '../needs-input.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { addEntry as addApproveEntry } from './approve-queue.mjs';

async function apiPostSubmit(sessionId: string): Promise<{ ok: boolean; navigated: boolean; confirmationText: string | null; error?: string }> {
  const res = await fetch(`${WEB_APP_URL}/api/apply/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, confirm: true }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.error || `submit failed (${res.status})`);
  return json;
}

const APPLY_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(APPLY_AGENT_DIR);
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000';

type Profile = {
  candidate?: Record<string, string>;
  auto_apply_thresholds?: { high: number; medium: number };
};

type ApplyField = {
  id: string;
  type: string;
  label: string;
  required: boolean;
  options?: string[];
  [k: string]: unknown;
};
type ApplyIssue = { level: 'info' | 'warn' | 'block'; code: string; message: string };
type OpenSessionResult = { id: string; title: string; fields: ApplyField[]; shots: string[]; issues: ApplyIssue[]; error?: string };
type FillResult = { steps: { fieldId: string; label: string; ok: boolean; thumb?: string }[]; navigated: boolean; issues: ApplyIssue[]; handedOff: boolean; cvAttached: boolean; error?: string };

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WEB_APP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `${path} failed (${res.status})`);
  return json;
}

/** Decode a `data:image/jpeg;base64,...` shot into a screenshot file on disk. */
function saveShot(dataUri: string | undefined, path: string | null): void {
  if (!dataUri || !path) return;
  const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUri);
  if (!m) return;
  writeFileSync(path, Buffer.from(m[1], 'base64'));
}

function loadProfile(): Profile {
  return yaml.load(readFileSync(join(CAREER_OPS, 'config/profile.yml'), 'utf-8')) as Profile;
}

export function scoreBand(score: number, thresholds: { high: number; medium: number }): 'high' | 'medium' | 'low' {
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.medium) return 'medium';
  return 'low';
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const url = parseArg(args, '--url');
  const company = parseArg(args, '--company') || '';
  const role = parseArg(args, '--role') || '';
  const location = parseArg(args, '--location') || '';
  const reportRef = parseArg(args, '--report') || null;
  const score = Number(parseArg(args, '--score'));
  // The human gate is now the approve step upstream (apply-agent/run-approved.mjs
  // only calls this for jobs already in data/apply-approved.json), so score no
  // longer blocks a run here — it's still computed and logged as context.
  const autoSubmit = args.includes('--auto-submit');

  if (!url || Number.isNaN(score)) {
    console.error('Usage: tsx apply-agent/orchestrator.ts --url <url> --score <X.X> --company <name> --role <role> [--location <loc>] [--report <num>] [--auto-submit]');
    process.exitCode = 1;
    return;
  }

  const profile = loadProfile();
  const thresholds = profile.auto_apply_thresholds || { high: 4.5, medium: 4.0 };
  const band = scoreBand(score, thresholds);

  const relocation = checkRelocationGate({ company, role, location, url, reportRef });
  if (relocation.blocked) {
    console.log(JSON.stringify({ decision: 'paused', reason: 'relocation', entry: relocation.entry }, null, 2));
    return;
  }

  console.error(`Opening application session for ${company} — ${role} (${band} band)...`);
  const session = await apiPost<OpenSessionResult>('/api/apply/session', { url });

  const blockingCodes = new Set(['captcha-present', 'bot-challenge', 'login-wall', 'auth-required']);
  const blockingIssue = session.issues.find(i => i.level === 'block' || blockingCodes.has(i.code));
  if (blockingIssue) {
    const entry = addEntry({
      source: 'apply_pause',
      reason: blockingIssue.message,
      company, role, report_ref: reportRef,
      context: { url, issueCode: blockingIssue.code, sessionId: session.id },
    });
    logSubmission({ company, role, url, reportRef, tier: 1, variant: null, formData: {}, outcome: 'paused', pauseReason: blockingIssue.code });
    console.log(JSON.stringify({ decision: 'paused', reason: blockingIssue.code, entry }, null, 2));
    await apiPost('/api/apply/close', { sessionId: session.id });
    return;
  }

  const { answers, unmapped, salaryFields } = mapFields(session.fields, profile);
  const beforePath = reportRef ? screenshotPath(reportRef, 'before') : null;
  saveShot(session.shots[session.shots.length - 1], beforePath);

  if (unmapped.length > 0) {
    const entry = addEntry({
      source: 'unmapped_field',
      reason: `${unmapped.length} required field(s) with no profile mapping: ${unmapped.map((f: { label: string }) => f.label).join(', ')}`,
      company, role, report_ref: reportRef,
      context: { url, unmappedFields: unmapped.map((f: { id: string; label: string }) => ({ id: f.id, label: f.label })), sessionId: session.id },
    });
    logSubmission({ company, role, url, reportRef, tier: 1, variant: null, formData: answers, beforeScreenshot: beforePath, outcome: 'paused', pauseReason: 'unmapped_field' });
    console.log(JSON.stringify({ decision: 'paused', reason: 'unmapped_field', entry }, null, 2));
    // human fills the missing field(s) and reviews the rest
    await apiPost('/api/apply/fill', { sessionId: session.id, answers, fields: session.fields, handoff: true, company });
    return;
  }

  if (salaryFields.length > 0) {
    const entry = addEntry({
      source: 'apply_pause',
      reason: `Salary expectation field requires a specific number: ${salaryFields.map((f: { label: string }) => f.label).join(', ')}`,
      company, role, report_ref: reportRef,
      context: { url, salaryFields: salaryFields.map((f: { id: string; label: string }) => ({ id: f.id, label: f.label })), sessionId: session.id },
    });
    logSubmission({ company, role, url, reportRef, tier: 1, variant: null, formData: answers, beforeScreenshot: beforePath, outcome: 'paused', pauseReason: 'salary_field' });
    console.log(JSON.stringify({ decision: 'paused', reason: 'salary_field', entry }, null, 2));
    await apiPost('/api/apply/fill', { sessionId: session.id, answers, fields: session.fields, handoff: true, company });
    return;
  }

  const fillResult = await apiPost<FillResult>('/api/apply/fill', {
    sessionId: session.id, answers, fields: session.fields, handoff: true, company,
  });

  const afterPath = reportRef ? screenshotPath(reportRef, 'after') : null;
  saveShot(fillResult.steps[fillResult.steps.length - 1]?.thumb, afterPath);

  const fieldsFilled = fillResult.steps.filter((s: { ok: boolean }) => s.ok).length;
  const fieldsTotal = fillResult.steps.length;

  // A clean fill (every field ok, no post-fill verifyFill() issues) submits
  // immediately when run via run-approved.mjs's --auto-submit. Anything less
  // than clean still queues for a human via approve-queue.mjs below — that's
  // a genuine ambiguity the automation can't safely resolve, not a redundant
  // recheck of a fill that's already known-good.
  const clean = fieldsFilled === fieldsTotal && fillResult.issues.length === 0;

  if (autoSubmit && clean) {
    try {
      const submitResult = await apiPostSubmit(session.id);
      logSubmission({
        company, role, url, reportRef, tier: 1, variant: null,
        formData: answers, beforeScreenshot: beforePath, afterScreenshot: afterPath,
        outcome: 'submitted',
      });
      console.log(JSON.stringify({ decision: 'submitted', band, fieldsFilled, fieldsTotal, ...submitResult }, null, 2));
      return;
    } catch (err) {
      // Submit itself failed (no submit control found, network error, etc.)
      // — fall through to the same human-review queue as a non-clean fill,
      // never leave a half-submitted job unaccounted for.
      console.error(`auto-submit failed for ${company} / ${role}: ${err instanceof Error ? err.message : String(err)} — queuing for manual review instead.`);
    }
  }

  logSubmission({
    company, role, url, reportRef, tier: 1, variant: null,
    formData: answers,
    beforeScreenshot: beforePath,
    afterScreenshot: afterPath,
    // Pre-submit, filled-and-awaiting-human-review state (either fill wasn't
    // clean, --auto-submit wasn't requested, or the auto-submit attempt itself failed).
    outcome: 'paused',
    pauseReason: 'awaiting-human-review',
  });

  // Queue this filled session for fast batch review instead of leaving the
  // human to hunt down the tab manually — see approve-queue.mjs's header for
  // why this doesn't weaken the never-submit-without-review guarantee.
  const queueEntry = addApproveEntry({
    sessionId: session.id, company, role, score, reportRef,
    url, fieldsFilled, fieldsTotal, issues: fillResult.issues,
  });

  console.log(JSON.stringify({
    decision: 'filled-awaiting-human-review',
    band,
    fieldsFilled,
    fieldsTotal,
    issues: fillResult.issues,
    cvAttached: fillResult.cvAttached,
    approveQueueId: queueEntry.id,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
