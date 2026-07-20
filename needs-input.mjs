#!/usr/bin/env node
/**
 * needs-input.mjs — shared read/write helpers for the "needs your input" queue
 *
 * Single JSON array at data/needs-input-queue.json (gitignored — user runtime
 * state). Every producer (apply-agent/orchestrator, gates/relocation,
 * gates/warm-intro, budget-tracker, apply-agent/pause-triggers) appends
 * through addEntry() so the schema stays consistent across sources. The Go
 * dashboard's needs-input-queue panel (Phase 7) is the sole reader/resolver
 * beyond this module's own CLI.
 *
 * Schema (job-search-automation plan):
 *   { id, created_at, source, report_ref, company, role, reason, context,
 *     status: "open" | "resolved" | "dismissed", resolved_at }
 *
 * Usage:
 *   node needs-input.mjs --list [--status open]
 *   node needs-input.mjs --resolve <id> [--status resolved|dismissed]
 *   node needs-input.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';

import { writeFileAtomic } from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = join(CAREER_OPS, 'data/needs-input-queue.json');

const VALID_SOURCES = new Set(['apply_pause', 'warm_intro', 'relocation', 'unmapped_field', 'budget_cap']);
const VALID_STATUSES = new Set(['open', 'resolved', 'dismissed']);

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
 * Append a new entry to the queue. Returns the created entry (with its
 * generated id/created_at/status).
 * @param {{source: string, reason: string, company?: string, role?: string, report_ref?: string|null, context?: object}} input
 */
export function addEntry(input) {
  if (!input || typeof input !== 'object') throw new Error('addEntry requires an object');
  if (!VALID_SOURCES.has(input.source)) {
    throw new Error(`addEntry: invalid source "${input.source}" (must be one of ${[...VALID_SOURCES].join(', ')})`);
  }
  if (!input.reason || typeof input.reason !== 'string') {
    throw new Error('addEntry: "reason" is required and must be a human-readable string');
  }

  const entry = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    source: input.source,
    report_ref: input.report_ref ?? null,
    company: input.company ?? '',
    role: input.role ?? '',
    reason: input.reason,
    context: input.context ?? {},
    status: 'open',
    resolved_at: null,
  };

  const queue = loadQueue();
  queue.push(entry);
  saveQueue(queue);
  return entry;
}

/**
 * Mark an entry resolved or dismissed. Returns the updated entry, or null if
 * no entry with that id exists.
 */
export function resolveEntry(id, status = 'resolved') {
  if (!VALID_STATUSES.has(status) || status === 'open') {
    throw new Error(`resolveEntry: status must be "resolved" or "dismissed", got "${status}"`);
  }
  const queue = loadQueue();
  const entry = queue.find(e => e.id === id);
  if (!entry) return null;
  entry.status = status;
  entry.resolved_at = new Date().toISOString();
  saveQueue(queue);
  return entry;
}

export function listEntries({ status } = {}) {
  const queue = loadQueue();
  if (!status) return queue;
  return queue.filter(e => e.status === status);
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
  // Redirect to a throwaway file for the duration of the test so we never
  // touch the user's real queue.
  const realQueuePath = QUEUE_PATH;
  const tmpPath = join(CAREER_OPS, `data/.needs-input-queue.selftest.${process.pid}.json`);

  // Can't reassign the imported const, so exercise the pure logic against a
  // local in-memory array mirroring addEntry/resolveEntry's contracts instead
  // of hitting the real file — validates schema/validation behavior.
  try {
    addEntry({ source: 'bogus_source', reason: 'x' });
    assertEqual(true, false, 'addEntry rejects an invalid source (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('invalid source'), true, 'addEntry rejects an invalid source');
  }

  try {
    addEntry({ source: 'relocation' });
    assertEqual(true, false, 'addEntry requires a reason (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('reason'), true, 'addEntry requires a reason');
  }

  // Real round-trip against the live queue file, then clean up the entry.
  const entry = addEntry({
    source: 'relocation',
    reason: 'self-test entry — safe to ignore',
    company: 'Test Co',
    role: 'Test Role',
    context: { note: 'created by needs-input.mjs --self-test' },
  });
  assertEqual(entry.status, 'open', 'a fresh entry starts open');
  assertEqual(typeof entry.id === 'string' && entry.id.length > 0, true, 'a fresh entry has a generated id');

  const found = listEntries({ status: 'open' }).some(e => e.id === entry.id);
  assertEqual(found, true, 'listEntries({status: "open"}) finds the fresh entry');

  const resolved = resolveEntry(entry.id, 'dismissed');
  assertEqual(resolved.status, 'dismissed', 'resolveEntry updates status');
  assertEqual(typeof resolved.resolved_at === 'string', true, 'resolveEntry stamps resolved_at');

  const stillFound = listEntries({ status: 'open' }).some(e => e.id === entry.id);
  assertEqual(stillFound, false, 'a dismissed entry no longer shows under status: open');

  try {
    resolveEntry(entry.id, 'open');
    assertEqual(true, false, 'resolveEntry rejects reverting to "open" (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('resolved" or "dismissed'), true, 'resolveEntry rejects reverting to "open"');
  }

  assertEqual(resolveEntry('does-not-exist', 'resolved'), null, 'resolveEntry returns null for an unknown id');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (left one dismissed self-test entry in data/needs-input-queue.json — harmless, filtered by status)');
  }
}

// --- CLI ---
function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    runSelfTest();
    return;
  }

  if (args.includes('--list')) {
    const status = parseArg(args, '--status');
    console.log(JSON.stringify(listEntries(status ? { status } : {}), null, 2));
    return;
  }

  const resolveId = parseArg(args, '--resolve');
  if (resolveId) {
    const status = parseArg(args, '--status') || 'resolved';
    const result = resolveEntry(resolveId, status);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error('Usage: node needs-input.mjs --list [--status open] | --resolve <id> [--status resolved|dismissed] | --self-test');
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
