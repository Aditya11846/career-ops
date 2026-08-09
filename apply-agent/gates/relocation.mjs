#!/usr/bin/env node
/**
 * apply-agent/gates/relocation.mjs — onsite-non-home-city gate (binding decision 3)
 *
 * portals.yml's location_filter stays broad (doesn't block non-home-city Indian
 * cities or reject international listings at scan time) — see the
 * job-search-automation plan's binding decision 3. Relocation is a
 * downstream, human-judgment call, not a sourcing-time filter: Apply Agent
 * checks this gate right before firing on a Tier 1/2 job, and routes
 * onsite-non-home-city roles to the needs-input queue instead of auto-submitting,
 * modeled on the existing trust-filter's "annotate, never drop" precedent.
 *
 * A role only trips this gate when it's genuinely onsite AND not in the
 * candidate's home city (from config/profile.yml → location.city).
 * Remote and hybrid roles anywhere, and any home-city role, pass straight
 * through — this is not a location filter, it's a "would this require
 * relocating" check.
 *
 * Home city is read from config/profile.yml at call time via the `profile`
 * argument (the orchestrator already loads profile.yml — pass it through).
 * Falls back to an empty marker list (blocks nothing) if the city is absent,
 * so a missing profile is always safe.
 */

import { addEntry } from '../../needs-input.mjs';

const REMOTE_HYBRID_MARKERS = ['remote', 'hybrid', 'work from home', 'wfh'];

/** Derive home-city markers from profile.yml's location.city field. */
function homeCityMarkers(profile) {
  const city = profile?.location?.city;
  if (!city || typeof city !== 'string') return [];
  return [city.trim().toLowerCase()];
}

function locationLooksRemoteOrHybrid(location = '') {
  const text = location.toLowerCase();
  return REMOTE_HYBRID_MARKERS.some(marker => text.includes(marker));
}

function locationLooksLikeHomeCity(location = '', markers = []) {
  if (!markers.length) return false;
  const text = location.toLowerCase();
  return markers.some(marker => text.includes(marker));
}

/**
 * @param {{company: string, role: string, location: string, url?: string, reportRef?: string|null}} job
 * @param {object} [profile] — parsed config/profile.yml (optional; orchestrator passes this)
 * @returns {{blocked: boolean, entry?: object}} blocked=true means this job was
 *   routed to needs-input and Apply Agent must NOT auto-submit it this pass.
 */
export function checkRelocationGate(job, profile) {
  const location = job?.location || '';

  // No location data at all — don't penalize missing data (same rule
  // portals.yml's own location_filter follows), let it through.
  if (!location.trim()) return { blocked: false };

  if (locationLooksRemoteOrHybrid(location)) return { blocked: false };

  const markers = homeCityMarkers(profile);
  // If we can't determine the home city from the profile, don't block — missing
  // data is not evidence of a relocation requirement (same principle as missing location).
  if (!markers.length) return { blocked: false };
  if (locationLooksLikeHomeCity(location, markers)) return { blocked: false };

  const homeCity = profile?.location?.city || '(home city not set in config/profile.yml)';

  // Onsite, and not the home city: relocation would be required. Flag, don't auto-apply.
  const entry = addEntry({
    source: 'relocation',
    reason: `Onsite role in "${location}" — not ${homeCity}, not remote/hybrid. Relocation decision needs your input before applying.`,
    company: job.company || '',
    role: job.role || '',
    report_ref: job.reportRef ?? null,
    context: { location, url: job.url ?? null },
  });

  return { blocked: true, entry };
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
  const mockProfile = { location: { city: 'Pune' } };

  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Remote' }, mockProfile).blocked, false, 'remote role passes through');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Hybrid - Bangalore' }, mockProfile).blocked, false, 'hybrid role passes through even in another city');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Pune, Maharashtra' }, mockProfile).blocked, false, 'home-city role passes through');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: '' }, mockProfile).blocked, false, 'missing location is not penalized');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Bangalore, India' }, undefined).blocked, false, 'missing profile falls back safely (no city → blocks nothing)');

  const result = checkRelocationGate({ company: 'Acme', role: 'Engineer', location: 'Bangalore, India', url: 'https://example.com/1' }, mockProfile);
  assertEqual(result.blocked, true, 'onsite non-home-city role is blocked and routed to needs-input');
  assertEqual(result.entry.source, 'relocation', 'the routed entry has source: relocation');
  assertEqual(result.entry.status, 'open', 'the routed entry starts open');

  // City change test — Mumbai as home city
  const mumbaiProfile = { location: { city: 'Mumbai' } };
  assertEqual(checkRelocationGate({ company: 'B', role: 'Y', location: 'Mumbai, Maharashtra' }, mumbaiProfile).blocked, false, 'different home city reads correctly from profile');
  assertEqual(checkRelocationGate({ company: 'B', role: 'Y', location: 'Pune, Maharashtra' }, mumbaiProfile).blocked, true, 'non-home-city is blocked when home city is Mumbai');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (left one relocation self-test entry in data/needs-input-queue.json)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
