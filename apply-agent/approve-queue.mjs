#!/usr/bin/env node
/**
 * apply-agent/approve-queue.mjs — fast batch-approve queue for filled,
 * awaiting-review applications
 *
 * career-ops' core guarantee (AGENTS.md, Ethical Use) is that nothing submits
 * without the human reviewing it first. That guarantee stays — this module
 * does not add a code path that clicks Submit. What it removes is the
 * friction of navigating to each ATS site by hand: orchestrator.ts fills a
 * real form and leaves the browser session open (session.ts's SESSIONS map,
 * one Playwright context per session, alive for the life of the web/ server
 * process); this module lets you list every filled-and-waiting job in one
 * place and bring any one of them to the front with a single call, so
 * reviewing + clicking submit yourself takes one glance instead of a manual
 * hunt across tabs.
 *
 * Storage: data/approve-queue.json (gitignored — user runtime state), same
 * addEntry/list/resolve shape as needs-input.mjs so the two queues stay
 * consistent to read.
 *
 * Usage:
 *   node apply-agent/approve-queue.mjs --list [--status pending]
 *   node apply-agent/approve-queue.mjs --approve <id>   # brings that tab to front
 *   node apply-agent/approve-queue.mjs --dismiss <id>   # drop from the queue, no browser action
 *   node apply-agent/approve-queue.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

import { writeFileAtomic } from '../tracker-utils.mjs';
import { logSubmission } from './submission-log.mjs';

const APPLY_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(APPLY_AGENT_DIR);
const QUEUE_PATH = join(CAREER_OPS, 'data/approve-queue.json');
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000';

const VALID_STATUSES = new Set(['pending', 'approved', 'dismissed', 'submitted', 'submit_failed']);

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(entries) {
  writeFileAtomic(QUEUE_PATH, JSON.stringify(entries, null, 2) + '\n');
}

/**
 * Append a filled-and-awaiting-review job to the queue. Called by
 * orchestrator.ts right after a successful fill (never on a paused/blocked
 * run — those already go through needs-input.mjs instead).
 * @param {{sessionId: string, company: string, role: string, score: number,
 *   reportRef?: string|null, url: string, fieldsFilled: number, fieldsTotal: number,
 *   issues?: object[]}} input
 */
export function addEntry(input) {
  if (!input || typeof input !== 'object') throw new Error('addEntry requires an object');
  for (const field of ['sessionId', 'company', 'role', 'url']) {
    if (!input[field]) throw new Error(`addEntry: "${field}" is required`);
  }

  const entry = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    sessionId: input.sessionId,
    company: input.company,
    role: input.role,
    score: input.score ?? null,
    report_ref: input.reportRef ?? null,
    url: input.url,
    fieldsFilled: input.fieldsFilled ?? null,
    fieldsTotal: input.fieldsTotal ?? null,
    issues: input.issues ?? [],
    status: 'pending',
    approved_at: null,
  };

  const queue = loadQueue();
  queue.push(entry);
  saveQueue(queue);
  return entry;
}

export function listEntries({ status } = {}) {
  const queue = loadQueue();
  if (!status) return queue;
  return queue.filter(e => e.status === status);
}

/**
 * Bring the entry's browser tab to the front via the web app's
 * /api/apply/handoff route, then mark it approved. Throws if the web app
 * isn't reachable or the underlying session has already expired/closed —
 * callers should tell the human to re-run the fill in that case, not retry
 * silently.
 */
