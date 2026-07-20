#!/usr/bin/env node
/**
 * apply-agent/submission-log.mjs — append-only audit log for every real submission
 *
 * Section 8 of the job-search-automation spec: "Every submission logs:
 * timestamp, before/after screenshot, exact form data submitted, resume
 * variant used. This is how silent failures get caught within a day instead
 * of three weeks of silence."
 *
 * One JSON-lines file (data/submission-log.jsonl, gitignored — user runtime
 * state), append-only so a partial/failed write never corrupts prior
 * entries. Screenshots are stored on disk (output/apply-screenshots/,
 * gitignored) and referenced by path, not inlined, to keep the log itself
 * small and diffable.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const APPLY_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(APPLY_AGENT_DIR);
const LOG_PATH = join(CAREER_OPS, 'data/submission-log.jsonl');
const SCREENSHOT_DIR = join(CAREER_OPS, 'output/apply-screenshots');

/**
 * @param {{
 *   company: string,
 *   role: string,
 *   url: string,
 *   reportRef: string|null,
 *   tier: 1|2,
 *   variant: 'A'|'B'|null,
 *   formData: Record<string, string>,
 *   beforeScreenshot: string,
 *   afterScreenshot: string,
 *   outcome: 'submitted'|'paused'|'failed',
 *   pauseReason?: string,
 * }} entry
 * @returns {object} the persisted record (with a generated timestamp)
 */
export function logSubmission(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('logSubmission requires an object');
  for (const field of ['company', 'role', 'url', 'tier', 'formData', 'outcome']) {
    if (entry[field] === undefined) throw new Error(`logSubmission: missing required field "${field}"`);
  }
  if (!['submitted', 'paused', 'failed'].includes(entry.outcome)) {
    throw new Error(`logSubmission: invalid outcome "${entry.outcome}"`);
  }

  const record = {
    timestamp: new Date().toISOString(),
    company: entry.company,
    role: entry.role,
    url: entry.url,
    reportRef: entry.reportRef ?? null,
    tier: entry.tier,
    variant: entry.variant ?? null,
    formData: entry.formData,
    beforeScreenshot: entry.beforeScreenshot ?? null,
    afterScreenshot: entry.afterScreenshot ?? null,
    outcome: entry.outcome,
    pauseReason: entry.pauseReason ?? null,
  };

  if (!existsSync(dirname(LOG_PATH))) mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
  return record;
}

export function screenshotDir() {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return SCREENSHOT_DIR;
}

export function screenshotPath(reportRef, phase) {
  return join(screenshotDir(), `${reportRef}-${phase}.png`);
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
    logSubmission({ company: 'Test Co' });
    assertEqual(true, false, 'logSubmission rejects a missing required field (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('missing required field'), true, 'logSubmission rejects a missing required field');
  }

  try {
    logSubmission({ company: 'Test Co', role: 'Test Role', url: 'https://example.com', tier: 1, formData: {}, outcome: 'bogus' });
    assertEqual(true, false, 'logSubmission rejects an invalid outcome (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('invalid outcome'), true, 'logSubmission rejects an invalid outcome');
  }

  const record = logSubmission({
    company: 'Test Co',
    role: 'Test Role',
    url: 'https://example.com/jobs/1',
    reportRef: '999',
    tier: 1,
    variant: 'A',
    formData: { name: 'Aditya Singh', email: 'aditherealone@gmail.com' },
    beforeScreenshot: 'output/apply-screenshots/999-before.png',
    afterScreenshot: 'output/apply-screenshots/999-after.png',
    outcome: 'submitted',
  });
  assertEqual(typeof record.timestamp === 'string', true, 'logSubmission stamps an ISO timestamp');
  assertEqual(record.outcome, 'submitted', 'logSubmission preserves the outcome field');
  assertEqual(existsSync(LOG_PATH), true, 'logSubmission writes to data/submission-log.jsonl');

  const dir = screenshotDir();
  assertEqual(existsSync(dir), true, 'screenshotDir() creates output/apply-screenshots/');
  assertEqual(screenshotPath('999', 'before'), join(dir, '999-before.png'), 'screenshotPath() builds the expected filename');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (left one "Test Co" self-test entry in data/submission-log.jsonl — harmless, append-only log)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
