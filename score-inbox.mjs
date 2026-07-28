#!/usr/bin/env node
/**
 * score-inbox.mjs — cheap, automatic fit ranking for every pending posting in
 * data/pipeline.md, so the dashboard's Inbox tab can sort by relevance
 * instead of only freshness.
 *
 * Runs AFTER filter-inbox-by-fit.mjs (which already decided what's relevant
 * enough to be in the Pending section at all, via its own lower,
 * title-calibrated TITLE_FIT_MIN_SCORE). This script doesn't filter anything
 * further — it ranks what's already there, using compute-fit.mjs's
 * computeInboxRank() (title+location domain fit + company stability from
 * signal-agent's stored data, real comp/hireability being unavailable at
 * scan time for virtually every posting).
 *
 * Writes to data/posting-signals.json, keyed by URL — mirrors
 * signal-agent/compute-heat.mjs's read/write/atomic-write shape exactly.
 * Gitignored alongside pipeline.md/pipeline-filtered.md (personal data).
 *
 * Usage:
 *   node score-inbox.mjs [--dry-run] [--summary]
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { scoreDomainFit, computeInboxRank } from './compute-fit.mjs';
import { readCompanySignal } from './signal-agent/compute-heat.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const SIGNALS_PATH = join(ROOT, 'data/posting-signals.json');

const PENDING_MARKERS = ['## Pending', '## Pendientes'];

function parseCheckboxLine(line) {
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const parts = m[2].split('|').map(s => s.trim());
  if (parts.length < 3 || !parts[0]) return null;
  return { url: parts[0], company: parts[1], role: parts[2], location: parts[3] || '' };
}

function findPendingSectionBounds(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PENDING_MARKERS.includes(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function loadPostingSignals() {
  if (!existsSync(SIGNALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const summaryOnly = args.includes('--summary');

  if (!existsSync(PIPELINE_PATH)) {
    console.log('data/pipeline.md not found — nothing to score.');
    return;
  }

  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const bounds = findPendingSectionBounds(lines);
  if (!bounds) {
    console.log('No "## Pending" section found — nothing to score.');
    return;
  }

  const entries = [];
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const parsed = parseCheckboxLine(lines[i]);
    if (parsed) entries.push(parsed);
  }

  const results = {};
  for (const entry of entries) {
    const domainFit = scoreDomainFit(`${entry.role} ${entry.location}`);
    const signal = readCompanySignal(entry.company);
    const heat = typeof signal?.heat === 'number' ? signal.heat : null;
    const layoffRisk = typeof signal?.layoff_risk === 'number' ? signal.layoff_risk : null;
    const { rank } = computeInboxRank({ domainFit, heat, layoffRisk });
    results[entry.url] = { company: entry.company, role: entry.role, domainFit, rank, updatedAt: new Date().toISOString() };
  }

  const ranked = Object.entries(results).sort((a, b) => b[1].rank - a[1].rank);

  if (summaryOnly) {
    console.log(`Scored ${ranked.length} pending entries.`);
    return;
  }

  console.log(`Scored ${ranked.length} pending entries.`);
  for (const [, r] of ranked.slice(0, 10)) {
    console.log(`  ${r.rank} — ${r.company} | ${r.role}`);
  }

  if (dryRun) {
    console.log('\n(dry run — no files written)');
    return;
  }

  writeFileAtomic(SIGNALS_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nWrote data/posting-signals.json (${ranked.length} entries).`);
}

main();
