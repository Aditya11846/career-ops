#!/usr/bin/env node
/**
 * apply-agent/pause-triggers.mjs — shared "should this job halt?" checks
 *
 * Tier 1's orchestrator.ts inlines these checks (blocking session issues,
 * unmapped required fields, salary-number fields). Tier 2 (LinkedIn/Naukri)
 * needs the SAME checks plus two more (MFA/OTP, warm-intro — the latter
 * lives in gates/warm-intro.mjs since it needs a live connections lookup,
 * not just static field/issue data), run before every field fill per job.
 * Factored out here so both tiers share one definition instead of drifting.
 *
 * Each check is pure (no side effects, no needs-input writes) — the CALLER
 * decides what to do with a pause (queue to needs-input, close the session,
 * move to the next job in the day's queue). This mirrors gates/relocation.mjs
 * and gates/warm-intro.mjs's own separation, except those two DO write to
 * needs-input themselves since they're single-purpose gates; this module is
 * a multi-check triage step used inside the fill loop, so the caller (who
 * already has company/role/report context) writes the entry.
 */

const BLOCKING_ISSUE_CODES = new Set(['captcha-present', 'bot-challenge', 'login-wall', 'auth-required', 'mfa-required']);

const MFA_TITLE_PATTERN = /verify (your identity|it'?s you)|two-factor|2fa|one-time (code|passcode)|enter the code|security code/i;
const MFA_LABEL_PATTERN = /\b(otp|one-time code|verification code|security code|2fa code)\b/i;

/**
 * @param {{level: string, code: string, message: string}[]} issues - session.issues from openSession()
 * @returns {{paused: boolean, code?: string, reason?: string}}
 */
export function checkBlockingIssues(issues = []) {
  const hit = issues.find(i => i.level === 'block' || BLOCKING_ISSUE_CODES.has(i.code));
  if (!hit) return { paused: false };
  return { paused: true, code: hit.code, reason: hit.message };
}

/**
 * MFA/OTP is often not surfaced as a session issue (it's a mid-flow
 * navigation, not a static page classification) — this checks the page
 * title/fields directly, called after any point the driver expects the flow
 * might branch into a 2FA challenge (LinkedIn/Naukri both can, mid-login or
 * mid-apply for high-risk-flagged accounts).
 * @param {{title?: string, fields?: {label?: string}[]}} pageState
 */
export function checkMfaChallenge(pageState = {}) {
  const title = pageState.title || '';
  if (MFA_TITLE_PATTERN.test(title)) return { paused: true, code: 'mfa-required', reason: `The page looks like an MFA/verification challenge ("${title}") — complete it yourself, then resume.` };
  const mfaField = (pageState.fields || []).find(f => MFA_LABEL_PATTERN.test(f.label || ''));
  if (mfaField) return { paused: true, code: 'mfa-required', reason: `Form asks for an MFA/OTP code ("${mfaField.label}") — this can't be automated, complete it yourself.` };
  return { paused: false };
}

/** @param {{id: string, label: string}[]} unmapped - from field-mapper.mjs's mapFields() */
export function checkUnmappedFields(unmapped = []) {
  if (unmapped.length === 0) return { paused: false };
  return {
    paused: true,
    code: 'unmapped_field',
    reason: `${unmapped.length} required field(s) with no profile mapping: ${unmapped.map(f => f.label).join(', ')}`,
  };
}

/** @param {{id: string, label: string}[]} salaryFields - from field-mapper.mjs's mapFields() */
export function checkSalaryFields(salaryFields = []) {
  if (salaryFields.length === 0) return { paused: false };
  return {
    paused: true,
    code: 'salary_field',
    reason: `Salary expectation field requires a specific number: ${salaryFields.map(f => f.label).join(', ')}`,
  };
}

/**
 * Runs every static check in priority order (blocking issues first — no
 * point reporting unmapped fields on a page that's actually a CAPTCHA wall)
 * and returns the FIRST pause hit, or {paused: false} if the job is clear to
 * fill. Does not include checkMfaChallenge() — that one needs a specific
 * mid-flow pageState the caller must supply separately when relevant.
 * @param {{issues?: object[], unmapped?: object[], salaryFields?: object[]}} input
 */
export function checkPauseTriggers({ issues = [], unmapped = [], salaryFields = [] } = {}) {
  const blocking = checkBlockingIssues(issues);
  if (blocking.paused) return blocking;
  const unmappedResult = checkUnmappedFields(unmapped);
  if (unmappedResult.paused) return unmappedResult;
  const salaryResult = checkSalaryFields(salaryFields);
  if (salaryResult.paused) return salaryResult;
  return { paused: false };
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
  assertEqual(checkBlockingIssues([]).paused, false, 'no issues -> not paused');
  assertEqual(checkBlockingIssues([{ level: 'info', code: 'ai-interpreted', message: 'x' }]).paused, false, 'an info-level issue does not pause');
  const capt = checkBlockingIssues([{ level: 'block', code: 'captcha-present', message: 'has a captcha' }]);
  assertEqual(capt.paused, true, 'a block-level issue pauses');
  assertEqual(capt.code, 'captcha-present', 'the pause carries the issue code');

  assertEqual(checkMfaChallenge({ title: 'Application for Engineer' }).paused, false, 'a normal title is not an MFA challenge');
  assertEqual(checkMfaChallenge({ title: 'Verify your identity' }).paused, true, 'an MFA-shaped title pauses');
  assertEqual(checkMfaChallenge({ fields: [{ label: 'Enter your OTP code' }] }).paused, true, 'an OTP-labeled field pauses');
  assertEqual(checkMfaChallenge({ fields: [{ label: 'First name' }] }).paused, false, 'an ordinary field label does not pause');

  assertEqual(checkUnmappedFields([]).paused, false, 'no unmapped fields -> not paused');
  const unmapped = checkUnmappedFields([{ id: 'co1', label: 'Why us?' }]);
  assertEqual(unmapped.paused, true, 'an unmapped required field pauses');
  assertEqual(unmapped.code, 'unmapped_field', 'unmapped pause carries the right code');

  assertEqual(checkSalaryFields([]).paused, false, 'no salary fields -> not paused');
  assertEqual(checkSalaryFields([{ id: 'co2', label: 'Expected CTC' }]).paused, true, 'a salary field pauses');

  // Priority order: blocking issues win over unmapped/salary even if both present.
  const combined = checkPauseTriggers({
    issues: [{ level: 'block', code: 'login-wall', message: 'sign in first' }],
    unmapped: [{ id: 'co1', label: 'Why us?' }],
    salaryFields: [{ id: 'co2', label: 'Expected CTC' }],
  });
  assertEqual(combined.code, 'login-wall', 'checkPauseTriggers prioritizes blocking issues over unmapped/salary');

  const clear = checkPauseTriggers({ issues: [], unmapped: [], salaryFields: [] });
  assertEqual(clear.paused, false, 'checkPauseTriggers passes clean when nothing trips');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED (pure functions, no files touched)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
