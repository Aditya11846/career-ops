#!/usr/bin/env node
// relationships.mjs — outreach/relationship tracker (priority-4 item, scoped
// deliberately narrow per .claude/notes/relationship-pipeline-critique.md:
// dead-simple person/contact tracking, same architecture as
// followup-cadence.mjs (a pure on-demand recompute function reading a plain
// markdown table, NOT a scheduled job or a new database).
//
// Data file: data/relationships.md (user layer, gitignored — real names).
// Table: | # | Name | Role | Company | Contact | LastContact | NextAction | Status | Notes |
// Contact = a LinkedIn profile URL, email, or other reach-out channel — how
// to ACTUALLY message this person, not just their name (#... real gap caught
// live: the first contacto build found real people but never captured how
// to reach them, only a name).
//
// CLI:
//   node relationships.mjs --json                        list, with computed overdue/daysSince
//   node relationships.mjs --summary                     human-readable table
//   node relationships.mjs --add --name N --role R --company C [--contact URL_OR_EMAIL] [--next-action YYYY-MM-DD] [--notes "..."]
//   node relationships.mjs --touch <#> [--next-action YYYY-MM-DD]   mark contacted today

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeFileAtomic, normalizeCompany } from './tracker-utils.mjs';
import { readCompanySignal } from './signal-agent/compute-heat.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const FILE = join(CAREER_OPS, 'data/relationships.md');
const HEADER = '| # | Name | Role | Company | Contact | LastContact | NextAction | Status | Notes |';
const SEP = '|---|------|------|---------|---------|-------------|------------|--------|-------|';

function today() {
  return new Date().toISOString().split('T')[0];
}

function parseArg(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function daysBetween(d1, d2) {
  return Math.floor((new Date(d2) - new Date(d1)) / 86400000);
}

// --- Parse / serialize data/relationships.md ---
// BACKWARD-COMPAT WARNING, learned the hard way (real data loss, 2026-07-28):
// this file's schema grew a Contact column after rows already existed on
// disk in the OLD (7-cell) shape. A parser that hard-requires the NEW
// minimum cell count silently drops every old row -- and since --add/--touch
// always serialize(load()) the FULL row set back to disk, that silent drop
// becomes a silent DELETE the next time anyone writes. Never repeat that:
// any future column addition here MUST accept the old cell count too,
// distinguishing old (7-cell, no Contact) from new (8-cell, Contact present)
// by count rather than assuming today's shape is the only shape on disk.
export function parseRelationships(content) {
  if (!content) return [];
  const rows = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    if (cells.length < 7) continue; // truly malformed, not just old-schema
    if (cells[0] === 'Name') continue; // header row guard
    // Old schema (pre-Contact column, before 2026-07-28) always produces
    // exactly 7 cells for a row with pipe-free notes; new schema always
    // produces 8+ (Contact is a required position even when empty). This is
    // the one reliable signal -- cells.length alone -- since old and new
    // both use the same 7 vs 8 fixed-field count regardless of note content.
    let name, role, company, contact, lastContact, nextAction, status, noteParts;
    if (cells.length === 7) {
      [name, role, company, lastContact, nextAction, status, ...noteParts] = cells;
      contact = '';
    } else {
      [name, role, company, contact, lastContact, nextAction, status, ...noteParts] = cells;
    }
    rows.push({
      n: m[1],
      name,
      role,
      company,
      contact: contact || '',
      lastContact: lastContact || '',
      nextAction: nextAction || '',
      status: status || 'Active',
      notes: noteParts.join('|').trim(),
    });
  }
  return rows;
}

function serialize(rows) {
  const lines = [HEADER, SEP];
  for (const r of rows) {
    lines.push(`| ${r.n} | ${r.name} | ${r.role} | ${r.company} | ${r.contact || ''} | ${r.lastContact} | ${r.nextAction} | ${r.status} | ${r.notes} |`);
  }
  return lines.join('\n') + '\n';
}

function load() {
  if (!existsSync(FILE)) return [];
  return parseRelationships(readFileSync(FILE, 'utf-8'));
}

function nextNum(rows) {
  return rows.length ? Math.max(...rows.map((r) => parseInt(r.n, 10))) + 1 : 1;
}

// --- Enrich with computed fields + company heat (read-only join, never
// computes a new heat score itself — that's an agent job, see
// web/src/app/api/run/route.ts's "compute-heat" kind) ---
export function enrich(rows) {
  const t = today();
  return rows.map((r) => {
    const daysSinceContact = r.lastContact ? daysBetween(r.lastContact, t) : null;
    const daysUntilNextAction = r.nextAction ? daysBetween(t, r.nextAction) : null;
    const overdue = daysUntilNextAction !== null && daysUntilNextAction < 0;
    const signal = r.company ? readCompanySignal(r.company) : null;
    return {
      ...r,
      daysSinceContact,
      daysUntilNextAction,
      overdue,
      companyHeat: signal?.heat ?? null,
    };
  });
}

