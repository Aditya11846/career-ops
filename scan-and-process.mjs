#!/usr/bin/env node
/**
 * scan-and-process.mjs — Branch 1A autonomy layer C: drain the fire-hose.
 *
 * scan.mjs (autonomy A / PM2, Smart 1) fills data/pipeline.md with every new
 * offer tagged `relevance: 0-3`. This script turns the top-N into real
 * evaluations, spending tokens ONLY on the most promising offers first —
 * the human-quality gate stays in the eval (oferta.mjs), not in a scan-time
 * filter.
 *
 * Selection:
 *   1. Read data/pipeline.md's "## Pending" section.
 *   2. Drop anything already evaluated — reports/*.md always carries a
 *      **URL:** line (AGENTS.md Pipeline Integrity rule #3); any pending URL
 *      appearing in ANY report's URL line is already evaluated, skip it.
 *   3. Sort the remainder by the scan-time `relevance:` tag (0-3, from
 *      scan.mjs's Smart 1 tagger), descending. Offers without a tag score 0.
 *   4. Take the top N (SCAN_PROCESS_TOP_N, override with --top N).
 *
 * Evaluation (mirrors auto-evaluate-top-picks.mjs but relevance-first):
 *   - Reserve the report-number range for the WHOLE batch FIRST
 *     (`reserve-report-num.mjs --count N`, the #749 anti-race rule); each eval
 *     is handed its own slot and told NOT to reserve or merge.
 *   - Sequential `claude -p` per offer (one evaluation in flight at a time,
 *     bounded per-offer by PER_EVAL_TIMEOUT_MS — no runaway spend).
 *   - After all evals, ONE `merge-tracker.mjs` pass writes data/applications.md.
 *
 * Usage: node scan-and-process.mjs [--dry-run] [--top N]
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const REPORTS_DIR = join(ROOT, 'reports');
const LOG_DIR = join(ROOT, '.claude/notes/cron-logs');

// Cap per run — real Claude usage. Relevance-first ordering means the most
// promising offers are always the ones that consume tokens.
const SCAN_PROCESS_TOP_N = 20;

// launchd/PM2 PATHs are minimal and exclude both Homebrew and the user's
// ~/.local/bin, so `claude` on bare $PATH often isn't found — resolve it
// explicitly instead of hardcoding one machine's path (#bug_001).
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

// Hard per-eval bound: a hung `claude -p` must not stall the whole drain.
const PER_EVAL_TIMEOUT_MS = 240_000;

const PENDING_MARKERS = ['## Pending', '## Pendientes'];

function parseCheckboxLine(line) {
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const parts = m[2].split('|').map((s) => s.trim());
  if (parts.length < 3 || !parts[0]) return null;
  return { done: m[1].toLowerCase() === 'x', parts, url: parts[0], company: parts[1], role: parts[2], location: parts[3] || undefined };
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

/** The `relevance: N` tag (Smart 1) can ride on any tagged part after the 3
 * positional fields — scan every part, default 0 when absent. */
