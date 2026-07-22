#!/usr/bin/env node
/**
 * apply-agent/pacing.mjs — Tier 2 pacing: apply window + human-like jitter
 *
 * Spec Section 8 (job-search-automation plan, Phase 5): Tier 2 (LinkedIn/
 * Naukri) applies through the candidate's own real logged-in session, so
 * pacing exists to look human and to protect the account — NOT as the
 * primary quality gate (match-quality/scoring already does that upstream).
 *
 * Daily-cap counting (the 25/day/platform backstop) lives in
 * budget-tracker.mjs's checkAndIncrement('tier2_apply_linkedin'|'tier2_apply_naukri'),
 * not here — this module used to keep its own separate counter in
 * data/tier2-apply-counts.json, which was a second, independently-drifting
 * counter for the exact same concept budget-tracker.mjs also tracks in
 * data/usage-today.json. Consolidated onto budget-tracker.mjs as the single
 * source of truth for daily caps (both LLM calls and Tier-2 applies); this
 * module now only owns the time-of-day window gate and jitter helpers.
 */

export const IST_OFFSET_MIN = 5 * 60 + 30; // UTC+5:30, no DST
export const WINDOW_START_HOUR = 8;  // 8am IST
export const WINDOW_END_HOUR = 23;   // 11pm IST

/** Today's date as YYYY-MM-DD in IST, independent of the host machine's TZ. */
export function istDateString(now = new Date()) {
  const istMs = now.getTime() + IST_OFFSET_MIN * 60_000;
  const ist = new Date(istMs);
  return ist.toISOString().slice(0, 10);
}

/** The current hour-of-day (0-23) in IST, independent of the host TZ. */
export function istHour(now = new Date()) {
  const istMs = now.getTime() + IST_OFFSET_MIN * 60_000;
  return new Date(istMs).getUTCHours();
}

/** True between 8am and 11pm IST (inclusive start, exclusive end). */
export function withinApplyWindow(now = new Date()) {
  const h = istHour(now);
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

/** A randomized delay in milliseconds, uniformly distributed in [minSec, maxSec]. */
export function randomDelayMs(minSec, maxSec) {
  if (minSec < 0 || maxSec < minSec) throw new Error(`randomDelayMs: invalid range [${minSec}, ${maxSec}]`);
  const sec = minSec + Math.random() * (maxSec - minSec);
  return Math.round(sec * 1000);
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
  // istDateString / istHour are TZ-independent by construction — sanity-check
  // a few fixed UTC instants land on the expected IST date/hour.
  assertEqual(istDateString(new Date('2026-01-01T19:00:00Z')), '2026-01-02', '19:00 UTC on Jan 1 is already Jan 2 in IST (+5:30)');
  assertEqual(istDateString(new Date('2026-01-01T18:29:00Z')), '2026-01-01', '18:29 UTC on Jan 1 is still Jan 1 in IST');
  assertEqual(istHour(new Date('2026-01-01T02:35:00Z')), 8, '02:35 UTC is 08:05 IST -> hour 8');

  assertEqual(withinApplyWindow(new Date('2026-01-01T03:00:00Z')), true, '08:30 IST is inside the window');
  assertEqual(withinApplyWindow(new Date('2026-01-01T02:00:00Z')), false, '07:30 IST is before the 8am window opens');
  assertEqual(withinApplyWindow(new Date('2026-01-01T17:29:00Z')), true, '22:59 IST is inside the window');
  assertEqual(withinApplyWindow(new Date('2026-01-01T17:30:00Z')), false, '23:00 IST is outside the window (end is exclusive)');

  const d1 = randomDelayMs(2, 2);
  assertEqual(d1, 2000, 'randomDelayMs with equal min/max is deterministic');
  const d2 = randomDelayMs(1, 5);
  assertEqual(d2 >= 1000 && d2 <= 5000, true, 'randomDelayMs stays within [minSec, maxSec] in ms');
  try {
    randomDelayMs(5, 1);
    assertEqual(true, false, 'randomDelayMs rejects an inverted range (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('invalid range'), true, 'randomDelayMs rejects an inverted range');
  }

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
