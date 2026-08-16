#!/usr/bin/env node
/**
 * apply-agent/gates/warm-intro.mjs — 1st/2nd-degree LinkedIn connection gate
 *
 * Tier 2 (LinkedIn) only. A 1st or 2nd-degree connection at the target
 * company is a referral opportunity a cold Easy Apply would waste — route to
 * needs-input with a suggested referral-ask message instead of auto-applying,
 * modeled on gates/relocation.mjs's "annotate, never silently drop" pattern.
 *
 * This module does NOT perform the LinkedIn connections lookup itself — that
 * requires a live, logged-in LinkedIn session (apply-agent/session-store/),
 * which is Tier 2's own driver's job to query (once per job, before firing)
 * and pass in as `connectionDegree`. Keeping the lookup out of this module
 * keeps it pure and unit-testable without a browser, same as relocation.mjs.
 */

import { addEntry } from '../../needs-input.mjs';

const REFERRAL_DEGREES = new Set([1, 2]);

/**
 * @param {{
 *   company: string, role: string, url?: string, reportRef?: string|null,
 *   connectionDegree: number|null,
 *   connectionName?: string|null,
 * }} job - connectionDegree: 1, 2, 3, or null/undefined if unknown/unchecked.
 *   null means "no lookup was possible" — treated as pass-through, same as
 *   relocation.mjs's "no location data -> don't penalize missing data" rule.
 * @returns {{blocked: boolean, entry?: object}}
 */
export function checkWarmIntroGate(job) {
  const degree = job?.connectionDegree;

  if (degree === null || degree === undefined) return { blocked: false };
  if (!REFERRAL_DEGREES.has(degree)) return { blocked: false };

  const who = job.connectionName ? ` (${job.connectionName})` : '';
  const suggestedMessage = job.connectionName
    ? `Hi ${job.connectionName.split(' ')[0]}, I just applied for the ${job.role} role at ${job.company} and saw we're connected — would you be open to a quick referral or a pointer to the right person? Happy to share my CV/background. Thanks either way!`
    : `Hi, I just applied for the ${job.role} role at ${job.company} and saw we're connected — would you be open to a quick referral or a pointer to the right person? Happy to share my CV/background. Thanks either way!`;

  const entry = addEntry({
    source: 'warm_intro',
    reason: `${degree === 1 ? '1st' : '2nd'}-degree LinkedIn connection${who} at ${job.company} — a referral ask could beat a cold Easy Apply. Paused before applying so you can reach out first.`,
    company: job.company || '',
    role: job.role || '',
    report_ref: job.reportRef ?? null,
    context: { url: job.url ?? null, connectionDegree: degree, connectionName: job.connectionName ?? null, suggestedMessage },
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
  assertEqual(checkWarmIntroGate({ company: 'A', role: 'X', connectionDegree: 3 }).blocked, false, '3rd-degree connection passes through');
  assertEqual(checkWarmIntroGate({ company: 'A', role: 'X', connectionDegree: null }).blocked, false, 'unknown/unchecked connection passes through (no lookup was possible)');
  assertEqual(checkWarmIntroGate({ company: 'A', role: 'X' }).blocked, false, 'missing connectionDegree passes through');

  const result = checkWarmIntroGate({ company: 'Acme', role: 'Engineer', connectionDegree: 1, connectionName: 'Jane Doe', url: 'https://example.com/1' });
  assertEqual(result.blocked, true, '1st-degree connection is blocked and routed to needs-input');
  assertEqual(result.entry.source, 'warm_intro', 'the routed entry has source: warm_intro');
  assertEqual(result.entry.status, 'open', 'the routed entry starts open');
  assertEqual(result.entry.context.connectionDegree, 1, 'the entry context carries the connection degree');
  assertEqual(result.entry.context.suggestedMessage.includes('Jane'), true, 'the suggested message is personalized with the connection\'s first name');

  const result2 = checkWarmIntroGate({ company: 'Acme', role: 'Engineer', connectionDegree: 2 });
  assertEqual(result2.blocked, true, '2nd-degree connection is also blocked');
  assertEqual(result2.entry.context.connectionName, null, 'an anonymous connection still produces a generic suggested message');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (left two warm_intro self-test entries in data/needs-input-queue.json)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