// --- CLI ---
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--add')) {
    const name = parseArg(args, '--name');
    const role = parseArg(args, '--role') || '';
    const company = parseArg(args, '--company') || '';
    const contact = parseArg(args, '--contact') || '';
    const nextAction = parseArg(args, '--next-action') || '';
    const notes = parseArg(args, '--notes') || '';
    if (!name) {
      console.error('Usage: node relationships.mjs --add --name "Name" [--role R] [--company C] [--contact URL_OR_EMAIL] [--next-action YYYY-MM-DD] [--notes "..."]');
      process.exit(1);
    }
    const rows = load();
    const n = nextNum(rows);
    rows.push({ n: String(n), name, role, company, contact, lastContact: today(), nextAction, status: 'Active', notes });
    writeFileAtomic(FILE, serialize(rows));
    console.log(JSON.stringify({ added: n }, null, 2));
    return;
  }

  if (args.includes('--touch')) {
    const idx = args.indexOf('--touch');
    const num = args[idx + 1];
    const nextAction = parseArg(args, '--next-action');
    const rows = load();
    const row = rows.find((r) => r.n === num);
    if (!row) {
      console.error(`No relationship #${num}`);
      process.exit(1);
    }
    row.lastContact = today();
    if (nextAction) row.nextAction = nextAction;
    writeFileAtomic(FILE, serialize(rows));
    console.log(JSON.stringify({ touched: num }, null, 2));
    return;
  }

  const enriched = enrich(load());

  if (args.includes('--summary')) {
    if (!enriched.length) {
      console.log('No relationships tracked yet.');
      return;
    }
    for (const r of enriched) {
      const flag = r.overdue ? ' [OVERDUE]' : '';
      const heat = r.companyHeat !== null ? ` heat=${r.companyHeat}` : '';
      const contact = r.contact ? ` [${r.contact}]` : ' [NO CONTACT INFO]';
      console.log(`#${r.n} ${r.name} (${r.role} @ ${r.company})${heat}${contact} — last contact ${r.lastContact || 'never'}, next ${r.nextAction || '—'}${flag}`);
    }
    return;
  }

  console.log(JSON.stringify(enriched, null, 2));
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
  const sample = [HEADER, SEP, '| 1 | Jane Doe | Recruiter | Acme | linkedin.com/in/janedoe | 2026-07-01 | 2026-07-10 | Active | met at a conference |'].join('\n');
  const rows = parseRelationships(sample);
  assertEqual(rows.length, 1, 'parses one data row, skips header/separator');
  assertEqual(rows[0].name, 'Jane Doe', 'parses name');
  assertEqual(rows[0].contact, 'linkedin.com/in/janedoe', 'parses contact (LinkedIn/email column)');
  assertEqual(rows[0].notes, 'met at a conference', 'parses notes (last column)');

  const roundTrip = parseRelationships(serialize(rows));
  assertEqual(roundTrip, rows, 'serialize -> parse round-trips losslessly');

  // Regression test for real data loss (2026-07-28): an OLD-schema row
  // (7 cells, no Contact column) must still parse -- NOT be silently
  // dropped, which previously caused --add to overwrite the file with only
  // the new row, destroying every pre-existing real contact.
  const oldFormatLine = '| 9 | Old Row | Peer | Acme | 2026-07-01 | 2026-07-10 | Active | pre-Contact-column entry |';
  const oldRows = parseRelationships([HEADER, SEP, oldFormatLine].join('\n'));
  assertEqual(oldRows.length, 1, 'OLD 7-cell rows (pre-Contact column) still parse, not silently dropped');
  assertEqual(oldRows[0].name, 'Old Row', 'OLD-format row name parses correctly');
  assertEqual(oldRows[0].contact, '', 'OLD-format row has no contact, defaults to empty string not undefined');
  assertEqual(oldRows[0].lastContact, '2026-07-01', 'OLD-format row lastContact lands in the right field, not shifted by the missing Contact column');
  assertEqual(oldRows[0].notes, 'pre-Contact-column entry', 'OLD-format row notes still parse correctly');

  const enriched = enrich([{ n: '1', name: 'X', role: '', company: '', lastContact: '2026-07-01', nextAction: '2026-07-01', status: 'Active', notes: '' }]);
  // nextAction in the past relative to "today" in this sandboxed test env
  // just needs overdue to be a boolean, not a specific value (today() is real time).
  assertEqual(typeof enriched[0].overdue, 'boolean', 'overdue is always a boolean');
  assertEqual(enriched[0].companyHeat, null, 'no company -> no heat lookup, null not thrown');

  assertEqual(nextNum([]), 1, 'nextNum starts at 1 on empty');
  assertEqual(nextNum([{ n: '3' }, { n: '1' }]), 4, 'nextNum is max+1, not length+1');

  if (process.exitCode === 1) {
    console.error('\nSelf-test FAILED');
  } else {
    console.log('\nSelf-test PASSED');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
  } else {
    main();
  }
}
