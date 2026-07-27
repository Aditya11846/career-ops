#!/usr/bin/env node
/**
 * senior-search/compute-stability.mjs — company-level layoff-risk signal.
 *
 * Deliberately reads/writes the SAME data/company-signals.json file as
 * signal-agent/compute-heat.mjs, keyed by the same normalizeCompany() — this
 * is the one intentional exception to senior-search/'s isolation-from-root
 * rule (see scan-watchlist.mjs's header comment for the rule itself): a
 * company's identity/signals are shared, cross-search knowledge, not personal
 * job-pipeline data, so composing with signal-agent's existing `heat` field
 * on read (rather than duplicating storage in a second file) is the correct
 * reuse — not a data leak between Aditya's and his father's searches, since
 * neither search's pipeline/tracker/cv data ever passes through this file.
 *
 * Kept as a SEPARATE script from compute-heat.mjs (not a 5th weight folded
 * into its WEIGHTS const) specifically so this addition never touches that
 * file's existing, documented, tested formula.
 *
 * Usage:
 *   node senior-search/compute-stability.mjs --company "Acme Inc" \
 *     --layoffs-fyi-hits 0 --headcount-trend-pct -5
 *     -> computes layoff_risk, merges into the company's existing signal
 *        record (preserving compute-heat.mjs's heat/signals if present).
 *
 *   node senior-search/compute-stability.mjs --read "Acme Inc"
 *     -> prints the stored signal record for a company, or null.
 *
 *   node senior-search/compute-stability.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { normalizeCompany, writeFileAtomic } from '../tracker-utils.mjs';

const SENIOR_SEARCH_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(SENIOR_SEARCH_DIR);
// Intentionally the SAME path signal-agent/compute-heat.mjs uses — see header.
const SIGNALS_PATH = join(CAREER_OPS, 'data/company-signals.json');

function clamp0to100(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/**
 * Pure risk-scoring function — no I/O, agent supplies the raw materials
 * (layoffs.fyi lookup result, LinkedIn headcount-trend note), same
 * agent-researched-sub-signal pattern compute-heat.mjs uses for
 * funding/reddit/linkedin.
 *
 * @param {{recentLayoffEvents?:number, headcountTrendPct?:number}} input
 *   recentLayoffEvents: count of distinct layoffs.fyi entries in the last ~12
 *     months (0 = none found). headcountTrendPct: approximate % change in
 *     LinkedIn-reported headcount over the last ~6-12 months (negative =
 *     shrinking).
 */
export function computeLayoffRisk({ recentLayoffEvents = 0, headcountTrendPct = 0 } = {}) {
  const events = Math.max(0, Number(recentLayoffEvents) || 0);
  const trend = Number(headcountTrendPct) || 0;

  let risk = 0;
  if (events === 1) risk += 40;
  else if (events >= 2) risk += 70;

  if (trend < 0) risk += clamp0to100(-trend * 2); // a -20% headcount trend alone contributes +40

  return clamp0to100(risk);
}

function loadSignals() {
  if (!existsSync(SIGNALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function readCompanyStability(company) {
  const signals = loadSignals();
  return signals[normalizeCompany(company)] || null;
}

/** Merges into any existing record (e.g. compute-heat.mjs's heat/signals) rather than overwriting it. */
export function writeCompanyStability(company, { layoffRisk, signals }) {
  const all = loadSignals();
  const key = normalizeCompany(company);
  const existing = all[key] || {};
  all[key] = {
    ...existing,
    company: existing.company || company,
    layoff_risk: layoffRisk,
    layoff_signals: signals,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(SIGNALS_PATH, JSON.stringify(all, null, 2) + '\n');
  return all[key];
}

// ── Self-test ───────────────────────────────────────────────────────────────

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

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${label}`);
  }
}

async function runSelfTest() {
  assertEqual(computeLayoffRisk({}), 0, 'no signals -> zero risk');
  assertEqual(computeLayoffRisk({ recentLayoffEvents: 1 }), 40, 'one layoff event -> 40 risk');
  assertEqual(computeLayoffRisk({ recentLayoffEvents: 3 }), 70, '2+ layoff events cap at 70 from that signal alone');
  assert(computeLayoffRisk({ headcountTrendPct: -20 }) === 40, 'a -20% headcount trend alone contributes 40 risk');
  assert(computeLayoffRisk({ recentLayoffEvents: 1, headcountTrendPct: -20 }) > computeLayoffRisk({ recentLayoffEvents: 1 }), 'shrinking headcount adds to a single layoff event, not replaces it');
  assertEqual(computeLayoffRisk({ headcountTrendPct: 15 }), 0, 'growing headcount contributes zero risk (never negative)');
  assertEqual(computeLayoffRisk({ recentLayoffEvents: 10, headcountTrendPct: -100 }), 100, 'risk clamps at 100 regardless of extreme inputs');

  // Merge behavior: writing stability must not clobber an existing heat record.
  const key = `selftest-co-${process.pid}`;
  const originalAll = existsSync(SIGNALS_PATH) ? JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8')) : {};
  try {
    // Simulate compute-heat.mjs having already written a heat record.
    const preSeeded = { ...originalAll, [normalizeCompany(key)]: { company: key, heat: 77, signals: { funding: 90, github: 60, reddit: 10, linkedin: 40 } } };
    writeFileAtomic(SIGNALS_PATH, JSON.stringify(preSeeded, null, 2) + '\n');

    writeCompanyStability(key, { layoffRisk: 40, signals: { recentLayoffEvents: 1, headcountTrendPct: 0 } });
    const merged = readCompanyStability(key);
    assertEqual(merged.heat, 77, 'writing stability preserves an existing heat field');
    assertEqual(merged.layoff_risk, 40, 'writing stability adds the new layoff_risk field');

    assertEqual(readCompanyStability('SomeCompanyNeverScored'), null, 'reading an unscored company returns null');
  } finally {
    // Restore the file to its pre-test state.
    writeFileAtomic(SIGNALS_PATH, JSON.stringify(originalAll, null, 2) + '\n');
  }

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

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
    console.log(JSON.stringify(readCompanyStability(readCompany), null, 2));
    return;
  }

  const company = parseArg(args, '--company');
  if (!company) {
    console.error('Usage: node senior-search/compute-stability.mjs --company "Name" [--layoffs-fyi-hits N] [--headcount-trend-pct N]');
    process.exitCode = 1;
    return;
  }

  const recentLayoffEvents = Number(parseArg(args, '--layoffs-fyi-hits') ?? 0);
  const headcountTrendPct = Number(parseArg(args, '--headcount-trend-pct') ?? 0);
  const layoffRisk = computeLayoffRisk({ recentLayoffEvents, headcountTrendPct });
  const record = writeCompanyStability(company, { layoffRisk, signals: { recentLayoffEvents, headcountTrendPct } });

  console.log(JSON.stringify(record, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
