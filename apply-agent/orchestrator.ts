#!/usr/bin/env node
/**
 * apply-agent/orchestrator.ts — Tier 1 Apply Agent orchestrator (Phase 4)
 *
 * Reads a score-banded job (from CLI args or, in later phases, the tracker
 * queue), runs the relocation gate and pause-trigger checks, then fills the
 * real application form via web/src/lib/apply/session.ts's fill-only
 * pipeline and hands off to the human for final review.
 *
 * IMPORTANT — current scope: this orchestrator does NOT click submit.
 * session.ts's fillSession() is deliberately "never submit by construction"
 * (see that file's own comments), and this orchestrator does not add a
 * submit action on top of it yet. Every run ends in handoffSession() —
 * bringing the pre-filled, reviewed form to the front for the human to
 * click submit themselves. Adding real one-click auto-submission is a
 * separate, explicitly-scoped follow-up (see the job-search-automation
 * plan's Phase 4/5) that needs its own sign-off before being built, given
 * it overrides career-ops' core "never submit without review" guarantee.
 *
 * Run with:
 *   npx tsx --tsconfig web/tsconfig.json apply-agent/orchestrator.ts \
 *     --url <url> --score <X.X> --company <name> --role <role> \
 *     [--location <loc>] [--report <num>]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import { openSession, fillSession, handoffSession, closeSession, getSession } from '../web/src/lib/apply/session';
import { resolveTailoredCv } from '../web/src/lib/apply/cv';

// @ts-expect-error — plain .mjs, no type declarations
import { mapFields } from './field-mapper.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { checkRelocationGate } from './gates/relocation.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { logSubmission, screenshotPath } from './submission-log.mjs';
// @ts-expect-error — plain .mjs, no type declarations
import { addEntry } from '../needs-input.mjs';

const APPLY_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(APPLY_AGENT_DIR);

type Profile = {
  candidate?: Record<string, string>;
  auto_apply_thresholds?: { high: number; medium: number };
};

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

  if (!url || Number.isNaN(score)) {
    console.error('Usage: tsx --tsconfig web/tsconfig.json apply-agent/orchestrator.ts --url <url> --score <X.X> --company <name> --role <role> [--location <loc>] [--report <num>]');
    process.exitCode = 1;
    return;
  }

  const profile = loadProfile();
  const thresholds = profile.auto_apply_thresholds || { high: 4.5, medium: 4.0 };
  const band = scoreBand(score, thresholds);

  if (band === 'low') {
    console.log(JSON.stringify({ decision: 'draft-only', reason: `score ${score} below medium threshold ${thresholds.medium}` }, null, 2));
    return;
  }

  const relocation = checkRelocationGate({ company, role, location, url, reportRef });
  if (relocation.blocked) {
    console.log(JSON.stringify({ decision: 'paused', reason: 'relocation', entry: relocation.entry }, null, 2));
    return;
  }

  console.error(`Opening application session for ${company} — ${role} (${band} band)...`);
  const session = await openSession(url);

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
    await closeSession(session.id);
    return;
  }

  const { answers, unmapped, salaryFields } = mapFields(session.fields, profile);
  const rawSession = getSession(session.id);
  const beforePath = reportRef ? screenshotPath(reportRef, 'before') : null;
  if (rawSession && beforePath) {
    await rawSession.page.screenshot({ path: beforePath }).catch(() => {});
  }

  if (unmapped.length > 0) {
    const entry = addEntry({
      source: 'unmapped_field',
      reason: `${unmapped.length} required field(s) with no profile mapping: ${unmapped.map((f: { label: string }) => f.label).join(', ')}`,
      company, role, report_ref: reportRef,
      context: { url, unmappedFields: unmapped.map((f: { id: string; label: string }) => ({ id: f.id, label: f.label })), sessionId: session.id },
    });
    logSubmission({ company, role, url, reportRef, tier: 1, variant: null, formData: answers, beforeScreenshot: beforePath, outcome: 'paused', pauseReason: 'unmapped_field' });
    console.log(JSON.stringify({ decision: 'paused', reason: 'unmapped_field', entry }, null, 2));
    await handoffSession(session.id); // human fills the missing field(s) and reviews the rest
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
    await handoffSession(session.id);
    return;
  }

  const cvPath = resolveTailoredCv(company) ?? undefined;
  const fillResult = await fillSession(session.id, answers, session.fields, cvPath);

  const afterPath = reportRef ? screenshotPath(reportRef, 'after') : null;
  if (rawSession && afterPath) {
    await rawSession.page.screenshot({ path: afterPath }).catch(() => {});
  }

  logSubmission({
    company, role, url, reportRef, tier: 1, variant: null,
    formData: answers,
    beforeScreenshot: beforePath,
    afterScreenshot: afterPath,
    // Never "submitted" yet — see file header. This is the pre-submit,
    // filled-and-awaiting-human-review state.
    outcome: 'paused',
    pauseReason: 'awaiting-human-review',
  });

  await handoffSession(session.id);

  console.log(JSON.stringify({
    decision: 'filled-awaiting-human-review',
    band,
    fieldsFilled: fillResult.steps.filter((s: { ok: boolean }) => s.ok).length,
    fieldsTotal: fillResult.steps.length,
    issues: fillResult.issues,
    cvAttached: !!cvPath,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
