#!/usr/bin/env node
/**
 * apply-agent/gates/relocation.mjs — onsite-non-Pune gate (binding decision 3)
 *
 * portals.yml's location_filter stays broad (doesn't block non-Pune Indian
 * cities or reject international listings at scan time) — see the
 * job-search-automation plan's binding decision 3. Relocation is a
 * downstream, human-judgment call, not a sourcing-time filter: Apply Agent
 * checks this gate right before firing on a Tier 1/2 job, and routes
 * onsite-non-Pune roles to the needs-input queue instead of auto-submitting,
 * modeled on the existing trust-filter's "annotate, never drop" precedent.
 *
 * A role only trips this gate when it's genuinely onsite AND not in Pune.
 * Remote and hybrid roles anywhere, and any Pune-based role, pass straight
 * through — this is not a location filter, it's a "would this require
 * relocating" check.
 */

import { addEntry } from '../../needs-input.mjs';

const REMOTE_HYBRID_MARKERS = ['remote', 'hybrid', 'work from home', 'wfh'];
const HOME_CITY_MARKERS = ['pune'];

function locationLooksRemoteOrHybrid(location = '') {
  const text = location.toLowerCase();
  return REMOTE_HYBRID_MARKERS.some(marker => text.includes(marker));
}

function locationLooksLikeHomeCity(location = '') {
  const text = location.toLowerCase();
  return HOME_CITY_MARKERS.some(marker => text.includes(marker));
}

/**
 * @param {{company: string, role: string, location: string, url?: string, reportRef?: string|null}} job
 * @returns {{blocked: boolean, entry?: object}} blocked=true means this job was
 *   routed to needs-input and Apply Agent must NOT auto-submit it this pass.
 */
export function checkRelocationGate(job) {
  const location = job?.location || '';

  // No location data at all — don't penalize missing data (same rule
  // portals.yml's own location_filter follows), let it through.
  if (!location.trim()) return { blocked: false };

  if (locationLooksRemoteOrHybrid(location)) return { blocked: false };
  if (locationLooksLikeHomeCity(location)) return { blocked: false };

  // Onsite, and not Pune: relocation would be required. Flag, don't auto-apply.
  const entry = addEntry({
    source: 'relocation',
    reason: `Onsite role in "${location}" — not Pune, not remote/hybrid. Relocation decision needs your input before applying.`,
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
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Remote' }).blocked, false, 'remote role passes through');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Hybrid - Bangalore' }).blocked, false, 'hybrid role passes through even in another city');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: 'Pune, Maharashtra' }).blocked, false, 'Pune-based role passes through');
  assertEqual(checkRelocationGate({ company: 'A', role: 'X', location: '' }).blocked, false, 'missing location is not penalized');

  const result = checkRelocationGate({ company: 'Acme', role: 'Engineer', location: 'Bangalore, India', url: 'https://example.com/1' });
  assertEqual(result.blocked, true, 'onsite non-Pune role is blocked and routed to needs-input');
  assertEqual(result.entry.source, 'relocation', 'the routed entry has source: relocation');
  assertEqual(result.entry.status, 'open', 'the routed entry starts open');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (left one relocation self-test entry in data/needs-input-queue.json)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
