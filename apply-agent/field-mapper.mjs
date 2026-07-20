#!/usr/bin/env node
/**
 * apply-agent/field-mapper.mjs — maps extracted ApplyField[] to candidate answers
 *
 * Pure, zero-LLM label matching. Two of the spec's explicit pause triggers
 * live here as detection logic (Section 8):
 *   - "a form field with no mapping in the candidate profile" -> unmapped[]
 *     (only when the field is required — an optional field with no mapping
 *     is safely left blank, not a pause)
 *   - "salary expectation field requiring a specific number" -> salaryFields[]
 *
 * File-upload fields (resume/CV) are intentionally excluded from answers —
 * fillSession() takes the resolved CV path as a separate argument.
 */

const LABEL_RULES = [
  { pattern: /first\s*name/i, key: 'firstName' },
  { pattern: /last\s*name|surname/i, key: 'lastName' },
  { pattern: /full\s*name|^\s*name\s*$/i, key: 'fullName' },
  { pattern: /e-?mail/i, key: 'email' },
  { pattern: /phone|mobile|contact\s*number/i, key: 'phone' },
  { pattern: /linkedin/i, key: 'linkedin' },
  { pattern: /github/i, key: 'github' },
  { pattern: /portfolio|personal\s*(site|website)|website/i, key: 'portfolio' },
  { pattern: /current\s*location|^\s*location\s*$|^\s*city\s*$/i, key: 'location' },
];

const SALARY_PATTERN = /salary|compensation|\bctc\b|expected\s*pay|pay\s*expectation|desired\s*(pay|salary)/i;

/**
 * @param {import('../web/src/lib/apply/extract.ts').ApplyField[]} fields
 * @param {object} profile - parsed config/profile.yml
 * @returns {{answers: Record<string,string>, unmapped: object[], salaryFields: object[]}}
 */
export function mapFields(fields, profile) {
  const candidate = profile?.candidate || {};
  const fullName = candidate.full_name || '';
  const [firstName = '', ...rest] = fullName.split(' ').filter(Boolean);
  const lastName = rest.join(' ');

  const values = {
    firstName,
    lastName,
    fullName,
    email: candidate.email || '',
    phone: candidate.phone || '',
    linkedin: candidate.linkedin || '',
    github: candidate.github || '',
    portfolio: candidate.portfolio_url || '',
    location: candidate.location || '',
  };

  const answers = {};
  const unmapped = [];
  const salaryFields = [];

  for (const field of fields || []) {
    if (field.type === 'file') continue; // handled via cvPath, not answers

    if (SALARY_PATTERN.test(field.label || '')) {
      salaryFields.push(field);
      continue;
    }

    const rule = LABEL_RULES.find(r => r.pattern.test(field.label || ''));
    const value = rule ? values[rule.key] : undefined;

    if (value) {
      answers[field.id] = value;
    } else if (field.required) {
      unmapped.push(field);
    }
    // Optional + unmapped: left blank, not a pause trigger.
  }

  return { answers, unmapped, salaryFields };
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
  const profile = {
    candidate: {
      full_name: 'Aditya Singh',
      email: 'aditherealone@gmail.com',
      phone: '+91 9172711846',
      linkedin: 'linkedin.com/in/aditya-singh-tech',
      github: 'github.com/Aditya11846',
      location: 'Pune, Maharashtra, India',
    },
  };

  const fields = [
    { id: 'f1', type: 'text', label: 'First Name', required: true },
    { id: 'f2', type: 'text', label: 'Last Name', required: true },
    { id: 'f3', type: 'email', label: 'Email Address', required: true },
    { id: 'f4', type: 'tel', label: 'Phone Number', required: false },
    { id: 'f5', type: 'url', label: 'LinkedIn Profile', required: false },
    { id: 'f6', type: 'file', label: 'Resume/CV', required: true },
    { id: 'f7', type: 'text', label: 'Desired Salary (annual)', required: true },
    { id: 'f8', type: 'textarea', label: 'Why do you want to work here?', required: true },
    { id: 'f9', type: 'text', label: 'Twitter handle', required: false },
  ];

  const { answers, unmapped, salaryFields } = mapFields(fields, profile);

  assertEqual(answers.f1, 'Aditya', 'maps First Name from full_name');
  assertEqual(answers.f2, 'Singh', 'maps Last Name from full_name');
  assertEqual(answers.f3, 'aditherealone@gmail.com', 'maps Email Address');
  assertEqual(answers.f4, '+91 9172711846', 'maps Phone Number');
  assertEqual(answers.f5, 'linkedin.com/in/aditya-singh-tech', 'maps LinkedIn Profile');
  assertEqual('f6' in answers, false, 'file-upload field is excluded from answers');
  assertEqual('f7' in answers, false, 'salary field is excluded from answers');
  assertEqual(salaryFields.map(f => f.id), ['f7'], 'salary field is flagged, not answered');
  assertEqual(unmapped.map(f => f.id), ['f8'], 'required+unmapped field (essay question) is flagged');
  assertEqual('f9' in answers, false, 'optional unmapped field (Twitter) is left blank');
  assertEqual(unmapped.some(f => f.id === 'f9'), false, 'optional unmapped field is NOT a pause trigger');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) runSelfTest();
}
