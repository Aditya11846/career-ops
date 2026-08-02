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
 * calibrated for title-length text (see TITLE_FIT_MIN_SCORE below).
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

import { scoreDomainFit, classifyGeoEligibility, GEO_GATE_CONFIDENCE_THRESHOLD } from './compute-fit.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const FILTERED_PATH = join(ROOT, 'data/pipeline-filtered.md');
// SEPARATE from the domain-fit filtered file on purpose (2026-08-02 brainstorm
// item #6, "make it visible, not a black box") — a posting excluded for
// "wrong domain" and one excluded for "structurally unreachable from India"
// are different failure modes with different fixes (broaden keywords vs.
// nothing to fix, it's just not viable), so they stay in separate files
// rather than one undifferentiated "filtered" bucket.
const GEO_FILTERED_PATH = join(ROOT, 'data/pipeline-geo-filtered.md');

// compute-fit.mjs's DOMAIN_FIT_GATE_THRESHOLD (20) is calibrated for full JD
// paragraph text at evaluation time, where several keyword phrases can appear
// together. A bare 3-5 word job title can realistically only ever hit one or
// two keywords — verified live: "Staff Security Engineer" scores 6, well
// below 20, even though it's obviously on-domain. Applying the JD threshold to
// title-only text would filter out genuinely relevant postings. This is a
// deliberately separate, much lower bar for the cheap title-only triage pass:
// any keyword hit at all (score > 0) is real positive signal at this length;
// zero means no domain-relevant word appeared anywhere in the title/location.
const TITLE_FIT_MIN_SCORE = 1;

const PENDING_MARKERS = ['## Pending', '## Pendientes'];

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

function main() {
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

  const alreadyDomainFiltered = loadExistingUrlsFrom(FILTERED_PATH);
  const alreadyGeoFiltered = loadExistingUrlsFrom(GEO_FILTERED_PATH);
  const kept = [];
  const movedDomain = [];
  const movedGeo = [];

  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const line = lines[i];
    const parsed = parseCheckboxLine(line);
    if (!parsed) {
      kept.push(line); // blank lines / non-checkbox content pass through untouched
      continue;
    }
    if (alreadyDomainFiltered.has(parsed.url) || alreadyGeoFiltered.has(parsed.url)) {
      // Already moved in a prior run — idempotent no-op, drop from pending
      // without re-scoring or duplicating into a filtered file again.
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
    kept.push(line);
  }

  if (summaryOnly) {
    const stillPending = bounds.end - bounds.start - 1 - movedDomain.length - movedGeo.length - alreadyDomainFiltered.size - alreadyGeoFiltered.size;
    console.log(`Pending: ${Math.max(0, stillPending)} kept, ${movedDomain.length} newly domain-filtered, ${movedGeo.length} newly geo-filtered.`);
    return;
  }

  console.log(`Domain-fit filter: ${movedDomain.length} moved to data/pipeline-filtered.md.`);
  for (const m of movedDomain) {
    console.log(`  - ${m.company} | ${m.role} (fit score ${m.fitScore}) → filtered`);
  }
  console.log(`Geo filter: ${movedGeo.length} moved to data/pipeline-geo-filtered.md.`);
  for (const m of movedGeo) {
    console.log(`  - ${m.company} | ${m.role} (${m.geoEvidence}) → geo-filtered`);
  }
  console.log(`${kept.filter(l => parseCheckboxLine(l)).length} stay in data/pipeline.md.`);

  if (dryRun) {
    console.log('\n(dry run — no files written)');
    return;
  }

  if (movedDomain.length === 0 && movedGeo.length === 0) {
    console.log('Nothing to move.');
    return;
  }

  // Rewrite data/pipeline.md's Pending section with only the kept lines.
  const newLines = [...lines.slice(0, bounds.start + 1), ...kept, ...lines.slice(bounds.end)];
  writeFileSync(PIPELINE_PATH, newLines.join('\n'), 'utf-8');

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

  console.log(`\nWrote changes to data/pipeline.md, data/pipeline-filtered.md, and data/pipeline-geo-filtered.md.`);
}

main();
