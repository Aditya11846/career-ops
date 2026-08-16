#!/usr/bin/env node
/**
 * filter-inbox-by-fit.mjs — domain-fit triage pass over data/pipeline.md
 *
 * A scan against a broad company (e.g. Thales's Workday tenant covers their
 * entire aerospace/defense/space conglomerate, not just their CipherTrust
 * security line) pulls in a lot of noise, because scan.mjs's title_filter is
 * deliberately empty for this search (title doesn't matter — comp and domain
 * fit do). This script runs AFTER a scan and moves anything that clearly
 * isn't Zero-Trust/endpoint-security/embedded-systems-relevant out of the
 * active pending list, using the title+location text (cheap, available for
 * every provider) scored by compute-fit.mjs's scoreDomainFit()/
 * scoreDomainFit() heuristic already built and tested, against a threshold
 * calibrated for title-length text (see compute-fit.mjs's exported
 * TITLE_FIT_MIN_SCORE).
 *
 * Deliberately NOT a modification of scan.mjs itself — that's career-ops' own
 * shared system-layer scanner; this domain-specific triage logic belongs in
 * its own script run afterward, same as merge-tracker.mjs is run "after each
 * batch" rather than wired into the batch runner.
 *
 * Filtered entries move to a SEPARATE file, data/pipeline-filtered.md — not a
 * same-file section — because web/src/lib/career-ops.ts's readInbox() scans
 * data/pipeline.md for ANY checkbox line regardless of heading, so a same-file
 * section would still show up in the dashboard. A separate file keeps them
 * genuinely out of the active view while never deleting anything (archive,
 * don't erase — same principle as the workspace consolidation).
 *
 * A URL moving out of pipeline.md is never re-scanned as "new" on the next
 * scan — scan.mjs's loadSeenUrls() also checks data/scan-history.tsv, which
 * every scanned URL is written to regardless of which file currently lists it.
 *
 * Usage:
 *   node filter-inbox-by-fit.mjs [--dry-run] [--summary]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { scoreDomainFit, classifyGeoEligibility, GEO_GATE_CONFIDENCE_THRESHOLD, TITLE_FIT_MIN_SCORE } from './compute-fit.mjs';
import { checkLivenessViaApi, checkLivenessViaFetch } from './liveness-api.mjs';
import { loadBlacklist } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
// Checked FIRST, before domain-fit/geo/liveness — a pure Map lookup, the
// cheapest possible gate, and there's no reason to score/geo-classify/
// liveness-check something the user already said they never want to see
// again. See loadBlacklist()/parseBlacklist() in scan.mjs (#1742) — this
// script reuses that parsing as-is, never reimplements it.
const BLACKLIST_FILTERED_PATH = join(ROOT, 'data/pipeline-blacklisted-filtered.md');
const FILTERED_PATH = join(ROOT, 'data/pipeline-filtered.md');
// SEPARATE from the domain-fit filtered file on purpose (2026-08-02 brainstorm
// item #6, "make it visible, not a black box") — a posting excluded for
// "wrong domain" and one excluded for "structurally unreachable from India"
// are different failure modes with different fixes (broaden keywords vs.
// nothing to fix, it's just not viable), so they stay in separate files
// rather than one undifferentiated "filtered" bucket.
const GEO_FILTERED_PATH = join(ROOT, 'data/pipeline-geo-filtered.md');
// A third, separate failure mode from domain-fit and geo-fit: the posting
// itself is gone (404/410, or a hard "no longer available" body pattern).
// Confirmed live 2026-08-03 — a Cox Automotive posting scanned in from The
// Muse's API one day was already 404 the next; it still passed domain+geo
// fit and got ranked/badged as a top pick, so the evaluate connector burned
// a real evaluate-job discovering it was dead (the agent correctly refused
// to fabricate a score, per AGENTS.md's liveness gate, but the token spend
// was still wasted). Checked here, at scan-triage time, for free/cheap —
// see checkLivenessViaApi/checkLivenessViaFetch in liveness-api.mjs.
const DEAD_FILTERED_PATH = join(ROOT, 'data/pipeline-dead-filtered.md');
// How many liveness checks to run concurrently. Bounded so a large Pending
// section doesn't fire 200+ simultaneous outbound requests at once.
const LIVENESS_CONCURRENCY = 8;

// TITLE_FIT_MIN_SCORE (the cheap title/location-only triage bar, much lower
// than DOMAIN_FIT_GATE_THRESHOLD's full-JD-text bar) now lives in
// compute-fit.mjs, exported, so this script and web/src/lib/core/scan.ts
// share one definition instead of each keeping their own copy.

const PENDING_MARKERS = ['## Pending', '## Pendientes'];

const BLACKLIST_FILTERED_SKELETON = `# Pipeline — Filtered (blacklisted company)

Entries moved here by filter-inbox-by-fit.mjs — the company appears in
data/blacklist.md, the user's own do-not-apply list (user layer, opt-in,
never auto-populated). Checked FIRST, before domain-fit/geo/liveness —
cheapest possible gate (a pure map lookup), and there is no reason to score,
geo-classify, or liveness-check something that was never going anywhere. See
loadBlacklist()/parseBlacklist() in scan.mjs for the parsing logic. Nothing
here is deleted; move an entry back into data/pipeline.md's "## Pending"
section manually if it was filtered by mistake (or remove the row from
data/blacklist.md so future scans stop excluding it too).

## Blacklisted

`;

const FILTERED_SKELETON = `# Pipeline — Filtered (low domain fit)

Entries moved here by filter-inbox-by-fit.mjs — title/location scored zero
domain-relevant keywords against the Zero Trust / endpoint-security /
embedded-systems domain (compute-fit.mjs's scoreDomainFit()). Nothing here is
deleted; move an entry back into data/pipeline.md's "## Pending" section
manually if it was filtered by mistake.

## Filtered

`;

const GEO_FILTERED_SKELETON = `# Pipeline — Filtered (geo-restricted, not reachable from India)

Entries moved here by filter-inbox-by-fit.mjs — the location field carried
explicit evidence this posting is restricted to a specific non-India country
(e.g. "USA - Remote", "Canada - Remote AB", a bare US/other city with no
remote qualifier) rather than genuinely global or India-eligible remote.
See compute-fit.mjs's classifyGeoEligibility() for the detection logic and
GEO_GATE_CONFIDENCE_THRESHOLD for the cutoff. This is a DIFFERENT failure
mode from domain-fit filtering (data/pipeline-filtered.md) — these postings
may be a perfect skills match, they are just not viable given a fixed,
India-based, remote-only (or Pune-hybrid) location constraint. Nothing here
is deleted; move an entry back into data/pipeline.md's "## Pending" section
manually if it was filtered by mistake (e.g. a company confirmed elsewhere to
hire via an EOR).

## Geo-filtered

`;

const DEAD_FILTERED_SKELETON = `# Pipeline — Filtered (dead posting)

Entries moved here by filter-inbox-by-fit.mjs — a liveness check (ATS API,
or a plain fetch for non-ATS aggregator mirrors) got a definitive HTTP
404/410 or matched a hard "no longer available" body pattern. See
checkLivenessViaApi/checkLivenessViaFetch in liveness-api.mjs. Conservative
by design: anything ambiguous (network error, redirect, bot-challenge,
403/503, unrecognized shape) stays in data/pipeline.md rather than risk
dropping a real posting. Nothing here is deleted; move an entry back into
data/pipeline.md's "## Pending" section manually if it was filtered by
mistake (the source may have come back, or relisted under the same URL).

## Dead

`;

function parseCheckboxLine(line) {
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const parts = m[2].split('|').map(s => s.trim());
  if (parts.length < 3 || !parts[0]) return null;
  return {
    done: m[1].toLowerCase() === 'x',
    url: parts[0],
    company: parts[1],
    role: parts[2],
    location: parts[3] || undefined,
    compensation: parts[4] || undefined,
    raw: line,
  };
}

function findPendingSectionBounds(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PENDING_MARKERS.includes(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function loadExistingUrlsFrom(path) {
  if (!existsSync(path)) return new Set();
  const text = readFileSync(path, 'utf-8');
  const urls = new Set();
  for (const match of text.matchAll(/- \[[ xX]\] (https?:\/\/\S+)/g)) urls.add(match[1]);
  return urls;
}

/**
 * Free ATS API rung first, plain-fetch fallback second (see liveness-api.mjs).
 * Both rungs are conservative: anything but a definitive 'expired' verdict
 * (network error, 'active', 'uncertain') means "keep it".
 * @param {string} url
 * @returns {Promise<{ result: string, code: string, reason: string } | null>}
 */
