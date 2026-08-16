#!/usr/bin/env node
/**
 * apply-agent/approve-for-apply.mjs — the human approval gate for unattended apply
 *
 * This is the ONE explicit action that turns a tracked job into something
 * apply-agent/run-approved.mjs is allowed to fill AND submit unattended, no
 * second per-form review (see AGENTS.md's Ethical Use section). Nothing
 * reaches data/apply-approved.json without this command (or the dashboard's
 * equivalent approve action) being run against a specific report number.
 *
 * Usage:
 *   node apply-agent/approve-for-apply.mjs <report#>
 *   node apply-agent/approve-for-apply.mjs --list
 *   node apply-agent/approve-for-apply.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';

import { writeFileAtomic, normalizeCompany } from '../tracker-utils.mjs';
import { loadBlacklist } from '../scan.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(DIR);
const QUEUE_PATH = join(CAREER_OPS, 'data/apply-approved.json');
const TRACKER_PATH = join(CAREER_OPS, 'data/applications.md');

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

/** Find the tracker row for a given report number. Returns null if not found. */
function findTrackerRow(reportNum) {
  if (!existsSync(TRACKER_PATH)) return null;
  const lines = readFileSync(TRACKER_PATH, 'utf-8').split('\n');
  const target = String(reportNum).replace(/^0+/, '') || '0';
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    const num = cells[1];
    if (!num || num.replace(/^0+/, '') !== target) continue;
    return {
      num: cells[1], date: cells[2], company: cells[3], role: cells[4],
      score: cells[5], status: cells[6], report: cells[8],
    };
  }
  return null;
}

function extractUrlFromReport(reportRelPath) {
  const full = join(CAREER_OPS, reportRelPath.replace(/^\.\.\//, ''));
  if (!existsSync(full)) return null;
  const text = readFileSync(full, 'utf-8');
  const m = /^\*\*URL:\*\*\s*(\S+)/m.exec(text);
  return m ? m[1] : null;
}

function extractReportLink(cell) {
  // "[002](../reports/002-elevenlabs-2026-07-20.md)" or "[002](reports/...)"
  const m = /\]\(([^)]+)\)/.exec(cell || '');
  return m ? m[1] : null;
}

export function approveForApply(reportNum) {
  const row = findTrackerRow(reportNum);
  if (!row) throw new Error(`No tracker row found for report #${reportNum}`);

  const reportRel = extractReportLink(row.report);
  const url = reportRel ? extractUrlFromReport(reportRel) : null;
  if (!url) throw new Error(`Could not resolve an application URL from report #${reportNum} (${row.report})`);

  const blacklist = loadBlacklist(join(CAREER_OPS, 'data/blacklist.md'));
  if (blacklist.size > 0 && blacklist.has(normalizeCompany(row.company))) {
    throw new Error(`${row.company} is on data/blacklist.md — refusing to approve for auto-apply`);
  }

  const scoreMatch = /([\d.]+)\s*\/\s*5/.exec(row.score || '');
  const score = scoreMatch ? Number(scoreMatch[1]) : null;

  const queue = loadQueue();
  const already = queue.find(e => e.reportRef === row.num && e.status === 'pending');
  if (already) return already;

  const entry = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    reportRef: row.num,
    company: row.company,
    role: row.role,
    score,
    url,
    status: 'pending', // pending | applied | skipped | failed
    outcome_reason: null,
  };
  queue.push(entry);
  saveQueue(queue);
  return entry;
}

export function listApproved({ status } = {}) {
  const queue = loadQueue();
  return status ? queue.filter(e => e.status === status) : queue;
}

/** Pull an entry back out before run-approved.mjs ever touches it. Never
 * deletes the row — marks it "dismissed" so the audit trail (who approved
 * what, and what got pulled back) stays intact. */
export function dismissApproved(id) {
  const queue = loadQueue();
  const entry = queue.find(e => e.id === id);
  if (!entry) return null;
  entry.status = 'dismissed';
  entry.updated_at = new Date().toISOString();
  saveQueue(queue);
  return entry;
}

// --- CLI ---
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    const entries = listApproved();
    if (entries.length === 0) console.log('(empty)');
    else for (const e of entries) console.log(`${e.id}  [${e.status}]  ${e.score != null ? e.score + '/5' : 'n/a'}  ${e.company} — ${e.role}`);
    return;
  }
  const dismissIdx = args.indexOf('--dismiss');
  if (dismissIdx !== -1) {
    const id = args[dismissIdx + 1];
    const entry = id ? dismissApproved(id) : null;
    if (!entry) {
      console.error(`No approved entry with id ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Pulled back: ${entry.company} — ${entry.role}`);
    return;
  }
  const reportNum = args[0];
  if (!reportNum) {
    console.error('Usage: node apply-agent/approve-for-apply.mjs <report#> | --list | --dismiss <id>');
    process.exitCode = 1;
    return;
  }
  try {
    const entry = approveForApply(reportNum);
    console.log(`Approved for auto-apply: ${entry.company} — ${entry.role} (${entry.id})`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