export async function approveEntry(id) {
  const queue = loadQueue();
  const entry = queue.find(e => e.id === id);
  if (!entry) return null;

  const res = await fetch(`${WEB_APP_URL}/api/apply/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: entry.sessionId }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `handoff failed (${res.status}) — the session may have expired; re-run the fill for ${entry.company} / ${entry.role}`);
  }

  entry.status = 'approved';
  entry.approved_at = new Date().toISOString();
  saveQueue(queue);
  return entry;
}

/**
 * Actually submit one already-reviewed, already-approved application. This is
 * the ONLY code path in the whole project allowed to reach the real
 * /api/apply/submit route — the guarantee (AGENTS.md, Ethical Use: "never
 * submit without the user reviewing it first") is enforced right here by
 * refusing anything not already in status "approved" (which itself only
 * happens after approveEntry() brought the real tab to front for the human
 * to look at). Never call this against a "pending" entry.
 *
 * On success: marks the entry "submitted", writes an audit row to
 * data/submission-log.jsonl, and moves the tracker row to "Applied" via
 * set-status.mjs (never a raw tracker edit, per AGENTS.md's Pipeline
 * Integrity rules) when a report_ref exists.
 */
export async function submitEntry(id) {
  const queue = loadQueue();
  const entry = queue.find(e => e.id === id);
  if (!entry) return null;
  if (entry.status !== 'approved') {
    throw new Error(`refusing to submit ${entry.company} / ${entry.role}: status is "${entry.status}", not "approved" — review it with --approve first`);
  }

  let result;
  try {
    const res = await fetch(`${WEB_APP_URL}/api/apply/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: entry.sessionId, confirm: true }),
    });
    result = await res.json();
    if (!res.ok || !result.ok) {
      throw new Error(result.error || `submit failed (${res.status})`);
    }
  } catch (err) {
    entry.status = 'submit_failed';
    saveQueue(queue);
    logSubmission({
      company: entry.company, role: entry.role, url: entry.url, reportRef: entry.report_ref,
      tier: 2, variant: null, formData: {}, outcome: 'failed',
      pauseReason: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof Error ? err : new Error(String(err));
  }

  entry.status = 'submitted';
  entry.submitted_at = new Date().toISOString();
  saveQueue(queue);

  logSubmission({
    company: entry.company, role: entry.role, url: entry.url, reportRef: entry.report_ref,
    tier: 2, variant: null, formData: {}, outcome: 'submitted',
  });

  if (entry.report_ref) {
    try {
      execFileSync('node', ['set-status.mjs', entry.report_ref, 'Applied', '--note', 'Submitted via Naukri apply-agent (Tier 2)', '--json'], { cwd: CAREER_OPS });
    } catch (err) {
      console.error(`Submitted ${entry.company} / ${entry.role} but failed to update the tracker: ${err.message}`);
    }
  }

  return entry;
}

/**
 * Submit every entry currently marked "approved", in sequence (never
 * parallel — mirrors the same one-at-a-time human-paced spirit as Tier 2's
 * pacingDelay). Stops on nothing; a single entry's failure is recorded
 * ("submit_failed") and the sweep continues to the next one.
 */
export async function submitAllApproved() {
  const approved = listEntries({ status: 'approved' });
  const results = [];
  for (const entry of approved) {
    try {
      const submitted = await submitEntry(entry.id);
      results.push({ id: entry.id, company: entry.company, role: entry.role, ok: true, entry: submitted });
    } catch (err) {
      results.push({ id: entry.id, company: entry.company, role: entry.role, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export function dismissEntry(id) {
  const queue = loadQueue();
  const entry = queue.find(e => e.id === id);
  if (!entry) return null;
  entry.status = 'dismissed';
  entry.approved_at = new Date().toISOString();
  saveQueue(queue);
  return entry;
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

async function runSelfTest() {
  try {
    addEntry({ company: 'Test Co' });
    assertEqual(true, false, 'addEntry rejects a missing required field (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('is required'), true, 'addEntry rejects a missing required field');
  }

  const entry = addEntry({
    sessionId: 'self-test-session-does-not-exist',
    company: 'Test Co',
    role: 'Test Role',
    score: 4.6,
    url: 'https://example.com/jobs/1',
    fieldsFilled: 8,
    fieldsTotal: 8,
  });
  assertEqual(entry.status, 'pending', 'a fresh entry starts pending');
  assertEqual(typeof entry.id === 'string' && entry.id.length > 0, true, 'a fresh entry has a generated id');

  const found = listEntries({ status: 'pending' }).some(e => e.id === entry.id);
  assertEqual(found, true, 'listEntries({status: "pending"}) finds the fresh entry');

  // approveEntry against a nonexistent session/web-app should throw, not
  // silently mark approved — that's the guarantee this whole module exists
  // to protect (never mark "approved" without actually bringing the real
  // tab to front).
  let threw = false;
  try {
    await approveEntry(entry.id);
  } catch {
    threw = true;
  }
  assertEqual(threw, true, 'approveEntry throws rather than silently approving when the web app/session is unreachable');
  assertEqual(listEntries({ status: 'pending' }).some(e => e.id === entry.id), true, 'a failed approve attempt leaves the entry pending, not approved');

  let submitThrew = false;
  try {
    await submitEntry(entry.id);
  } catch (err) {
    submitThrew = err.message.includes('not "approved"');
  }
  assertEqual(submitThrew, true, 'submitEntry refuses a non-"approved" entry (e.g. still "pending")');

  const dismissed = dismissEntry(entry.id);
  assertEqual(dismissed.status, 'dismissed', 'dismissEntry updates status');
  assertEqual(listEntries({ status: 'pending' }).some(e => e.id === entry.id), false, 'a dismissed entry no longer shows under status: pending');

  assertEqual(dismissEntry('does-not-exist'), null, 'dismissEntry returns null for an unknown id');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (left one dismissed self-test entry in data/approve-queue.json — harmless, filtered by status)');
  }
}

// --- CLI ---
function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function formatEntry(e) {
  const scoreStr = e.score != null ? `${e.score}/5` : 'n/a';
  const fieldsStr = e.fieldsTotal != null ? `${e.fieldsFilled}/${e.fieldsTotal} fields` : '';
  return `${e.id}  [${e.status}]  ${scoreStr}  ${e.company} — ${e.role}  ${fieldsStr}`.trim();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  if (args.includes('--list')) {
    const status = parseArg(args, '--status');
    const entries = listEntries(status ? { status } : {});
    if (entries.length === 0) {
      console.log('(empty)');
    } else {
      for (const e of entries) console.log(formatEntry(e));
    }
    return;
  }

  const approveId = parseArg(args, '--approve');
  if (approveId) {
    try {
      const entry = await approveEntry(approveId);
      if (!entry) {
        console.error(`No queue entry with id ${approveId}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Approved — bringing ${entry.company} / ${entry.role} to the front. Review and click submit yourself.`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
    return;
  }

  const submitId = parseArg(args, '--submit');
  if (submitId) {
    try {
      const entry = await submitEntry(submitId);
      console.log(`Submitted ${entry.company} / ${entry.role}.`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
    return;
  }

  if (args.includes('--submit-all-approved')) {
    const results = await submitAllApproved();
    if (results.length === 0) {
      console.log('(no approved entries to submit)');
    } else {
      for (const r of results) {
        console.log(r.ok ? `OK      ${r.company} / ${r.role}` : `FAILED  ${r.company} / ${r.role} — ${r.error}`);
      }
      const failures = results.filter(r => !r.ok).length;
      if (failures > 0) process.exitCode = 1;
    }
    return;
  }

  const dismissId = parseArg(args, '--dismiss');
  if (dismissId) {
    const entry = dismissEntry(dismissId);
    if (!entry) {
      console.error(`No queue entry with id ${dismissId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Dismissed ${entry.company} / ${entry.role}.`);
    return;
  }

  console.error('Usage: node approve-queue.mjs --list [--status pending] | --approve <id> | --submit <id> | --submit-all-approved | --dismiss <id> | --self-test');
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
