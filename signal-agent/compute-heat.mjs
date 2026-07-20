#!/usr/bin/env node
/**
 * signal-agent/compute-heat.mjs — company_heat scorer for career-ops
 *
 * Computes a 0-100 `company_heat` score per company from four signals
 * (job-search-automation plan, Section 4b):
 *   - funding      — recent funding round / news, last 90 days (agent-researched via WebSearch,
 *                     see sources/funding-news.md — no deterministic API for this)
 *   - github       — org commit/release activity in the relevant stack (fetched here directly
 *                     from GitHub's public REST API — zero-LLM, no auth needed for public repos)
 *   - reddit       — mentions of active hiring/interview experiences, last 60 days (agent-researched
 *                     via WebSearch, see sources/reddit.md)
 *   - linkedin     — "actively hiring" signals / recruiter posting cadence (agent-researched,
 *                     see sources/... — no public API, WebSearch/manual judgment)
 *
 * Each sub-signal is scored 0-100 by whoever computes it (this script for github,
 * the agent following sources/*.md for the other three) and combined here with a
 * fixed weighting. Storage: data/company-signals.json, keyed by normalizeCompany()
 * (reused from tracker-utils.mjs) for consistency with how merge-tracker.mjs and
 * set-status.mjs key companies elsewhere in career-ops.
 *
 * company_heat is NEVER multiplied into modes/_shared.md's scoring formula — it's
 * a post-scoring adjustment applied entirely in code (apply-agent / batch tooling),
 * attached to the report/tracker row, so the shared evaluation prompt stays untouched.
 *
 * Usage:
 *   node signal-agent/compute-heat.mjs --company "Acme Inc" \
 *     --funding 70 --reddit 40 --linkedin 55 [--github-org acme-inc] [--no-github]
 *     → computes github score live (or accept --github N to supply it directly),
 *       combines all four, writes/updates data/company-signals.json, prints the result.
 *
 *   node signal-agent/compute-heat.mjs --read "Acme Inc"
 *     → prints the stored signal record for a company, or null if none exists.
 *
 *   node signal-agent/compute-heat.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { normalizeCompany, writeFileAtomic } from '../tracker-utils.mjs';

const SIGNAL_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(SIGNAL_AGENT_DIR);
const SIGNALS_PATH = join(CAREER_OPS, 'data/company-signals.json');

// Weights sum to 1.0. Funding and GitHub activity are the strongest signals of
// real hiring capacity/urgency; Reddit and LinkedIn are softer/noisier signals.
export const WEIGHTS = {
  funding: 0.35,
  github: 0.30,
  reddit: 0.15,
  linkedin: 0.20,
};

function clamp0to100(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

// --- Core scoring (pure function — testable without any network/agent input) ---
export function computeHeat({ funding = 0, github = 0, reddit = 0, linkedin = 0 } = {}) {
  const f = clamp0to100(funding);
  const g = clamp0to100(github);
  const r = clamp0to100(reddit);
  const l = clamp0to100(linkedin);
  const heat = f * WEIGHTS.funding + g * WEIGHTS.github + r * WEIGHTS.reddit + l * WEIGHTS.linkedin;
  return Math.round(heat);
}

// --- GitHub org activity (zero-LLM, public REST API, no auth required) ---
// Scores 0-100 from how recently the org's repos were pushed to and how many
// have shipped a release in the lookback window. Unauthenticated GitHub API
// calls are rate-limited to 60/hr, which is fine for a once-daily cadence
// over a tracked-company list of this size.
export async function githubActivityScore(org, { lookbackDays = 90, fetchImpl = fetch } = {}) {
  if (!org) return null;
  try {
    const reposRes = await fetchImpl(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=10`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'career-ops-signal-agent' },
    });
    if (!reposRes.ok) return null;
    const repos = await reposRes.json();
    if (!Array.isArray(repos) || repos.length === 0) return 0;

    const now = Date.now();
    const lookbackMs = lookbackDays * 86400000;
    let recentlyPushed = 0;
    let mostRecentPushDaysAgo = Infinity;
    for (const repo of repos) {
      const pushedAt = repo.pushed_at ? new Date(repo.pushed_at).getTime() : null;
      if (!pushedAt) continue;
      const daysAgo = (now - pushedAt) / 86400000;
      mostRecentPushDaysAgo = Math.min(mostRecentPushDaysAgo, daysAgo);
      if (now - pushedAt <= lookbackMs) recentlyPushed += 1;
    }

    // Recency component: 100 if pushed today, decaying to 0 at lookbackDays.
    const recencyScore = mostRecentPushDaysAgo === Infinity
      ? 0
      : clamp0to100(100 * (1 - mostRecentPushDaysAgo / lookbackDays));
    // Breadth component: how many of the top-10-most-recently-pushed repos
    // fall within the lookback window (proxy for org-wide activity, not just
    // one maintained repo).
    const breadthScore = clamp0to100((recentlyPushed / repos.length) * 100);

    return Math.round(recencyScore * 0.6 + breadthScore * 0.4);
  } catch {
    return null; // network failure / org not found — don't penalize, just omit the signal
  }
}

// --- Persistence: data/company-signals.json, keyed by normalizeCompany() ---
function loadSignals() {
  if (!existsSync(SIGNALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function readCompanySignal(company) {
  const signals = loadSignals();
  return signals[normalizeCompany(company)] || null;
}

export function writeCompanySignal(company, record) {
  const signals = loadSignals();
  const key = normalizeCompany(company);
  signals[key] = { company, ...record, updatedAt: new Date().toISOString() };
  writeFileAtomic(SIGNALS_PATH, JSON.stringify(signals, null, 2) + '\n');
  return signals[key];
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
  assertEqual(computeHeat({ funding: 100, github: 100, reddit: 100, linkedin: 100 }), 100, 'all-max signals -> heat 100');
  assertEqual(computeHeat({}), 0, 'no signals -> heat 0');
  assertEqual(computeHeat({ funding: 200, github: -50 }), computeHeat({ funding: 100, github: 0 }), 'out-of-range inputs are clamped to 0-100');

  const weighted = computeHeat({ funding: 100, github: 0, reddit: 0, linkedin: 0 });
  assertEqual(weighted, Math.round(100 * WEIGHTS.funding), 'funding-only signal reflects its weight exactly');

  // githubActivityScore with a stubbed fetch — a repo pushed today should score near 100.
  const now = new Date().toISOString();
  const stubFetch = async () => ({
    ok: true,
    json: async () => [{ pushed_at: now }, { pushed_at: now }],
  });
  const freshScore = await githubActivityScore('some-org', { fetchImpl: stubFetch });
  assertEqual(freshScore >= 95, true, 'org with repos pushed today scores near 100');

  const staleFetch = async () => ({
    ok: true,
    json: async () => [{ pushed_at: '2000-01-01T00:00:00Z' }],
  });
  const staleScore = await githubActivityScore('dead-org', { fetchImpl: staleFetch, lookbackDays: 90 });
  assertEqual(staleScore, 0, 'org with only ancient pushes scores 0');

  const failFetch = async () => ({ ok: false });
  const missingScore = await githubActivityScore('nonexistent-org', { fetchImpl: failFetch });
  assertEqual(missingScore, null, 'a failed API call returns null, not a penalty score');

  // Persistence round-trip against a throwaway signals file.
  const tmpSignalsPath = join(CAREER_OPS, `data/.company-signals.selftest.${process.pid}.json`);
  const originalPath = SIGNALS_PATH;
  try {
    writeFileAtomic(tmpSignalsPath, '{}\n');
    // Can't easily monkey-patch the module-level constant, so just verify
    // writeCompanySignal/readCompanySignal's key-normalization logic directly.
    const key1 = normalizeCompany('Acme, Inc.');
    const key2 = normalizeCompany('ACME INC');
    assertEqual(key1, key2, 'normalizeCompany collapses punctuation/case variants to the same key');
  } finally {
    try { (await import('fs')).rmSync(tmpSignalsPath, { force: true }); } catch {}
  }

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

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  const readCompany = parseArg(args, '--read');
  if (readCompany !== undefined) {
    console.log(JSON.stringify(readCompanySignal(readCompany), null, 2));
    return;
  }

  const company = parseArg(args, '--company');
  if (!company) {
    console.error('Usage: node signal-agent/compute-heat.mjs --company "Name" --funding N --reddit N --linkedin N [--github N | --github-org slug] [--no-github]');
    process.exitCode = 1;
    return;
  }

  const funding = Number(parseArg(args, '--funding') ?? 0);
  const reddit = Number(parseArg(args, '--reddit') ?? 0);
  const linkedin = Number(parseArg(args, '--linkedin') ?? 0);

  let github = Number(parseArg(args, '--github') ?? NaN);
  const githubOrg = parseArg(args, '--github-org');
  if (Number.isNaN(github) && githubOrg && !args.includes('--no-github')) {
    const score = await githubActivityScore(githubOrg);
    github = score ?? 0;
  } else if (Number.isNaN(github)) {
    github = 0;
  }

  const heat = computeHeat({ funding, github, reddit, linkedin });
  const record = writeCompanySignal(company, {
    heat,
    signals: { funding, github, reddit, linkedin },
  });

  console.log(JSON.stringify(record, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
