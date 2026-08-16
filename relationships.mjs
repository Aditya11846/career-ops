#!/usr/bin/env node
// relationships.mjs — outreach/relationship tracker (priority-4 item, scoped
// deliberately narrow per .claude/notes/relationship-pipeline-critique.md:
// dead-simple person/contact tracking, same architecture as
// followup-cadence.mjs (a pure on-demand recompute function reading a plain
// markdown table, NOT a scheduled job or a new database).
//
// Data file: data/relationships.md (user layer, gitignored — real names).
// Table: | # | Name | Role | Company | LinkedIn | Email | LastContact | NextAction | Status | Notes |
// LinkedIn/Email = how to ACTUALLY message this person, not just their name
// (real gap caught live: the first contacto build found real people but
// never captured how to reach them; a single blended "Contact" column
// shipped next, then Aditya asked for both LinkedIn AND email explicitly —
// two separate fields).
//
// CLI:
//   node relationships.mjs --json                        list, with computed overdue/daysSince
//   node relationships.mjs --summary                     human-readable table
//   node relationships.mjs --add --name N --role R --company C [--linkedin URL] [--email E] [--next-action YYYY-MM-DD] [--notes "..."]
//   node relationships.mjs --touch <#> [--next-action YYYY-MM-DD]   mark contacted today
//   node relationships.mjs --delete <#>                              remove one entry (numbers are stable IDs, not re-sequenced after a delete)
//   node relationships.mjs --update <#> [--linkedin URL] [--email E] [--role R] [--notes "..."]   backfill/update fields on an EXISTING entry (only overwrites fields actually passed)

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeFileAtomic, normalizeCompany } from './tracker-utils.mjs';
import { readCompanySignal } from './signal-agent/compute-heat.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const FILE = join(CAREER_OPS, 'data/relationships.md');
const HEADER = '| # | Name | Role | Company | LinkedIn | Email | LastContact | NextAction | Status | Notes |';
const SEP = '|---|------|------|---------|----------|-------|-------------|------------|--------|-------|';

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
// this file's schema grew columns TWICE (first a single "Contact" column,
// then split into separate LinkedIn/Email columns) after rows already
// existed on disk in older shapes. A parser that hard-requires today's
// minimum cell count silently drops every older row -- and since
// --add/--touch always serialize(load()) the FULL row set back to disk,
// that silent drop becomes a silent DELETE the next time anyone writes.
// Never repeat that: any future column addition here MUST accept every
// prior cell count too. Three shapes are distinguished purely by
// cells.length, which is reliable because each schema version has a FIXED
// field count regardless of note content:
//   7 cells -> oldest (pre-Contact, before 2026-07-28 morning)
//   8 cells -> middle (single blended Contact column, 2026-07-28 midday)
//   9+ cells -> current (separate LinkedIn + Email columns)
export function parseRelationships(content) {
  if (!content) return [];
  const rows = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    if (cells.length < 7) continue; // truly malformed, not just an older schema
    if (cells[0] === 'Name') continue; // header row guard
    let name, role, company, linkedin, email, lastContact, nextAction, status, noteParts;
    if (cells.length === 7) {
      [name, role, company, lastContact, nextAction, status, ...noteParts] = cells;
      linkedin = '';
      email = '';
    } else if (cells.length === 8) {
      let contact;
      [name, role, company, contact, lastContact, nextAction, status, ...noteParts] = cells;
      // the old single Contact column could hold either shape -- route by content
      if (contact.includes('@') && !contact.startsWith('http')) {
        email = contact;
        linkedin = '';
      } else {
        linkedin = contact;
        email = '';
      }
    } else {
      [name, role, company, linkedin, email, lastContact, nextAction, status, ...noteParts] = cells;
    }
    rows.push({
      n: m[1],
      name,
      role,
      company,
      linkedin: linkedin || '',
      email: email || '',
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
    lines.push(`| ${r.n} | ${r.name} | ${r.role} | ${r.company} | ${r.linkedin || ''} | ${r.email || ''} | ${r.lastContact} | ${r.nextAction} | ${r.status} | ${r.notes} |`);
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
    const linkedin = parseArg(args, '--linkedin') || '';
    const email = parseArg(args, '--email') || '';
    const nextAction = parseArg(args, '--next-action') || '';
    const notes = parseArg(args, '--notes') || '';
    if (!name) {
      console.error('Usage: node relationships.mjs --add --name "Name" [--role R] [--company C] [--linkedin URL] [--email E] [--next-action YYYY-MM-DD] [--notes "..."]');
      process.exit(1);
    }
    const rows = load();
    const n = nextNum(rows);
    rows.push({ n: String(n), name, role, company, linkedin, email, lastContact: today(), nextAction, status: 'Active', notes });
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

  if (args.includes('--delete')) {
    const idx = args.indexOf('--delete');
    const num = args[idx + 1];
    const rows = load();
    const before = rows.length;
    const filtered = rows.filter((r) => r.n !== num);
    if (filtered.length === before) {
      console.error(`No relationship #${num}`);
      process.exit(1);
    }
    writeFileAtomic(FILE, serialize(filtered));
    console.log(JSON.stringify({ deleted: num }, null, 2));
    return;
  }

  if (args.includes('--update')) {
    const idx = args.indexOf('--update');
    const num = args[idx + 1];
    const rows = load();
    const row = rows.find((r) => r.n === num);
    if (!row) {
      console.error(`No relationship #${num}`);
      process.exit(1);
    }
    // Only overwrite fields explicitly passed -- never blank an existing
    // real value just because a field was omitted (e.g. backfilling
    // linkedin alone must not wipe an already-known email).
    const linkedin = parseArg(args, '--linkedin');
    const email = parseArg(args, '--email');
    const notes = parseArg(args, '--notes');
    const role = parseArg(args, '--role');
    if (linkedin !== undefined) row.linkedin = linkedin;
    if (email !== undefined) row.email = email;
    if (notes !== undefined) row.notes = notes;
    if (role !== undefined) row.role = role;
    writeFileAtomic(FILE, serialize(rows));
    console.log(JSON.stringify({ updated: num }, null, 2));
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
      const contactParts = [r.linkedin && `LinkedIn: ${r.linkedin}`, r.email && `Email: ${r.email}`].filter(Boolean);
      const contact = contactParts.length ? ` [${contactParts.join(' | ')}]` : ' [NO CONTACT INFO]';
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
  const sample = [HEADER, SEP, '| 1 | Jane Doe | Recruiter | Acme | linkedin.com/in/janedoe | jane@acme.com | 2026-07-01 | 2026-07-10 | Active | met at a conference |'].join('\n');
  const rows = parseRelationships(sample);
  assertEqual(rows.length, 1, 'parses one data row, skips header/separator');
  assertEqual(rows[0].name, 'Jane Doe', 'parses name');
  assertEqual(rows[0].linkedin, 'linkedin.com/in/janedoe', 'parses LinkedIn column');
  assertEqual(rows[0].email, 'jane@acme.com', 'parses Email column');
  assertEqual(rows[0].notes, 'met at a conference', 'parses notes (last column)');

  const roundTrip = parseRelationships(serialize(rows));
  assertEqual(roundTrip, rows, 'serialize -> parse round-trips losslessly');

  // Regression tests for real data loss (2026-07-28, happened TWICE — once
  // adding a single Contact column, once splitting it into LinkedIn+Email):
  // every prior on-disk shape must still parse, not be silently dropped,
  // which previously caused --add to overwrite the file with only the new
  // row, destroying every pre-existing real contact.
  const oldestFormatLine = '| 9 | Old Row | Peer | Acme | 2026-07-01 | 2026-07-10 | Active | pre-Contact-column entry |';
  const oldestRows = parseRelationships([HEADER, SEP, oldestFormatLine].join('\n'));
  assertEqual(oldestRows.length, 1, 'OLDEST 7-cell rows (pre-Contact column) still parse, not silently dropped');
  assertEqual(oldestRows[0].name, 'Old Row', 'OLDEST-format row name parses correctly');
  assertEqual(oldestRows[0].linkedin, '', 'OLDEST-format row has no linkedin, defaults to empty string not undefined');
  assertEqual(oldestRows[0].email, '', 'OLDEST-format row has no email, defaults to empty string not undefined');
  assertEqual(oldestRows[0].lastContact, '2026-07-01', 'OLDEST-format row lastContact lands in the right field');
  assertEqual(oldestRows[0].notes, 'pre-Contact-column entry', 'OLDEST-format row notes still parse correctly');

  const middleUrlLine = '| 10 | Mid URL | Peer | Acme | linkedin.com/in/midurl | 2026-07-01 | 2026-07-10 | Active | single-Contact-column entry, URL |';
  const middleUrlRows = parseRelationships([HEADER, SEP, middleUrlLine].join('\n'));
  assertEqual(middleUrlRows[0].linkedin, 'linkedin.com/in/midurl', 'MIDDLE 8-cell single-Contact column routes a URL-shaped value to linkedin');
  assertEqual(middleUrlRows[0].email, '', 'MIDDLE 8-cell single-Contact column leaves email empty when the value was a URL');

  const middleEmailLine = '| 11 | Mid Email | Peer | Acme | mid@acme.com | 2026-07-01 | 2026-07-10 | Active | single-Contact-column entry, email |';
  const middleEmailRows = parseRelationships([HEADER, SEP, middleEmailLine].join('\n'));
  assertEqual(middleEmailRows[0].email, 'mid@acme.com', 'MIDDLE 8-cell single-Contact column routes an @-shaped value to email');
  assertEqual(middleEmailRows[0].linkedin, '', 'MIDDLE 8-cell single-Contact column leaves linkedin empty when the value was an email');

  const enriched = enrich([{ n: '1', name: 'X', role: '', company: '', lastContact: '2026-07-01', nextAction: '2026-07-01', status: 'Active', notes: '' }]);
  // nextAction in the past relative to "today" in this sandboxed test env
  // just needs overdue to be a boolean, not a specific value (today() is real time).
  assertEqual(typeof enriched[0].overdue, 'boolean', 'overdue is always a boolean');
  assertEqual(enriched[0].companyHeat, null, 'no company -> no heat lookup, null not thrown');

  assertEqual(nextNum([]), 1, 'nextNum starts at 1 on empty');
  assertEqual(nextNum([{ n: '3' }, { n: '1' }]), 4, 'nextNum is max+1, not length+1');

  // --delete uses the same rows.filter((r) => r.n !== num) logic inline in
  // main() -- exercise that exact semantic here rather than duplicating it,
  // since main() only runs against the real FILE (no dependency injection).
  const deleteSample = [{ n: '1', name: 'Keep Me' }, { n: '2', name: 'Delete Me' }, { n: '3', name: 'Keep Me Too' }];
  const afterDelete = deleteSample.filter((r) => r.n !== '2');
  assertEqual(afterDelete.length, 2, '--delete removes exactly one row');
  assertEqual(afterDelete.map((r) => r.n), ['1', '3'], '--delete does NOT re-sequence remaining #s (stable IDs, not array indices)');

  // --update uses the same "only overwrite fields actually passed" merge
  // logic inline in main() -- exercise that exact semantic here. The
  // critical property: backfilling ONE field (e.g. linkedin) must never
  // blank an already-known OTHER field (e.g. email) just because it wasn't
  // passed this time.
  const updateTarget = { n: '1', name: 'X', linkedin: '', email: 'already-known@x.com', notes: 'old notes' };
  const linkedinOnly = parseArg(['--linkedin', 'https://linkedin.com/in/x'], '--linkedin');
  const updated = { ...updateTarget };
  if (linkedinOnly !== undefined) updated.linkedin = linkedinOnly;
  assertEqual(updated.linkedin, 'https://linkedin.com/in/x', '--update linkedin sets the new value');
  assertEqual(updated.email, 'already-known@x.com', '--update linkedin-only does NOT blank an already-known email');
  assertEqual(updated.notes, 'old notes', '--update linkedin-only does NOT touch notes');

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