function relevanceOf(parsed) {
  for (let i = 3; i < parsed.parts.length; i++) {
    const m = String(parsed.parts[i]).match(/^relevance:\s*([0-3])$/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Same REAL evaluate prompt the dashboard's run route sends, but with the
 * report number PRE-RESERVED by the parent (the #749 anti-race rule) and the
 * merge deferred to one parent pass at the end. */
function buildProcessPrompt(url, num) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth. Your report number is ALREADY RESERVED: ${num}. Use EXACTLY that number:
   a. Write the full report to reports/${num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   b. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/${num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      ${num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[${num}](reports/${num}-{company-slug}-${today}.md)\t{one-line note}
   c. Do NOT run node reserve-report-num.mjs (the parent already reserved ${num}) and do NOT run node merge-tracker.mjs (the parent merges all rows once at the end). Write ONLY the report and the TSV row.

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.

After everything above is written, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${url}`;
}

/** Fallback prompt when the parent's batch reservation failed: the eval reserves
 * its own number internally (the old auto-evaluate behavior). */
function buildSelfReservePrompt(url) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md.
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv: {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Do NOT run node merge-tracker.mjs (the parent merges all rows once at the end).

3. NEVER submit an application, fill no forms, contact no one.

After everything above is written, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${url}`;
}

/** "042-049" → [42, 43, ..., 49] — 0-padded back to 3 digits when emitted. */
function expandRange(range) {
  const m = String(range).match(/^(\d{3})-(\d{3})$/);
  if (!m) return [];
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(String(n).padStart(3, '0'));
  return out;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const topArg = process.argv.indexOf('--top');
  const topN = topArg !== -1 ? Number(process.argv[topArg + 1]) || SCAN_PROCESS_TOP_N : SCAN_PROCESS_TOP_N;

  const pending = loadPendingEntries();
  const evaluated = loadEvaluatedUrls();

  const candidates = pending
    .filter((e) => !evaluated.has(e.url))
    .map((e) => ({ ...e, relevance: relevanceOf(e) }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, topN);

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `scan-and-process-${new Date().toISOString().slice(0, 10)}.log`);
  const log = (line) => {
    console.log(line);
    appendFileSync(logPath, line + '\n');
  };

  log(`=== scan-and-process: ${new Date().toISOString()} (top ${topN}) ===`);

  if (candidates.length === 0) {
    log('Nothing new to process — every pending offer already has a report. Spent 0 tokens.');
    return;
  }

  for (const c of candidates) log(`  - [r${c.relevance}] ${c.company} | ${c.role} — ${c.url}`);

  if (dryRun) {
    log('(dry run — no evaluations run)');
    return;
  }

  // Reserve the report-number range for the whole batch FIRST (#749 — never let
  // workers compute max+1 themselves; each slot is individually atomic).
  let reservedRange = null;
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'reserve-report-num.mjs'), '--count', String(candidates.length)], { cwd: ROOT, encoding: 'utf-8' });
    const m = out.trim().match(/\d{3}-\d{3}/);
    if (m) reservedRange = m[0];
  } catch (err) {
    log(`WARN: batch report-number reservation failed (${err.message}); falling back to per-eval internal reservation`);
  }
  const nums = reservedRange ? expandRange(reservedRange) : [];
  log(`Reserved report numbers: ${reservedRange ?? '(fallback: per-eval)'}`);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const num = nums[i];
    log(`--- [r${c.relevance}] ${c.company} | ${c.role}${num ? ` (report ${num})` : ''} ---`);
    const prompt = num ? buildProcessPrompt(c.url, num) : buildSelfReservePrompt(c.url);
    try {
      const output = execFileSync(
        CLAUDE_BIN,
        [
          '-p', prompt,
          '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep',
          '--disallowedTools', 'Task,NotebookEdit',
        ],
        { cwd: ROOT, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, timeout: PER_EVAL_TIMEOUT_MS },
      );
      const verdict = output.match(/VERDICT:.*$/m);
      log(verdict ? verdict[0] : '(no VERDICT line found in output)');
    } catch (err) {
      log(`ERROR evaluating ${c.url}: ${err.message}${err.signal === 'SIGTERM' ? ' (timed out)' : ''}`);
    }
  }

  // ONE merge pass at the end — idempotent (dedupes by company+role+report-num),
  // so the reports + TSVs written above become tracker rows exactly once.
  try {
    const merge = execFileSync(process.execPath, [join(ROOT, 'merge-tracker.mjs')], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
    log('merge-tracker.mjs: OK');
    const tail = merge.trim().split('\n').slice(-3).join(' | ');
    if (tail) log(`  ${tail}`);
  } catch (err) {
    log(`ERROR merge-tracker.mjs: ${err.message}`);
  }

  log(`=== done: ${new Date().toISOString()} ===`);
}

main();
