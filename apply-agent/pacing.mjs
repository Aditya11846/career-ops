#!/usr/bin/env node
/**
 * apply-agent/pacing.mjs — Tier 2 pacing: apply window, jitter, daily backstop
 *
 * Spec Section 8 (job-search-automation plan, Phase 5): Tier 2 (LinkedIn/
 * Naukri) applies through the candidate's own real logged-in session, so
 * pacing exists to look human and to protect the account — NOT as the
 * primary quality gate (match-quality/scoring already does that upstream).
 * The 25/day/platform cap is a safety backstop, not the intended cadence —
 * callers should be applying far below it most days.
 *
 * Storage: data/tier2-apply-counts.json — {date: "YYYY-MM-DD", counts: {linkedin: N, naukri: N}}
 * (IST calendar day; gitignored, user runtime state). Rolls over automatically
 * when `date` doesn't match today's IST date, mirroring budget-tracker.mjs's
 * planned date-rollover pattern (job-search-automation plan).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { writeFileAtomic } from '../tracker-utils.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const COUNTS_PATH = join(CAREER_OPS, 'data/tier2-apply-counts.json');

export const DAILY_CAP = 25;
export const IST_OFFSET_MIN = 5 * 60 + 30; // UTC+5:30, no DST
export const WINDOW_START_HOUR = 8;  // 8am IST
export const WINDOW_END_HOUR = 23;   // 11pm IST

const VALID_PLATFORMS = new Set(['linkedin', 'naukri']);

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

function loadCounts() {
  if (!existsSync(COUNTS_PATH)) return { date: istDateString(), counts: { linkedin: 0, naukri: 0 } };
  try {
    const parsed = JSON.parse(readFileSync(COUNTS_PATH, 'utf-8'));
    if (parsed.date !== istDateString()) return { date: istDateString(), counts: { linkedin: 0, naukri: 0 } };
    return { date: parsed.date, counts: { linkedin: parsed.counts?.linkedin ?? 0, naukri: parsed.counts?.naukri ?? 0 } };
  } catch {
    return { date: istDateString(), counts: { linkedin: 0, naukri: 0 } };
  }
}

function saveCounts(state) {
  writeFileAtomic(COUNTS_PATH, JSON.stringify(state, null, 2) + '\n');
}

function assertPlatform(platform) {
  if (!VALID_PLATFORMS.has(platform)) {
    throw new Error(`invalid platform "${platform}" (must be one of ${[...VALID_PLATFORMS].join(', ')})`);
  }
}

/** How many Tier-2 applies have already happened today on this platform (IST calendar day). */
export function todayCount(platform) {
  assertPlatform(platform);
  return loadCounts().counts[platform];
}

/**
 * Checks the daily backstop WITHOUT incrementing. Callers should check this
 * before opening a session (so a capped day never spends a browser open),
 * then call recordApply() only after a real, non-paused submission-track
 * event (fill+handoff, matching Tier 1's audit trail).
 */
export function isCapped(platform) {
  assertPlatform(platform);
  return todayCount(platform) >= DAILY_CAP;
}

/** Record one Tier-2 apply against today's count. Returns the new count. */
export function recordApply(platform) {
  assertPlatform(platform);
  const state = loadCounts();
  state.counts[platform] += 1;
  saveCounts(state);
  return state.counts[platform];
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

  try {
    isCapped('naukri.com'); // not a valid platform key
    assertEqual(true, false, 'isCapped rejects an unknown platform (should have thrown)');
  } catch (err) {
    assertEqual(err.message.includes('invalid platform'), true, 'isCapped rejects an unknown platform');
  }

  // Real round-trip against the live counts file (self-contained: reset to 0
  // for a throwaway platform is not possible since platforms are fixed, so
  // record the CURRENT count, verify increment, and leave state consistent
  // — recordApply is meant to be called for real applies, so this self-test
  // intentionally nudges the real counter by +1 and reports the before/after
  // rather than mutating a separate file, matching needs-input.mjs's pattern
  // of leaving one harmless artifact behind.
  const before = todayCount('linkedin');
  assertEqual(isCapped('linkedin'), before >= DAILY_CAP, 'isCapped matches todayCount >= DAILY_CAP before recording');
  const after = recordApply('linkedin');
  assertEqual(after, before + 1, 'recordApply increments today\'s count by 1');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log(`\nSelf-test PASSED (bumped data/tier2-apply-counts.json's linkedin count by 1, from ${before} to ${after} — harmless test artifact, matches needs-input.mjs's self-test convention)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
