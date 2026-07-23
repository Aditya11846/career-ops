#!/usr/bin/env node
/**
 * apply-agent/run-approved.mjs — drains data/apply-approved.json unattended
 *
 * The ONLY consumer of the approved-for-apply queue. Every entry it touches
 * was put there by an explicit human action (apply-agent/approve-for-apply.mjs
 * or the dashboard's approve action) — that approval is the human gate; this
 * worker fills AND submits (no second per-form review) for a clean fill, per
 * AGENTS.md's Ethical Use section. Genuine blockers (login-wall, unmapped
 * fields, ambiguous salary fields, a non-clean fill) still pause to
 * data/needs-input.md / apply-agent/approve-queue.mjs, same as before.
 *
 * Platform routing:
 *   - linkedin.com          -> skipped, marked "skipped" (LinkedIn Tier 2 is
 *                              closed-by-design; this project won't evade its
 *                              anti-automation detection, see f414feb)
 *   - naukri.com            -> Tier 2 driver-core.mjs (session-store login),
 *                              autoSubmit: true
 *   - everything else       -> Tier 1 orchestrator.ts (public ATS forms, no
 *                              login), --auto-submit
 *
 * Usage:
 *   node apply-agent/run-approved.mjs
 *   node apply-agent/run-approved.mjs --dry-run   # print what would run, touch nothing
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

import { readdirSync } from 'fs';
import { writeFileAtomic } from '../tracker-utils.mjs';
import { runTier2Apply, pacingDelay } from './tier2/driver-core.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(DIR);
const QUEUE_PATH = join(CAREER_OPS, 'data/apply-approved.json');
const OUTPUT_DIR = join(CAREER_OPS, 'output');

/**
 * Mirrors web/src/lib/apply/cv.ts's resolveTailoredCv() matching logic (company
 * name -> slug -> filename substring match) so run-approved.mjs can check for a
 * tailored CV BEFORE opening a real apply session, not just log a silent gap
 * once the résumé field goes unfilled. PDF generation itself (the `pdf` mode)
 * is an LLM-driven pipeline (JD tailoring + a fact-verification gate) — not
 * something safe to fire unattended as a nested headless agent from here, so
 * a missing CV fails fast with an actionable message instead of applying with
 * no résumé attached or silently spawning a costly subprocess.
 */
function hasTailoredCv(company) {
  const c = (company || '').trim();
  if (!c) return false;
  let files;
  try {
    files = readdirSync(OUTPUT_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  } catch {
    return false;
  }
  const slug = (c.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-');
  const first = slug.split('-')[0];
  return files.some(f => {
    const l = f.toLowerCase();
    return l.includes(slug) || (first.length > 2 && l.includes(first));
  });
}

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

function platformFor(url) {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
    if (/(^|\.)naukri\.com$/.test(host)) return 'naukri';
    return 'tier1';
  } catch {
    return 'tier1';
  }
}

function markStatus(queue, entry, status, reason = null) {
  entry.status = status;
  entry.outcome_reason = reason;
  entry.updated_at = new Date().toISOString();
  saveQueue(queue);
}

function updateTrackerApplied(reportRef, note) {
  if (!reportRef) return;
  try {
    execFileSync('node', ['set-status.mjs', reportRef, 'Applied', '--note', note, '--json'], { cwd: CAREER_OPS });
  } catch (err) {
    console.error(`Applied but failed to update the tracker for report #${reportRef}: ${err.message}`);
  }
}

async function runTier1(entry, dryRun) {
  const args = [
    'tsx', 'apply-agent/orchestrator.ts',
    '--url', entry.url,
    '--score', String(entry.score ?? 0),
    '--company', entry.company,
    '--role', entry.role,
    '--auto-submit',
  ];
  if (entry.reportRef) args.push('--report', entry.reportRef);
  if (dryRun) {
    console.log(`[dry-run] would run: npx ${args.join(' ')}`);
    return { decision: 'dry-run' };
  }
  const out = execFileSync('npx', args, { cwd: CAREER_OPS, encoding: 'utf-8' });
  // orchestrator.ts prints exactly one pretty-printed (multi-line) JSON
  // object via console.log per run — everything else is console.error
  // (stderr), so stdout is that JSON object and nothing else.
  return JSON.parse(out.trim());
}

async function runNaukri(entry, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] would run Tier 2 Naukri apply for ${entry.company} / ${entry.role}`);
    return { decision: 'dry-run' };
  }
  return runTier2Apply({
    platform: 'naukri', url: entry.url, company: entry.company, role: entry.role,
    reportRef: entry.reportRef, autoSubmit: true,
  });
}

export async function runApproved({ dryRun = false } = {}) {
  const queue = loadQueue();
  const pending = queue.filter(e => e.status === 'pending');
  const results = [];

  for (const entry of pending) {
    const platform = platformFor(entry.url);

    if (platform === 'linkedin') {
      if (!dryRun) markStatus(queue, entry, 'skipped', 'linkedin_blocked_by_design');
      results.push({ entry, decision: 'skipped', reason: 'linkedin_blocked_by_design' });
      continue;
    }

    if (!hasTailoredCv(entry.company)) {
      const reason = `no tailored CV found in output/ for "${entry.company}" — run the pdf mode for report #${entry.reportRef || '?'} first, then re-run`;
      if (!dryRun) markStatus(queue, entry, 'failed', reason);
      results.push({ entry, decision: 'failed', reason });
      continue;
    }

    let result;
    try {
      result = platform === 'naukri' ? await runNaukri(entry, dryRun) : await runTier1(entry, dryRun);
    } catch (err) {
      if (!dryRun) markStatus(queue, entry, 'failed', err instanceof Error ? err.message : String(err));
      results.push({ entry, decision: 'failed', reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    if (dryRun) {
      results.push({ entry, decision: result.decision });
      continue;
    }

    if (result.decision === 'submitted') {
      markStatus(queue, entry, 'applied');
      updateTrackerApplied(entry.reportRef, 'Submitted via apply-agent (unattended, human-approved)');
    } else {
      // paused / filled-awaiting-human-review / draft-only — leave the
      // approved-queue entry as "pending" so a later run (once the human
      // resolves whatever needs-input/approve-queue entry it produced) can
      // pick it back up, rather than silently dropping it.
      results.push({ entry, decision: result.decision, note: 'left pending — see data/needs-input.md / apply-agent/approve-queue.mjs' });
      continue;
    }

    results.push({ entry, decision: result.decision });
    await pacingDelay();
  }

  return results;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const results = await runApproved({ dryRun });
  if (results.length === 0) {
    console.log('(no pending approved entries)');
    return;
  }
  for (const r of results) {
    console.log(`${r.decision.toUpperCase().padEnd(24)} ${r.entry.company} — ${r.entry.role}${r.reason ? `  (${r.reason})` : ''}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