async function checkPostingLiveness(url) {
  const viaApi = await checkLivenessViaApi(url).catch(() => null);
  if (viaApi) return viaApi;
  return checkLivenessViaFetch(url).catch(() => null);
}

/**
 * Runs `checkPostingLiveness` over `entries` with at most `limit` in flight at
 * once. Returns entries in the same order, annotated with `.liveness`.
 */
async function checkLivenessBatch(entries, limit) {
  const results = new Array(entries.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      results[i] = { ...entries[i], liveness: await checkPostingLiveness(entries[i].parsed.url) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const summaryOnly = args.includes('--summary');

  if (!existsSync(PIPELINE_PATH)) {
    console.log('data/pipeline.md not found — nothing to filter.');
    return;
  }

  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = text.split('\n');
  const bounds = findPendingSectionBounds(lines);
  if (!bounds) {
    console.log('No "## Pending" section found in data/pipeline.md — nothing to filter.');
    return;
  }

  // Absolute path, explicitly — anchored off ROOT like every other path in
  // this file, not the function's own relative-to-cwd default. Absent file =
  // empty Map = no-op (see loadBlacklist's own contract in scan.mjs).
  const blacklist = loadBlacklist(join(ROOT, 'data/blacklist.md'));
  const alreadyBlacklistFiltered = loadExistingUrlsFrom(BLACKLIST_FILTERED_PATH);
  const alreadyDomainFiltered = loadExistingUrlsFrom(FILTERED_PATH);
  const alreadyGeoFiltered = loadExistingUrlsFrom(GEO_FILTERED_PATH);
  const alreadyDeadFiltered = loadExistingUrlsFrom(DEAD_FILTERED_PATH);
  // `kept` holds passthrough content in original order — blank lines untouched,
  // and postings that passed domain+geo fit as { line, parsed } so the liveness
  // pass below can check and drop the dead ones without disturbing order.
  const kept = [];
  const movedBlacklist = [];
  const movedDomain = [];
  const movedGeo = [];

  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const line = lines[i];
    const parsed = parseCheckboxLine(line);
    if (!parsed) {
      kept.push(line); // blank lines / non-checkbox content pass through untouched
      continue;
    }
    if (alreadyBlacklistFiltered.has(parsed.url) || alreadyDomainFiltered.has(parsed.url) || alreadyGeoFiltered.has(parsed.url) || alreadyDeadFiltered.has(parsed.url)) {
      // Already moved in a prior run — idempotent no-op, drop from pending
      // without re-scoring or duplicating into a filtered file again.
      continue;
    }
    // Gate 0 — blacklist. Cheapest check, so it runs before domain-fit/geo/
    // liveness and skips them entirely for a match — no reason to spend a
    // geo-classification or a live network liveness check on a company the
    // user already opted out of entirely.
    const blacklisted = blacklist.get(normalizeCompany(parsed.company));
    if (blacklisted) {
      movedBlacklist.push({ ...parsed, blacklistReason: blacklisted.reason || 'blacklisted' });
      continue;
    }
    const fitScore = scoreDomainFit(`${parsed.role} ${parsed.location || ''}`);
    if (fitScore < TITLE_FIT_MIN_SCORE) {
      movedDomain.push({ ...parsed, fitScore });
      continue;
    }
    // Domain fit passed — now check geo eligibility independently. A posting
    // can be a perfect skills match AND structurally unreachable from India;
    // these are different failure modes (see GEO_FILTERED_SKELETON), checked
    // and filed separately, not conflated into one "filtered" reason.
    const geo = classifyGeoEligibility({ locationText: parsed.location || '' });
    if (geo.tier === 'restricted' && geo.confidence < GEO_GATE_CONFIDENCE_THRESHOLD) {
      movedGeo.push({ ...parsed, geoEvidence: geo.evidence });
      continue;
    }
    kept.push({ line, parsed });
  }

  // Liveness pass — domain+geo already passed, so every candidate here is a
  // real network check. Re-checked every run (not deduped against a "seen"
  // set) because a posting that was alive last scan can die between runs —
  // that's the exact gap this closes (see DEAD_FILTERED_PATH comment above).
  const candidates = kept.filter((k) => typeof k === 'object');
  const liveChecked = summaryOnly ? [] : await checkLivenessBatch(candidates, LIVENESS_CONCURRENCY);
  const deadUrls = new Set(liveChecked.filter((c) => c.liveness?.result === 'expired').map((c) => c.parsed.url));
  const movedDead = liveChecked
    .filter((c) => deadUrls.has(c.parsed.url))
    .map((c) => ({ ...c.parsed, deadReason: c.liveness.reason }));

  const finalKept = kept.map((k) => (typeof k === 'string' ? k : k.line)).filter((line) => {
    const parsed = parseCheckboxLine(line);
    return !parsed || !deadUrls.has(parsed.url);
  });

  if (summaryOnly) {
    const stillPending = bounds.end - bounds.start - 1 - movedBlacklist.length - movedDomain.length - movedGeo.length - alreadyBlacklistFiltered.size - alreadyDomainFiltered.size - alreadyGeoFiltered.size - alreadyDeadFiltered.size;
    console.log(`Pending: ${Math.max(0, stillPending)} kept, ${movedBlacklist.length} newly blacklist-filtered, ${movedDomain.length} newly domain-filtered, ${movedGeo.length} newly geo-filtered. (liveness check skipped in --summary mode)`);
    return;
  }

  console.log(`Blacklist filter: ${movedBlacklist.length} moved to data/pipeline-blacklisted-filtered.md.`);
  for (const m of movedBlacklist) {
    console.log(`  - ${m.company} | ${m.role} (${m.blacklistReason}) → blacklisted`);
  }
  console.log(`Domain-fit filter: ${movedDomain.length} moved to data/pipeline-filtered.md.`);
  for (const m of movedDomain) {
    console.log(`  - ${m.company} | ${m.role} (fit score ${m.fitScore}) → filtered`);
  }
  console.log(`Geo filter: ${movedGeo.length} moved to data/pipeline-geo-filtered.md.`);
  for (const m of movedGeo) {
    console.log(`  - ${m.company} | ${m.role} (${m.geoEvidence}) → geo-filtered`);
  }
  console.log(`Liveness filter: ${movedDead.length} moved to data/pipeline-dead-filtered.md.`);
  for (const m of movedDead) {
    console.log(`  - ${m.company} | ${m.role} (${m.deadReason}) → dead`);
  }
  console.log(`${finalKept.filter(l => parseCheckboxLine(l)).length} stay in data/pipeline.md.`);

  if (dryRun) {
    console.log('\n(dry run — no files written)');
    return;
  }

  if (movedBlacklist.length === 0 && movedDomain.length === 0 && movedGeo.length === 0 && movedDead.length === 0) {
    console.log('Nothing to move.');
    return;
  }

  // Rewrite data/pipeline.md's Pending section with only the kept lines.
  const newLines = [...lines.slice(0, bounds.start + 1), ...finalKept, ...lines.slice(bounds.end)];
  writeFileSync(PIPELINE_PATH, newLines.join('\n'), 'utf-8');

  if (movedBlacklist.length > 0) {
    if (!existsSync(BLACKLIST_FILTERED_PATH)) writeFileSync(BLACKLIST_FILTERED_PATH, BLACKLIST_FILTERED_SKELETON, 'utf-8');
    const blacklistLines = movedBlacklist
      .map(m => `- [ ] ${m.url} | ${m.company} | ${m.role}${m.location ? ` | ${m.location}` : ''} (${m.blacklistReason})`)
      .join('\n') + '\n';
    writeFileSync(BLACKLIST_FILTERED_PATH, readFileSync(BLACKLIST_FILTERED_PATH, 'utf-8') + blacklistLines, 'utf-8');
  }

  if (movedDomain.length > 0) {
    if (!existsSync(FILTERED_PATH)) writeFileSync(FILTERED_PATH, FILTERED_SKELETON, 'utf-8');
    const filteredLines = movedDomain
      .map(m => `- [ ] ${m.url} | ${m.company} | ${m.role}${m.location ? ` | ${m.location}` : ''} (fit score: ${m.fitScore})`)
      .join('\n') + '\n';
    writeFileSync(FILTERED_PATH, readFileSync(FILTERED_PATH, 'utf-8') + filteredLines, 'utf-8');
  }

  if (movedGeo.length > 0) {
    if (!existsSync(GEO_FILTERED_PATH)) writeFileSync(GEO_FILTERED_PATH, GEO_FILTERED_SKELETON, 'utf-8');
    const geoLines = movedGeo
      .map(m => `- [ ] ${m.url} | ${m.company} | ${m.role}${m.location ? ` | ${m.location}` : ''} (${m.geoEvidence})`)
      .join('\n') + '\n';
    writeFileSync(GEO_FILTERED_PATH, readFileSync(GEO_FILTERED_PATH, 'utf-8') + geoLines, 'utf-8');
  }

  if (movedDead.length > 0) {
    if (!existsSync(DEAD_FILTERED_PATH)) writeFileSync(DEAD_FILTERED_PATH, DEAD_FILTERED_SKELETON, 'utf-8');
    const deadLines = movedDead
      .map(m => `- [ ] ${m.url} | ${m.company} | ${m.role}${m.location ? ` | ${m.location}` : ''} (${m.deadReason})`)
      .join('\n') + '\n';
    writeFileSync(DEAD_FILTERED_PATH, readFileSync(DEAD_FILTERED_PATH, 'utf-8') + deadLines, 'utf-8');
  }

  const wroteFiles = ['data/pipeline.md'];
  if (movedBlacklist.length > 0) wroteFiles.push('data/pipeline-blacklisted-filtered.md');
  wroteFiles.push('data/pipeline-filtered.md', 'data/pipeline-geo-filtered.md', 'data/pipeline-dead-filtered.md');
  const lastFile = wroteFiles.pop();
  console.log(`\nWrote changes to ${wroteFiles.join(', ')}, and ${lastFile}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
