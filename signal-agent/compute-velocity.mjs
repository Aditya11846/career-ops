#!/usr/bin/env node
/**
 * signal-agent/compute-velocity.mjs — job-posting velocity signal
 *
 * Free, zero-cost, zero-LLM 5th sub-score for compute-heat.mjs's composite
 * company_heat. Rated the single strongest signal in the original
 * relationship-pipeline-signals.md research (better than funding/reddit/
 * linkedin), because it's derived entirely from data/scan-history.tsv —
 * which career-ops's own scan.mjs already writes on every run. No new
 * infrastructure, no new API, no WebSearch cost.
 *
 * The naive version (raw count of "added" rows in a lookback window) is
 * mostly repost noise — the same role re-listed looks identical to genuine
 * hiring growth. Fixed the same way detect-reposts.mjs already solves this
 * exact problem: fuzzy-cluster a company's postings by title (roleFuzzyMatch),
 * take each cluster's EARLIEST first_seen as that role's "birth date," and
 * only count a cluster as "new" if its birth date falls inside the lookback
 * window. A repost of an old role has an old birth date, so it never counts
 * as new no matter how many times it resurfaces.
 *
 * Usage:
 *   node signal-agent/compute-velocity.mjs --company "Acme Inc" [--lookback-days 14]
 *   node signal-agent/compute-velocity.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { normalizeCompany } from '../tracker-utils.mjs';
import { parseScanHistory } from '../detect-reposts.mjs';
import { roleFuzzyMatch } from '../role-matcher.mjs';

const SIGNAL_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(SIGNAL_AGENT_DIR);
const SCAN_HISTORY_PATH = join(CAREER_OPS, 'data/scan-history.tsv');

const DEFAULT_LOOKBACK_DAYS = 14;

function daysBetween(d1, d2) {
  return Math.abs(Math.round((d2.getTime() - d1.getTime()) / 86400000));
}

function loadScanHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) return [];
  return parseScanHistory(readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
}

// Same 0/25/50/75/100 anchor shape signal-agent already uses for the
// agent-researched signals (see sources/funding-news.md's rubric) — 0 new
// roles this window = no momentum, 11+ = strong active growth.
function bucketScore(newRoleCount) {
  if (newRoleCount === 0) return 0;
  if (newRoleCount <= 2) return 25;
  if (newRoleCount <= 5) return 50;
  if (newRoleCount <= 10) return 75;
  return 100;
}

/**
 * Compute a company's job-posting velocity: how many DISTINCT roles (not
 * reposts) were first seen within `lookbackDays` of `asOf`. `rows` and `asOf`
 * are injectable for testing without touching the real scan-history file or
 * depending on the real system clock.
 *
 * INSUFFICIENT-HISTORY GUARD (real, not hypothetical — caught live 2026-07-29):
 * scan-history.tsv only starts accumulating once scan.mjs first runs. If the
 * company's OWN earliest recorded posting is itself younger than
 * `lookbackDays`, every single one of its currently-open roles necessarily
 * has a "first seen" date inside the window — not because hiring is
 * accelerating, but because that's simply when scanning began. Confirmed on
 * real data: Broadcom scored newRoleCount=213/score=100 on a scan-history
 * file that only spans 2 days total (2026-07-27 to 2026-07-28) — a
 * confidently-wrong signal, not a genuine one. Returning a real number here
 * would be indistinguishable from a true high-velocity reading, so this
 * returns an explicit `insufficientHistory: true, score: null` instead —
 * same "honest null over a guess" discipline githubActivityScore already
 * uses on a failed API call.
 */
