#!/usr/bin/env node
/**
 * senior-search/compute-fit.mjs — per-posting judgment signals for Amit Kumar
 * Singh's search (comp effective-value, India-hireability confidence, domain
 * fit), plus the blended ranking function.
 *
 * Follows signal-agent/compute-heat.mjs's shape deliberately: pure, exported,
 * unit-testable core functions; a thin CLI on top; a --self-test suite. Never
 * touches modes/_shared.md's existing 1-5 scoring formula — these are
 * additive signals meant to be attached to a report's Machine Summary
 * (comp_effective_value_inr, india_hireability_confidence, domain_fit_score),
 * the same pattern company_heat already established.
 *
 * IMPORTANT — tax-slab caveat: the Indian income-tax slab table below is a
 * simplified, illustrative approximation of the new-regime structure, kept
 * only precise enough for RELATIVE ranking between offers (comparing offer A
 * vs offer B), not for real tax filing or a promised take-home number. It
 * will drift from the actual notified slabs over time — verify against the
 * current Finance Act before relying on it for an actual decision.
 */

// ── Comp effective-value (INR, India-tax-resident) ─────────────────────────

// Illustrative new-regime slabs (annual taxable income, INR) — see caveat above.
const INDIA_TAX_SLABS = [
  { upTo: 400_000, rate: 0 },
  { upTo: 800_000, rate: 0.05 },
  { upTo: 1_200_000, rate: 0.10 },
  { upTo: 1_600_000, rate: 0.15 },
  { upTo: 2_000_000, rate: 0.20 },
  { upTo: 2_400_000, rate: 0.25 },
  { upTo: Infinity, rate: 0.30 },
];
const STANDARD_DEDUCTION_INR = 75_000;
const CESS_RATE = 0.04;
// Section 87A-style rebate: illustrative threshold below which effective tax
// is treated as zero for ranking purposes (approximate, not exact law).
const REBATE_TAXABLE_INCOME_CEILING_INR = 1_200_000;

/** Pure slab-based tax calculation on already-computed taxable income. */
export function computeIndianTaxINR(taxableIncomeInr) {
  const income = Math.max(0, Number(taxableIncomeInr) || 0);
  if (income <= REBATE_TAXABLE_INCOME_CEILING_INR) return 0;

  let tax = 0;
  let lower = 0;
  for (const { upTo, rate } of INDIA_TAX_SLABS) {
    if (income <= lower) break;
    const slabAmount = Math.min(income, upTo) - lower;
    if (slabAmount > 0) tax += slabAmount * rate;
    lower = upTo;
    if (income <= upTo) break;
  }
  return Math.round(tax * (1 + CESS_RATE));
}

// Default static FX table used when no live rate is supplied/fetched — kept
// only as a last-resort fallback so the pure function never throws; a real
// invocation should pass a fresh `fxRates` map (see fetchFxRatesToInr below).
const FALLBACK_FX_TO_INR = {
  INR: 1,
  USD: 87,
  EUR: 94,
  GBP: 110,
};

/**
 * Fetch today's FX rates to INR from a free public API. Injectable
 * `fetchImpl` for tests (mirrors compute-heat.mjs's githubActivityScore
 * pattern) — never throws; falls back to the static table on any failure.
 */
export async function fetchFxRatesToInr({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl('https://open.er-api.com/v6/latest/INR');
    if (!res.ok) return FALLBACK_FX_TO_INR;
    const json = await res.json();
    const rates = json?.rates;
    if (!rates || typeof rates !== 'object') return FALLBACK_FX_TO_INR;
    // API gives INR->X; invert to X->INR for our use.
    const toInr = { INR: 1 };
    for (const [code, rateFromInr] of Object.entries(rates)) {
      const n = Number(rateFromInr);
      if (n > 0) toInr[code] = 1 / n;
    }
    return toInr;
  } catch {
    return FALLBACK_FX_TO_INR;
  }
}

/**
 * Effective annual value, in net INR, of one comp component.
 *
 * @param {{amount:number, currency:string, kind:'cash'|'public_equity'|'private_equity'}} input
 * @param {Record<string,number>} fxRatesToInr - currency code -> INR multiplier.
 * @returns {{grossInr:number, weightedGrossInr:number, netInr:number|null, excluded:boolean, note:string}}
 */
