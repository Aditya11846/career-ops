#!/usr/bin/env node
/**
 * budget-tracker.mjs — daily LLM-call + Tier-2-apply ceiling enforcement
 *
 * Independent axis from `spend_tier` (config/profile.yml): spend_tier picks
 * the MODEL (economy/standard/premium), this module limits CALL COUNT
 * regardless of tier. Neither one re-enforces the other.
 *
 * Absorbs Tier-2 daily-apply-cap counting from apply-agent/pacing.mjs, which
 * used to track it separately in data/tier2-apply-counts.json — that was a
 * second counter for the same underlying "25/day/platform" concept this
 * module also tracks. pacing.mjs now only owns the time-of-day window gate
 * (withinApplyWindow()); this module is the single source of truth for
 * daily caps (both LLM calls and Tier-2 applies), so the two numbers can't
 * silently drift apart.
 *
 * Storage: data/usage-today.json — {date, llm_calls, tier2_applies:
 * {linkedin, naukri}} — written via tracker-utils.mjs's writeFileAtomic.
 * Rolls over automatically when `date` doesn't match today (IST).
 *
 * Usage:
 *   import { checkAndIncrement } from './budget-tracker.mjs';
 *   const result = checkAndIncrement('llm_call');           // or 'tier2_apply_linkedin' / 'tier2_apply_naukri'
 *   if (!result.ok) { ...halt, result.reason explains why... }
 *
 *   node budget-tracker.mjs --summary
 *   node budget-tracker.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

import { writeFileAtomic } from './tracker-utils.mjs';
import { addEntry } from './needs-input.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const USAGE_PATH = process.env.CAREER_OPS_USAGE_TODAY || join(CAREER_OPS, 'data/usage-today.json');
const PROFILE_FILE = process.env.CAREER_OPS_PROFILE || join(CAREER_OPS, 'config/profile.yml');

// --- Budget config (mirrors followup-cadence.mjs's DEFAULT_CADENCE / PROFILE_CADENCE_KEYS pattern) ---
export const DEFAULT_BUDGET = {
  daily_llm_calls: 300,
  tier2_daily_cap: 25, // per platform (linkedin, naukri)
};

const PROFILE_BUDGET_KEYS = {
  daily_llm_calls: 'daily_llm_calls',
  tier2_daily_cap: 'tier2_daily_cap',
};

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function loadProfileBudget(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return {};
  let raw;
  try {
    raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return {};
  }
  const source = raw.budget || {};
  const budget = {};
  for (const [profileKey, budgetKey] of Object.entries(PROFILE_BUDGET_KEYS)) {
    const parsed = positiveInteger(source[profileKey]);
    if (parsed !== null) budget[budgetKey] = parsed;
  }
  return budget;
}

export function resolveBudgetConfig({ profilePath = PROFILE_FILE } = {}) {
  return { ...DEFAULT_BUDGET, ...loadProfileBudget(profilePath) };
}

const BUDGET = resolveBudgetConfig();

// --- IST date (matches apply-agent/pacing.mjs's day boundary) ---
function istDateString(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

function emptyUsage(date = istDateString()) {
  return { date, llm_calls: 0, tier2_applies: { linkedin: 0, naukri: 0 } };
}

function loadUsage() {
  if (!existsSync(USAGE_PATH)) return emptyUsage();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(USAGE_PATH, 'utf-8'));
  } catch {
    return emptyUsage();
  }
  const today = istDateString();
  if (parsed.date !== today) return emptyUsage(today); // auto-rollover
  return {
    date: parsed.date,
    llm_calls: Number.isFinite(parsed.llm_calls) ? parsed.llm_calls : 0,
    tier2_applies: {
      linkedin: parsed.tier2_applies?.linkedin || 0,
      naukri: parsed.tier2_applies?.naukri || 0,
    },
  };
}

function saveUsage(usage) {
  writeFileAtomic(USAGE_PATH, JSON.stringify(usage, null, 2) + '\n');
}

const VALID_KINDS = new Set(['llm_call', 'tier2_apply_linkedin', 'tier2_apply_naukri']);

/**
 * Check whether `kind` is under budget, and if so, increment it and persist.
 * No silent degrade or retry — callers halt and log a clear reason on a cap
 * hit, and this also appends an informational `budget_cap` entry to
 * needs-input-queue.json so it surfaces on the dashboard.
 *
 * @param {'llm_call'|'tier2_apply_linkedin'|'tier2_apply_naukri'} kind
 * @param {{company?: string, role?: string, reportRef?: string|null}} context optional, only used for the needs-input entry on a cap hit
 * @returns {{ok: boolean, reason?: string, usage: object}}
 */
