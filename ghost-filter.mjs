#!/usr/bin/env node
/**
 * ghost-filter.mjs — Ghost/fake-listing detector for career-ops
 *
 * Zero-LLM, rule-based gate that annotates offers with ghost-listing
 * signals before they reach evaluation. Mirrors scan.mjs's trust-filter
 * pattern: NEVER drops a listing, only annotates it — a flagged listing
 * still gets one cheap Sonnet classification pass ("specific role vs
 * generic req-mill posting") before the agent decides to discard it. See
 * modes/pipeline.md's pre-screen gate for where that classification pass
 * happens.
 *
 * Three rules (Job Search Automation System spec, Section 5):
 *   1. repost_churn        — reposted more than 3 times in a 60-day window
 *                            (reuses detectReposts() from detect-reposts.mjs
 *                            with this filter's own window/threshold; does
 *                            NOT change that module's own 90-day/2+ default,
 *                            which serves a different purpose — Block G's
 *                            per-JD legitimacy check).
 *   2. stale_boilerplate    — no salary range + generic boilerplate
 *                            description + posted more than 45 days ago.
 *   3. domain_unresolved    — the offer URL's hostname doesn't resolve.
 *
 * Run: node ghost-filter.mjs                  (JSON to stdout, scans data/scan-history.tsv)
 *      node ghost-filter.mjs --summary        (human-readable table)
 *      node ghost-filter.mjs --window 60      (override repost window)
 *      node ghost-filter.mjs --repost-threshold 3
 *      node ghost-filter.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dns from 'node:dns/promises';

import { parseScanHistory, detectReposts } from './detect-reposts.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const SCAN_HISTORY_PATH = join(CAREER_OPS, 'data/scan-history.tsv');

const REPOST_WINDOW_DAYS = 60;
const REPOST_COUNT_THRESHOLD = 3; // flag when repostCount > 3 (i.e. 4+ listings)
const STALE_POSTING_DAYS = 45;

// Generic req-mill phrasing. Heuristic, not exhaustive — the point is to
// catch boilerplate-only postings, not to penalize legitimate JDs that
// happen to mention one of these once.
const BOILERPLATE_PHRASES = [
  'equal opportunity employer',
  'we are looking for a talented',
  'fast-paced environment',
  'wear many hats',
  'competitive salary and benefits',
  'other duties as assigned',
  'ability to multitask',
  'self-starter',
  'rockstar',
  'ninja',
];

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const windowIdx = args.indexOf('--window');
const windowDays = windowIdx !== -1 && args[windowIdx + 1] !== undefined && !Number.isNaN(parseInt(args[windowIdx + 1], 10))
  ? parseInt(args[windowIdx + 1], 10)
  : REPOST_WINDOW_DAYS;
const thresholdIdx = args.indexOf('--repost-threshold');
const repostThreshold = thresholdIdx !== -1 && args[thresholdIdx + 1] !== undefined && !Number.isNaN(parseInt(args[thresholdIdx + 1], 10))
  ? parseInt(args[thresholdIdx + 1], 10)
  : REPOST_COUNT_THRESHOLD;

function daysSince(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((Date.now() - d.getTime()) / 86400000);
}

// Don't penalize missing data: no description at all is not "boilerplate".
function looksBoilerplate(description = '') {
  const text = String(description).toLowerCase();
  if (!text.trim()) return false;
  const hits = BOILERPLATE_PHRASES.filter(p => text.includes(p)).length;
  return hits >= 2 || (text.length < 400 && hits >= 1);
}

function extractDomain(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Unknown domain (couldn't parse a URL) → don't penalize missing data.
export async function domainResolves(domain) {
  if (!domain) return null;
  try {
    await dns.lookup(domain);
    return true;
  } catch {
    return false;
  }
}

// --- Rule 1: repost churn ---
// Builds a lookup of company+role -> repost cluster for clusters whose
// repostCount exceeds the threshold, reusing detect-reposts.mjs's own
// clustering logic (fuzzy title matching, union-find) rather than
// reimplementing it.
export function buildRepostFlagSet(scanHistoryRows, windowDaysArg = REPOST_WINDOW_DAYS, countThreshold = REPOST_COUNT_THRESHOLD) {
  const clusters = detectReposts(scanHistoryRows, windowDaysArg);
  const flagged = new Map();
  for (const cluster of clusters) {
    if (cluster.repostCount > countThreshold) {
      flagged.set(`${cluster.company.toLowerCase()}::${cluster.role.toLowerCase()}`, cluster);
    }
  }
  return flagged;
}

function matchesRepostFlag(offer, repostFlagSet) {
  const company = (offer.company || '').toLowerCase();
  const title = (offer.title || '').toLowerCase();
  if (!company || !title) return null;
  const exactKey = `${company}::${title}`;
  if (repostFlagSet.has(exactKey)) return repostFlagSet.get(exactKey);
  for (const [key, cluster] of repostFlagSet) {
    const [clusterCompany] = key.split('::');
    if (clusterCompany === company && roleFuzzyMatch(offer.title || '', cluster.role)) {
      return cluster;
    }
  }
  return null;
}

// --- Rule 2: stale + boilerplate + no salary ---
function matchesStaleBoilerplateFlag(offer) {
  const salary = offer.salary;
  const hasSalary = salary && typeof salary === 'object' && (salary.min || salary.max);
  if (hasSalary) return null;
  const postedRaw = offer.postedAt ? String(offer.postedAt).slice(0, 10) : null;
  const postedDaysAgo = postedRaw ? daysSince(postedRaw) : null;
  if (postedDaysAgo === null || postedDaysAgo <= STALE_POSTING_DAYS) return null;
  const description = offer.descriptionPlain || offer.description || '';
  if (!looksBoilerplate(description)) return null;
  return { postedDaysAgo };
}

// --- Rule 3: domain doesn't resolve ---
async function matchesDomainFlag(offer) {
  const domain = extractDomain(offer.url);
  const resolves = await domainResolves(domain);
  if (resolves === false) return { domain };
  return null;
}

// --- Public API ---
// Returns an array of flags (empty = clean). NEVER a boolean drop decision —
// callers must never silently discard a flagged offer; see file header.
export async function ghostCheck(offer, repostFlagSet) {
  const flags = [];

  const repostCluster = matchesRepostFlag(offer, repostFlagSet);
  if (repostCluster) {
    flags.push({
      rule: 'repost_churn',
      detail: `reposted ${repostCluster.repostCount}x in ${repostCluster.daysSpan}d`,
    });
  }

  const staleFlag = matchesStaleBoilerplateFlag(offer);
  if (staleFlag) {
    flags.push({
      rule: 'stale_boilerplate',
      detail: `no salary, boilerplate text, posted ${staleFlag.postedDaysAgo}d ago`,
    });
  }

  const domainFlag = await matchesDomainFlag(offer);
  if (domainFlag) {
    flags.push({ rule: 'domain_unresolved', detail: `${domainFlag.domain} does not resolve` });
  }

  return flags;
}

export function ghostIsFlagged(flags) {
  return Array.isArray(flags) && flags.length > 0;
}

export function formatGhostSegment(flags) {
  if (!ghostIsFlagged(flags)) return '';
  return flags.map(f => f.rule).join(',');
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
  // stale_boilerplate: no salary, old posting, boilerplate description
  const staleOffer = {
    company: 'ReqMill Co',
    title: 'Generic Software Engineer',
    url: 'https://example.com/jobs/1',
    postedAt: '2020-01-01',
    salary: null,
    descriptionPlain: 'Equal opportunity employer. Fast-paced environment. Wear many hats.',
  };
  const staleFlags = await ghostCheck(staleOffer, new Map());
  assertEqual(staleFlags.some(f => f.rule === 'stale_boilerplate'), true, 'stale_boilerplate flags a boilerplate stale posting');

  // A fresh posting with the same text must NOT be flagged (posted <45d).
  const freshOffer = { ...staleOffer, postedAt: new Date().toISOString().slice(0, 10) };
  const freshFlags = await ghostCheck(freshOffer, new Map());
  assertEqual(freshFlags.some(f => f.rule === 'stale_boilerplate'), false, 'fresh posting is not flagged even with boilerplate text');

  // A posting with a real salary must NOT be flagged even if old + boilerplate.
  const salariedOffer = { ...staleOffer, salary: { min: 100000, max: 150000, currency: 'USD' } };
  const salariedFlags = await ghostCheck(salariedOffer, new Map());
  assertEqual(salariedFlags.some(f => f.rule === 'stale_boilerplate'), false, 'posting with a salary range is not flagged');

  // A posting with no description at all must NOT be flagged (don't penalize missing data).
  const noDescOffer = { ...staleOffer, descriptionPlain: '' };
  const noDescFlags = await ghostCheck(noDescOffer, new Map());
  assertEqual(noDescFlags.some(f => f.rule === 'stale_boilerplate'), false, 'missing description is not treated as boilerplate');

  // repost_churn: cluster with repostCount > threshold flags a matching offer.
  const repostFlagSet = new Map([
    ['acme co::backend engineer', { company: 'Acme Co', role: 'Backend Engineer', repostCount: 5, daysSpan: 40 }],
  ]);
  const repostedOffer = { company: 'Acme Co', title: 'Backend Engineer', url: 'https://acme.example.com/jobs/9' };
  const repostFlags = await ghostCheck(repostedOffer, repostFlagSet);
  assertEqual(repostFlags.some(f => f.rule === 'repost_churn'), true, 'repost_churn flags an offer matching a >threshold cluster');

  // domain_unresolved: a domain that cannot possibly resolve.
  const badDomainOffer = { company: 'NoSuchCo', title: 'Engineer', url: 'https://this-domain-does-not-exist-ghost-filter-test.invalid/jobs/1' };
  const badDomainFlags = await ghostCheck(badDomainOffer, new Map());
  assertEqual(badDomainFlags.some(f => f.rule === 'domain_unresolved'), true, 'domain_unresolved flags an unresolvable domain');

  // ghostIsFlagged / formatGhostSegment
  assertEqual(ghostIsFlagged([]), false, 'ghostIsFlagged is false for a clean offer');
  assertEqual(ghostIsFlagged([{ rule: 'x', detail: 'y' }]), true, 'ghostIsFlagged is true when flags exist');
  assertEqual(formatGhostSegment([{ rule: 'a' }, { rule: 'b' }]), 'a,b', 'formatGhostSegment joins rule names');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
  }
}

// --- CLI: scan data/scan-history.tsv for repost-churn flags (the only rule
// with enough context to run standalone — stale_boilerplate and
// domain_unresolved need live offer objects from a scan, so they're
// exercised via ghostCheck() as a library call from scan.mjs/pipeline.md,
// not from this CLI). ---
async function main() {
  if (selfTestMode) {
    await runSelfTest();
    return;
  }

  if (!existsSync(SCAN_HISTORY_PATH)) {
    console.log(JSON.stringify({ error: 'data/scan-history.tsv not found', flagged: [] }));
    return;
  }

  const rows = parseScanHistory(readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
  const repostFlagSet = buildRepostFlagSet(rows, windowDays, repostThreshold);
  const flagged = [...repostFlagSet.values()];

  if (summaryMode) {
    console.log(`\n${'='.repeat(78)}`);
    console.log('  Ghost-Filter — repost_churn signals — career-ops');
    console.log(`  window: ${windowDays}d | threshold: >${repostThreshold} reposts | flagged: ${flagged.length}`);
    console.log(`${'='.repeat(78)}\n`);
    if (flagged.length === 0) {
      console.log('  No repost-churn ghost signals detected.\n');
    } else {
      for (const cluster of flagged) {
        console.log(`  ⚠️  ${cluster.company} — ${cluster.role} (${cluster.repostCount}x in ${cluster.daysSpan}d)`);
      }
      console.log('');
    }
    return;
  }

  console.log(JSON.stringify({ windowDays, repostThreshold, flagged }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