export function computeEffectiveValueINR({ amount, currency = 'USD', kind = 'cash' } = {}, fxRatesToInr = FALLBACK_FX_TO_INR) {
  const rate = fxRatesToInr[String(currency).toUpperCase()] ?? FALLBACK_FX_TO_INR[String(currency).toUpperCase()];
  if (!rate) {
    return { grossInr: 0, weightedGrossInr: 0, netInr: null, excluded: true, note: `no FX rate for ${currency}` };
  }
  const grossInr = Math.round((Number(amount) || 0) * rate);

  if (kind === 'private_equity') {
    // Resolved direction: private-company equity is informational only, never
    // counted toward the ranked effective value — priority is reliable income
    // after an 18-month gap, not speculative illiquid upside.
    return { grossInr, weightedGrossInr: 0, netInr: null, excluded: true, note: 'private equity — informational only, excluded from ranked value' };
  }

  // Public RSUs: real and liquid, but volatile/vesting-cliff risk — haircut
  // rather than face value (resolved direction: ~40-50% off).
  const weight = kind === 'public_equity' ? 0.5 : 1;
  const weightedGrossInr = Math.round(grossInr * weight);
  const netInr = Math.max(0, weightedGrossInr - computeIndianTaxINR(Math.max(0, weightedGrossInr - STANDARD_DEDUCTION_INR)));

  return { grossInr, weightedGrossInr, netInr, excluded: false, note: kind === 'public_equity' ? 'public equity, 50% haircut applied' : 'cash, full weight' };
}

/**
 * Sum multiple comp components (base + bonus + equity, mixed currencies/kinds)
 * into one net-INR effective value for ranking. Excluded components (private
 * equity) are summed separately as an informational-only figure.
 */
export function computeTotalEffectiveValueINR(components = [], fxRatesToInr = FALLBACK_FX_TO_INR) {
  let netInr = 0;
  let excludedGrossInr = 0;
  const details = [];
  for (const component of components) {
    const result = computeEffectiveValueINR(component, fxRatesToInr);
    details.push(result);
    if (result.excluded) excludedGrossInr += result.grossInr;
    else netInr += result.netInr ?? 0;
  }
  return { netInr: Math.round(netInr), excludedGrossInr: Math.round(excludedGrossInr), details };
}

// ── India-hireability confidence (weighted, not binary) ────────────────────

const HIREABILITY_WEIGHTS = {
  indiaEntityEvidence: 55,
  eorPartnerMentioned: 45,
  eligibleCountriesListsIndia: 60, // direct evidence, but rare
  noEvidence: 30, // baseline when nothing is known either way — silence isn't proof of exclusion
};

const EOR_PROVIDER_NAMES = ['deel', 'remote.com', 'multiplier', 'papaya global', 'papaya', 'rippling', 'oyster', 'globalization partners', 'g-p'];

/**
 * Weighted India-hireability confidence, 0-100. Never a hard binary — per the
 * resolved brainstorm direction, this feeds a blended rank, not a pass/fail
 * gate, because most postings carry no explicit evidence either way.
 *
 * @param {{jdText?:string, companyHasIndiaEntity?:boolean, mentionsEOR?:boolean}} input
 */
export function scoreIndiaHireability({ jdText = '', companyHasIndiaEntity = false, mentionsEOR = false } = {}) {
  const text = String(jdText || '').toLowerCase();
  const explicitEorMention = mentionsEOR || EOR_PROVIDER_NAMES.some(name => text.includes(name));
  const eligibleCountriesListsIndia = /eligible countries?[^.]*india|must be (?:located|based) in[^.]*india|open to candidates in[^.]*india/.test(text);

  if (companyHasIndiaEntity) return clamp0to100(HIREABILITY_WEIGHTS.indiaEntityEvidence + (eligibleCountriesListsIndia ? 20 : 0));
  if (eligibleCountriesListsIndia) return clamp0to100(HIREABILITY_WEIGHTS.eligibleCountriesListsIndia + (explicitEorMention ? 15 : 0));
  if (explicitEorMention) return clamp0to100(HIREABILITY_WEIGHTS.eorPartnerMentioned);
  return HIREABILITY_WEIGHTS.noEvidence;
}