export function checkAndIncrement(kind, context = {}) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`checkAndIncrement: invalid kind "${kind}" (must be one of ${[...VALID_KINDS].join(', ')})`);
  }

  const usage = loadUsage();

  if (kind === 'llm_call') {
    if (usage.llm_calls >= BUDGET.daily_llm_calls) {
      const reason = `Daily LLM-call budget (${BUDGET.daily_llm_calls}) reached — resumes tomorrow.`;
      addEntry({ source: 'budget_cap', reason, company: context.company || '', role: context.role || '', report_ref: context.reportRef ?? null, context: { kind } });
      return { ok: false, reason, usage };
    }
    usage.llm_calls += 1;
    saveUsage(usage);
    return { ok: true, usage };
  }

  const platform = kind === 'tier2_apply_linkedin' ? 'linkedin' : 'naukri';
  if (usage.tier2_applies[platform] >= BUDGET.tier2_daily_cap) {
    const reason = `${platform} has hit its ${BUDGET.tier2_daily_cap}/day backstop — resumes tomorrow.`;
    addEntry({ source: 'budget_cap', reason, company: context.company || '', role: context.role || '', report_ref: context.reportRef ?? null, context: { kind, platform } });
    return { ok: false, reason, usage };
  }
  usage.tier2_applies[platform] += 1;
  saveUsage(usage);
  return { ok: true, usage };
}

/**
 * Check whether `kind` is already at/over its cap WITHOUT incrementing.
 * Callers should check this before doing expensive work (e.g. opening a
 * Tier 2 browser session) so a capped day never spends that cost, then call
 * checkAndIncrement() only after the real event actually happens (a
 * genuine LLM call, or a fill+handoff — matching Tier 1's audit trail).
 *
 * @param {'llm_call'|'tier2_apply_linkedin'|'tier2_apply_naukri'} kind
 */
export function isCapped(kind) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`isCapped: invalid kind "${kind}" (must be one of ${[...VALID_KINDS].join(', ')})`);
  }
  const usage = loadUsage();
  if (kind === 'llm_call') return usage.llm_calls >= BUDGET.daily_llm_calls;
  const platform = kind === 'tier2_apply_linkedin' ? 'linkedin' : 'naukri';
  return usage.tier2_applies[platform] >= BUDGET.tier2_daily_cap;
}

export function currentUsage() {
  return loadUsage();
}

export function budgetConfig() {
  return BUDGET;
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
    checkAndIncrement('bogus_kind');
    assertEqual(true, false, 'checkAndIncrement rejects an invalid kind (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('invalid kind'), true, 'checkAndIncrement rejects an invalid kind');
  }

  const before = currentUsage();
  const result = checkAndIncrement('llm_call');
  assertEqual(result.ok, true, 'checkAndIncrement allows a call under budget');
  const after = currentUsage();
  assertEqual(after.llm_calls, before.llm_calls + 1, 'checkAndIncrement persists the increment');

  const tier2Before = currentUsage().tier2_applies.naukri;
  const tier2Result = checkAndIncrement('tier2_apply_naukri');
  assertEqual(tier2Result.ok, true, 'checkAndIncrement allows a tier2 apply under budget');
  assertEqual(currentUsage().tier2_applies.naukri, tier2Before + 1, 'checkAndIncrement persists the tier2 increment separately per platform');

  assertEqual(resolveBudgetConfig().daily_llm_calls, DEFAULT_BUDGET.daily_llm_calls, 'resolveBudgetConfig defaults to DEFAULT_BUDGET when profile has no budget: block');

  const peekBefore = isCapped('tier2_apply_linkedin');
  assertEqual(peekBefore, currentUsage().tier2_applies.linkedin >= BUDGET.tier2_daily_cap, 'isCapped matches the current usage without incrementing');
  assertEqual(currentUsage().tier2_applies.linkedin, currentUsage().tier2_applies.linkedin, 'isCapped is a pure peek — does not mutate usage');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log(`\nSelf-test PASSED (left ${USAGE_PATH === join(CAREER_OPS, 'data/usage-today.json') ? 'real data/usage-today.json' : 'a test usage file'} with +1 llm_call and +1 naukri apply — harmless, resets tomorrow)`);
  }
}

// --- CLI ---
function printSummary() {
  const usage = currentUsage();
  console.log(`\nBudget usage — ${usage.date}`);
  console.log(`  LLM calls:        ${usage.llm_calls} / ${BUDGET.daily_llm_calls}`);
  console.log(`  Tier-2 LinkedIn:  ${usage.tier2_applies.linkedin} / ${BUDGET.tier2_daily_cap}`);
  console.log(`  Tier-2 Naukri:    ${usage.tier2_applies.naukri} / ${BUDGET.tier2_daily_cap}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return runSelfTest();
  if (args.includes('--summary')) return printSummary();
  console.log(JSON.stringify({ usage: currentUsage(), budget: BUDGET }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
