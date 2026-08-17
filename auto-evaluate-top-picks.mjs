#!/usr/bin/env node
/**
 * auto-evaluate-top-picks.mjs — nightly auto-evaluate for the ranking-evaluation
 * connector (2026-08-03 brainstorm §23, item 15 of the 20-point plan).
 *
 * Real token spend, unattended — deliberately NOT part of scan.mjs/
 * filter-inbox-by-fit.mjs/score-inbox.mjs's zero-LLM-cost guarantee. Run as its
 * own separate step in scripts/cron-daily-scan.sh, after scoring, so it only
 * ever sees postings that already passed domain-fit/geo-fit/liveness triage.
 *
 * Selection (matches the dashboard's "Evaluate top N picks" button — same
 * fitRank ordering, same "not yet evaluated" definition — just headless and a
 * larger N, per Aditya's explicit choice 2026-08-03):
 *   1. Read data/pipeline.md's "## Pending" section + data/posting-signals.json
 *      for each URL's fitRank (score-inbox.mjs's `rank` field).
 *   2. Drop anything already evaluated — reports/*.md always carries a
 *      **URL:** line (AGENTS.md Pipeline Integrity rule #3); any pending URL
 *      appearing in ANY report's URL line is already evaluated, skip it. This
 *      is the authoritative check, NOT presence/absence in pipeline.md —
 *      modes/oferta.md only edits pipeline.md when a posting is dead, never on
 *      a successful evaluation, so a scored posting stays in Pending forever
 *      otherwise.
 *   3. Sort the remainder by fitRank descending, take the top N
 *      (AUTO_EVALUATE_TOP_N below).
 *   4. If that list is empty (every current top-N pick already has a report),
 *      log it and spend NOTHING — this is the "only if something's genuinely
 *      new" condition Aditya asked for, and falls out naturally from step 2
 *      rather than needing separate day-over-day state.
 *
 * Each pick runs the SAME real evaluate prompt the web dashboard's button uses
 * (web/src/app/api/run/route.ts's `evaluate` branch) via `claude -p`,
 * sequentially — not parallel — so report-number reservation (each run reserves
 * its own via reserve-report-num.mjs internally) never races, and nightly token
 * spend stays bounded to one evaluation in flight at a time.
 *
 * Usage: node auto-evaluate-top-picks.mjs [--dry-run]
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const SIGNALS_PATH = join(ROOT, 'data/posting-signals.json');
const REPORTS_DIR = join(ROOT, 'reports');
const LOG_DIR = join(ROOT, '.claude/notes/cron-logs');

// Nightly cap — real Claude usage, kept small and predictable per Aditya's
// explicit choice 2026-08-03 (vs. the manual dashboard button's top 3).
const AUTO_EVALUATE_TOP_N = 5;

// launchd's PATH is minimal and excludes both Homebrew and the user's
// ~/.local/bin, so resolve `claude` explicitly instead of hardcoding one
// machine's path (#bug_001, mirrors scan-and-process.mjs's resolver).
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    // fall through to common install dirs
  }
  const home = homedir();
  const candidates = [
    join(home, '.local/bin/claude'),
    join(home, '.npm-global/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new Error('Cannot locate `claude` CLI. Set CLAUDE_BIN or add `claude` to PATH.');
}

const CLAUDE_BIN = resolveClaudeBin();

const PENDING_MARKERS = ['## Pending', '## Pendientes'];

function parseCheckboxLine(line) {
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const parts = m[2].split('|').map((s) => s.trim());
  if (parts.length < 3 || !parts[0]) return null;
  return { done: m[1].toLowerCase() === 'x', url: parts[0], company: parts[1], role: parts[2], location: parts[3] || undefined };
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

/** Every URL that appears in any report's **URL:** line — the authoritative "already evaluated" set. */
function loadEvaluatedUrls() {
  const urls = new Set();
  if (!existsSync(REPORTS_DIR)) return urls;
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(join(REPORTS_DIR, name), 'utf-8');
    const m = text.match(/^\*\*URL:\*\*\s*(.+)$/m);
    if (!m) continue;
    for (const urlMatch of m[1].matchAll(/https?:\/\/\S+/g)) {
      urls.add(urlMatch[0].replace(/[).,]+$/, ''));
    }
  }
  return urls;
}

function loadPendingEntries() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const bounds = findPendingSectionBounds(lines);
  if (!bounds) return [];
  const entries = [];
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const parsed = parseCheckboxLine(lines[i]);
    if (parsed && !parsed.done) entries.push(parsed);
  }
  return entries;
}

function loadFitRanks() {
  if (!existsSync(SIGNALS_PATH)) return new Map();
  const json = JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8'));
  return new Map(Object.entries(json).map(([url, v]) => [url, v.rank]));
}

/** SAME evaluate prompt web/src/app/api/run/route.ts's buildPrompt() sends for kind:"evaluate" — kept in sync by hand since this script runs independently of the Next.js server. */
function buildEvaluatePrompt(url) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${url}`;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const pending = loadPendingEntries();
  const fitRanks = loadFitRanks();
  const evaluated = loadEvaluatedUrls();

  const candidates = pending
    .filter((e) => !evaluated.has(e.url) && fitRanks.has(e.url))
    .map((e) => ({ ...e, fitRank: fitRanks.get(e.url) }))
    .sort((a, b) => b.fitRank - a.fitRank)
    .slice(0, AUTO_EVALUATE_TOP_N);

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `auto-evaluate-${new Date().toISOString().slice(0, 10)}.log`);
  const log = (line) => {
    console.log(line);
    appendFileSync(logPath, line + '\n');
  };

  log(`=== auto-evaluate-top-picks: ${new Date().toISOString()} ===`);

  if (candidates.length === 0) {
    log('Nothing new to auto-evaluate — every current top pick already has a report. Spent 0 tokens.');
    return;
  }

  log(`${candidates.length} new top pick(s) to auto-evaluate (cap ${AUTO_EVALUATE_TOP_N}):`);
  for (const c of candidates) log(`  - ${c.company} | ${c.role} (fit ${c.fitRank}) — ${c.url}`);

  if (dryRun) {
    log('(dry run — no evaluations run)');
    return;
  }

  for (const c of candidates) {
    log(`--- evaluating: ${c.company} | ${c.role} ---`);
    try {
      // Same tool scope + permission mode as web/src/app/api/run/route.ts's
      // 'evaluate' kind: Write+Bash needed for reserve-report-num/merge-tracker/
      // writing the report; Task blocked (no sub-agent runaway cost); never
      // auto-submits (that's a prompt-level guarantee, not a tool restriction).
      const output = execFileSync(
        CLAUDE_BIN,
        [
          '-p', buildEvaluatePrompt(c.url),
          '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep',
          '--disallowedTools', 'Task,NotebookEdit',
        ],
        { cwd: ROOT, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 },
      );
      const verdict = output.match(/VERDICT:.*$/m);
      log(verdict ? verdict[0] : '(no VERDICT line found in output)');
    } catch (err) {
      log(`ERROR evaluating ${c.url}: ${err.message}`);
    }
  }

  log(`=== done: ${new Date().toISOString()} ===`);
}

main();