// ── Domain fit (near-gate) ──────────────────────────────────────────────────

// Deterministic keyword-weighted heuristic used as the default, pure,
// network-free scorer. An agent driving a real evaluation should prefer
// passing an LLM-judged score directly via --domain-fit (same
// agent-supplies-the-nuanced-signal pattern as compute-heat.mjs's
// --funding/--reddit/--linkedin flags) rather than relying on this heuristic
// alone — keyword matching is a floor, not a replacement for reading the JD.
const DOMAIN_KEYWORDS = {
  strong: ['zero trust', 'endpoint encryption', 'endpoint security', 'dlp', 'data loss prevention', 'uefi', 'kernel driver', 'embedded systems', 'rtos', 'vpn', 'disk encryption', 'tcg opal', 'sdk architecture'],
  moderate: ['c++', 'embedded', 'firmware', 'security engineer', 'systems engineer', 'network security', 'cryptography', 'encryption'],
};

export function scoreDomainFit(jdText = '') {
  const text = String(jdText || '').toLowerCase();
  let score = 0;
  for (const kw of DOMAIN_KEYWORDS.strong) if (text.includes(kw)) score += 15;
  for (const kw of DOMAIN_KEYWORDS.moderate) if (text.includes(kw)) score += 6;
  return clamp0to100(score);
}

// Below this, a posting is excluded from the ranked list entirely (near-gate,
// per the resolved direction) — a perfectly-paid, definitely-hireable-in-India
// role that's a domain mismatch (e.g. sales) shouldn't surface.
export const DOMAIN_FIT_GATE_THRESHOLD = 20;

// ── Blended rank ─────────────────────────────────────────────────────────────

const RANK_WEIGHTS = {
  effectiveValue: 0.45,
  hireability: 0.30,
  stability: 0.25, // heat - layoffRisk, net
};

/**
 * Combine signals into one rank. Domain fit is a near-gate (excludes below
 * threshold); everything past the gate gets a weighted blend of comp
 * effective-value (normalized against a reference ceiling), India-hireability
 * confidence, and net company stability (heat minus layoff risk) — never a
 * simple average of independent scorecards.
 *
 * @param {{domainFit:number, netEffectiveValueInr:number, hireability:number, heat?:number, layoffRisk?:number, effectiveValueCeilingInr?:number}} input
 */
export function blendRank({ domainFit, netEffectiveValueInr, hireability, heat = 50, layoffRisk = 0, effectiveValueCeilingInr = 6_000_000 }) {
  if (domainFit < DOMAIN_FIT_GATE_THRESHOLD) {
    return { rank: 0, excluded: true, reason: `domain fit ${domainFit} below gate threshold ${DOMAIN_FIT_GATE_THRESHOLD}` };
  }
  const effectiveValueScore = clamp0to100((netEffectiveValueInr / effectiveValueCeilingInr) * 100);
  const stabilityScore = clamp0to100(heat - layoffRisk + 50); // centers a neutral heat=50/risk=0 at score 50
  const rank = Math.round(
    effectiveValueScore * RANK_WEIGHTS.effectiveValue +
    hireability * RANK_WEIGHTS.hireability +
    stabilityScore * RANK_WEIGHTS.stability
  );
  return { rank, excluded: false, effectiveValueScore, stabilityScore };
}