export function jobPostingVelocity(company, { rows, lookbackDays = DEFAULT_LOOKBACK_DAYS, asOf = new Date() } = {}) {
  const all = (rows ?? loadScanHistory()).filter(
    (r) => r && r.status === 'added' && r.company && r.title && r.date instanceof Date && !Number.isNaN(r.date.getTime()) && normalizeCompany(r.company) === normalizeCompany(company),
  );
  if (all.length === 0) return { newRoleCount: 0, score: 0, insufficientHistory: false };

  const earliestEverSeen = all.reduce((min, r) => (r.date < min ? r.date : min), all[0].date);
  if (daysBetween(earliestEverSeen, asOf) < lookbackDays) {
    return { newRoleCount: null, score: null, insufficientHistory: true };
  }

  // Single-linkage cluster by fuzzy title match, same technique
  // detect-reposts.mjs uses per-company (title-only here; detect-reposts.mjs's
  // sliding time-window is for a different purpose — deciding whether a
  // fuzzy-title match is temporally a "repost" — we only need the cluster's
  // earliest date here, not a repost verdict).
  const clusters = [];
  const used = new Set();
  for (const row of all) {
    if (used.has(row)) continue;
    const group = [row];
    used.add(row);
    for (const other of all) {
      if (used.has(other)) continue;
      if (row.title.toLowerCase() === other.title.toLowerCase() || roleFuzzyMatch(row.title, other.title)) {
        group.push(other);
        used.add(other);
      }
    }
    clusters.push(group);
  }

  let newRoleCount = 0;
  for (const cluster of clusters) {
    const earliest = cluster.reduce((min, r) => (r.date < min ? r.date : min), cluster[0].date);
    if (daysBetween(earliest, asOf) <= lookbackDays) newRoleCount++;
  }

  return { newRoleCount, score: bucketScore(newRoleCount), insufficientHistory: false };
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

function row({ url, date, title, company = 'Acme', status = 'added' }) {
  return { url, date: new Date(date), dateStr: date, title, company, status, portal: '', location: '' };
}

function runSelfTest() {
  const asOf = new Date('2026-07-29');
  // Every non-empty test dataset below needs an OLD anchor row (well before
  // the lookback window) so the insufficient-history guard doesn't fire and
  // mask the actual assertion under test -- a distinct, unrelated title so
  // it forms its own cluster and never merges into the roles being tested.
  const anchor = (company = 'Acme') => row({ url: `anchor-${company}`, date: '2026-01-01', title: 'Ancient Unrelated Baseline Role Marker Zyzzyva', company });

  assertEqual(jobPostingVelocity('Acme', { rows: [], asOf }), { newRoleCount: 0, score: 0, insufficientHistory: false }, 'empty history -> zero, not thrown');

  // The exact real bug found live 2026-07-29: a company whose OWN earliest
  // recorded posting is itself inside the lookback window (i.e. we started
  // scanning them too recently to know if this is real growth or just "we
  // just started looking") must return insufficientHistory, NOT a number
  // that looks like a genuine high-velocity reading.
  const tooYoungHistory = [
    row({ url: 'y1', date: '2026-07-20', title: 'Staff Security Engineer' }),
    row({ url: 'y2', date: '2026-07-25', title: 'Senior Platform Engineer' }),
  ];
  assertEqual(jobPostingVelocity('Acme', { rows: tooYoungHistory, asOf }), { newRoleCount: null, score: null, insufficientHistory: true }, 'scan history younger than the lookback window -> honest insufficientHistory, not a confident-looking number');

  const genuinelyNew = [anchor(), ...tooYoungHistory];
  assertEqual(jobPostingVelocity('Acme', { rows: genuinelyNew, asOf }), { newRoleCount: 2, score: 25, insufficientHistory: false }, '2 genuinely distinct new roles both count once history is old enough to trust');

  // A role reposted 3 times in the window should count as ONE new role, not 3 —
  // this is the exact repost-noise problem the whole module exists to fix.
  const repostedOnce = [
    anchor(),
    row({ url: 'b1', date: '2026-07-18', title: 'Cybersecurity Engineer' }),
    row({ url: 'b2', date: '2026-07-22', title: 'Cybersecurity Engineer' }),
    row({ url: 'b3', date: '2026-07-27', title: 'Cybersecurity Engineer' }),
  ];
  assertEqual(jobPostingVelocity('Acme', { rows: repostedOnce, asOf }), { newRoleCount: 1, score: 25, insufficientHistory: false }, 'a role reposted 3x in-window counts ONCE, not 3');

  // A role whose EARLIEST appearance is long before the lookback window, even
  // if it resurfaced recently, must NOT count as new -- old birth date wins.
  // (This dataset's own old row also satisfies the history guard, no
  // separate anchor needed.)
  const oldRoleResurfaced = [
    row({ url: 'c1', date: '2026-01-05', title: 'Principal Security Architect' }),
    row({ url: 'c2', date: '2026-07-26', title: 'Principal Security Architect' }),
  ];
  assertEqual(jobPostingVelocity('Acme', { rows: oldRoleResurfaced, asOf, lookbackDays: 14 }), { newRoleCount: 0, score: 0, insufficientHistory: false }, 'an old role resurfacing recently does NOT count as new (birth date is old)');

  // Company filter is case/punctuation-insensitive via normalizeCompany, and
  // rows for OTHER companies must never leak into this company's count.
  const mixedCompanies = [
    anchor('ACME, INC.'),
    row({ url: 'd1', date: '2026-07-24', title: 'SRE', company: 'ACME, INC.' }),
    row({ url: 'd2', date: '2026-07-24', title: 'SRE', company: 'Some Other Co' }),
  ];
  assertEqual(jobPostingVelocity('Acme Inc', { rows: mixedCompanies, asOf }), { newRoleCount: 1, score: 25, insufficientHistory: false }, 'company filter is normalize-insensitive and excludes other companies');

  // Skipped/expired rows (status !== 'added') must not count as postings.
  const skippedRow = [anchor(), row({ url: 'e1', date: '2026-07-24', title: 'SRE', status: 'skipped_expired' })];
  assertEqual(jobPostingVelocity('Acme', { rows: skippedRow, asOf }), { newRoleCount: 0, score: 0, insufficientHistory: false }, 'non-"added" status rows are excluded');

  // Bucket boundaries. Titles here are deliberately unrelated roles (not a
  // templated near-duplicate string), so roleFuzzyMatch's Jaccard/seniority
  // overlap logic can't accidentally cluster them into fewer than 11 groups
  // -- that would silently make this assertion meaningless.
  const distinctTitles = [
    'Software Engineer', 'Product Manager', 'Data Scientist', 'DevOps Engineer', 'UX Designer',
    'Sales Director', 'Technical Recruiter', 'Financial Analyst', 'Marketing Manager', 'Customer Success Manager',
    'Legal Counsel',
  ];
  const many = [anchor(), ...distinctTitles.map((title, i) => row({ url: `f${i}`, date: '2026-07-25', title }))];
  const manyResult = jobPostingVelocity('Acme', { rows: many, asOf });
  assertEqual(manyResult.newRoleCount, 11, '11 genuinely unrelated titles stay 11 distinct clusters, not fuzzy-merged');
  assertEqual(manyResult.score, 100, '11+ distinct new roles -> top bucket (100)');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
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
  const company = parseArg(args, '--company');
  if (!company) {
    console.error('Usage: node signal-agent/compute-velocity.mjs --company "Name" [--lookback-days N]');
    process.exitCode = 1;
    return;
  }
  const lookbackDays = Number(parseArg(args, '--lookback-days') ?? DEFAULT_LOOKBACK_DAYS);
  console.log(JSON.stringify(jobPostingVelocity(company, { lookbackDays }), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
