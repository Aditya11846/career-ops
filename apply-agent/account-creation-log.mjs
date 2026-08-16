#!/usr/bin/env node
/**
 * apply-agent/account-creation-log.mjs — append-only audit log for the
 * Workday auto-account-creation flow (web/src/lib/apply/workday-account.ts)
 *
 * This is the record that replaces a human checkpoint for that flow: nothing
 * pauses waiting for review, but every step — account created, consent
 * accepted, verification email received, account activated, logged in,
 * application filled, application submitted — is written here so it can be
 * inspected after the fact. Mirrors submission-log.mjs's append-only JSONL
 * pattern exactly (one file per install, gitignored, partial writes never
 * corrupt prior entries).
 *
 * web/src/lib/apply/ats-account.ts (the Next.js-side driver) writes to the
 * SAME data/ats-account-log.jsonl file with its own equivalent writer rather
 * than importing this module — the Node/tsx and Next.js/SWC toolchains don't
 * statically import across that boundary in this codebase (see the bug
 * documented in apply-agent/orchestrator.ts). Both converge on one log.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const APPLY_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(APPLY_AGENT_DIR);
const LOG_PATH = join(CAREER_OPS, 'data/ats-account-log.jsonl');

const VALID_STEPS = new Set([
  'account_created',
  'consent_accepted',
  'verification_email_received',
  'account_activated',
  'logged_in',
  'application_filled',
  'application_submitted',
  'failed',
]);

/**
 * @param {{
 *   employer: string,
 *   employerSlug: string,
 *   email: string,
 *   step: 'account_created'|'consent_accepted'|'verification_email_received'|'account_activated'|'logged_in'|'application_filled'|'application_submitted'|'failed',
 *   detail?: string,
 * }} entry
 * @returns {object} the persisted record (with a generated timestamp)
 */
export function logAccountStep(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('logAccountStep requires an object');
  for (const field of ['employer', 'employerSlug', 'email', 'step']) {
    if (entry[field] === undefined) throw new Error(`logAccountStep: missing required field "${field}"`);
  }
  if (!VALID_STEPS.has(entry.step)) {
    throw new Error(`logAccountStep: invalid step "${entry.step}"`);
  }

  const record = {
    timestamp: new Date().toISOString(),
    employer: entry.employer,
    employerSlug: entry.employerSlug,
    email: entry.email,
    step: entry.step,
    detail: entry.detail ?? null,
  };

  if (!existsSync(dirname(LOG_PATH))) mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
  return record;
}

// --- Self-test ---
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${label}`);
  }
}

function runSelfTest() {
  try {
    logAccountStep({ employer: 'Test Co' });
    assertEqual(true, false, 'logAccountStep rejects a missing required field (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('missing required field'), true, 'logAccountStep rejects a missing required field');
  }

  try {
    logAccountStep({ employer: 'Test Co', employerSlug: 'test-co', email: 'a@b.com', step: 'not_a_real_step' });
    assertEqual(true, false, 'logAccountStep rejects an invalid step (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('invalid step'), true, 'logAccountStep rejects an invalid step');
  }

  const record = logAccountStep({ employer: 'Test Co', employerSlug: 'test-co', email: 'a@b.com', step: 'account_created' });
  assertEqual(record.step, 'account_created', 'logAccountStep persists a valid entry');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfTest();
}