function clamp0to100(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
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
  // Tax slab sanity (not exact-law assertions — internal consistency only).
  assertEqual(computeIndianTaxINR(1_000_000), 0, 'taxable income at/below rebate ceiling owes zero tax');
  assert(computeIndianTaxINR(3_000_000) > 0, 'taxable income well above rebate ceiling owes some tax');
  assert(computeIndianTaxINR(3_000_000) < 3_000_000, 'tax never exceeds the taxable income itself');
  assert(computeIndianTaxINR(5_000_000) > computeIndianTaxINR(3_000_000), 'tax is monotonically increasing with income');

  // Effective value: cash vs public equity vs private equity treatment.
  const cash = computeEffectiveValueINR({ amount: 150_000, currency: 'USD', kind: 'cash' }, { USD: 87 });
  assertEqual(cash.excluded, false, 'cash component is never excluded');
  assertEqual(cash.grossInr, 150_000 * 87, 'cash FX conversion is exact');
  assert(cash.netInr < cash.grossInr, 'net INR is less than gross after tax');

  const publicEquity = computeEffectiveValueINR({ amount: 100_000, currency: 'USD', kind: 'public_equity' }, { USD: 87 });
  assertEqual(publicEquity.weightedGrossInr, Math.round(100_000 * 87 * 0.5), 'public equity gets a 50% haircut before tax');

  const privateEquity = computeEffectiveValueINR({ amount: 500_000, currency: 'USD', kind: 'private_equity' }, { USD: 87 });
  assertEqual(privateEquity.excluded, true, 'private equity is excluded from ranked value');
  assertEqual(privateEquity.netInr, null, 'private equity has no net value, informational only');

  const total = computeTotalEffectiveValueINR(
    [
      { amount: 120_000, currency: 'USD', kind: 'cash' },
      { amount: 40_000, currency: 'USD', kind: 'public_equity' },
      { amount: 300_000, currency: 'USD', kind: 'private_equity' },
    ],
    { USD: 87 }
  );
  assert(total.excludedGrossInr === 300_000 * 87, 'total correctly separates excluded private-equity gross');
  assert(total.netInr > 0, 'total nets cash + weighted public equity');

  // India-hireability: weighted, never binary.
  assert(scoreIndiaHireability({}) === HIREABILITY_WEIGHTS.noEvidence, 'no evidence -> baseline confidence, not zero');
  assert(scoreIndiaHireability({ companyHasIndiaEntity: true }) > scoreIndiaHireability({ mentionsEOR: true }), 'India entity evidence outweighs EOR mention alone');
  assert(scoreIndiaHireability({ jdText: 'We hire globally via Deel.' }) > HIREABILITY_WEIGHTS.noEvidence, 'EOR provider name in JD text is detected');
  assert(
    scoreIndiaHireability({ jdText: 'Open to candidates in the US, UK, and India.' }) > HIREABILITY_WEIGHTS.noEvidence,
    'eligible-countries-list mentioning India is detected'
  );

  // Domain fit + gate.
  assert(scoreDomainFit('Great ping pong table and free snacks, sales role.') < DOMAIN_FIT_GATE_THRESHOLD, 'irrelevant JD scores below the gate');
  assert(scoreDomainFit('Build our Zero Trust VPN and endpoint encryption stack in C++, UEFI kernel driver work.') >= DOMAIN_FIT_GATE_THRESHOLD, 'on-domain JD clears the gate');

  // Blend rank: domain gate excludes regardless of how good other signals are.
  const gated = blendRank({ domainFit: 5, netEffectiveValueInr: 10_000_000, hireability: 100, heat: 100, layoffRisk: 0 });
  assertEqual(gated.excluded, true, 'low domain fit excludes even a perfectly-paid, perfectly-hireable posting');

  const ranked = blendRank({ domainFit: 80, netEffectiveValueInr: 3_000_000, hireability: 70, heat: 60, layoffRisk: 10 });
  assertEqual(ranked.excluded, false, 'passing domain fit produces a real rank');
  assert(ranked.rank > 0 && ranked.rank <= 100, 'rank is a 0-100 number');

  const higherPay = blendRank({ domainFit: 80, netEffectiveValueInr: 5_500_000, hireability: 70, heat: 60, layoffRisk: 10 });
  assert(higherPay.rank > ranked.rank, 'higher effective value increases rank, all else equal');

  // FX fetch never throws even when the network call fails.
  const fxFailing = await fetchFxRatesToInr({ fetchImpl: async () => { throw new Error('network down'); } });
  assertEqual(fxFailing, FALLBACK_FX_TO_INR, 'fetchFxRatesToInr falls back to static table on failure, never throws');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('compute-fit.mjs')) {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
  } else {
    console.log('Usage: node senior-search/compute-fit.mjs --self-test');
    console.log('This module is primarily a library — import its functions from an evaluation script.');
  }
}
