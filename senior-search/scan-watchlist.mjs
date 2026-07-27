#!/usr/bin/env node
// senior-search/scan-watchlist.mjs — isolated scanner for Amit Kumar Singh's
// company watchlist.
//
// Reuses scan.mjs's exact filter/dedup/writer functions (buildTitleFilter,
// buildLocationFilter, loadSeenUrls, appendToPipeline, appendToScanHistory)
// and the same providers/_registry.mjs provider layer as scan.mjs and
// scan-ats-full.mjs — never reimplements them.
//
// ISOLATION: this script never touches the repo-root portals.yml, data/, or
// reports/ — it reads only senior-search/watchlist.yml and writes only under
// senior-search/data/. This is achieved by process.chdir()-ing into
// senior-search/ before calling any of scan.mjs's reused functions, since
// their file paths (data/pipeline.md, data/scan-history.tsv,
// data/applications.md, data/blacklist.md) are resolved relative to
// process.cwd(), not an absolute repo root. Do not remove the chdir — it is
// the entire isolation guarantee.
//
// Usage:
//   node senior-search/scan-watchlist.mjs [--dry-run] [--verbose] [--json]
//
// --json prints one final structured object instead of the human-readable
// summary (mirrors scan-ats-full.mjs's --json contract shape closely enough
// for a web route to parse the same way runDiscovery() does) — the default
// (no --json) human-readable output is unchanged.

import { existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import {
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  appendToPipeline,
  appendToScanHistory,
} from '../scan.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';

const SENIOR_SEARCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SENIOR_SEARCH_DIR);
const WATCHLIST_PATH = path.join(SENIOR_SEARCH_DIR, 'watchlist.yml');
const PROVIDERS_DIR = path.join(REPO_ROOT, 'providers');

function loadWatchlist() {
  if (!existsSync(WATCHLIST_PATH)) {
    throw new Error(`senior-search: watchlist not found at ${WATCHLIST_PATH}`);
  }
  const raw = yaml.load(readFileSync(WATCHLIST_PATH, 'utf-8')) || {};
  return {
    title_filter: raw.title_filter || { positive: [], negative: [] },
    location_filter: raw.location_filter || { always_allow: [], allow: [], block: [] },
    tracked_companies: Array.isArray(raw.tracked_companies) ? raw.tracked_companies : [],
    job_boards: Array.isArray(raw.job_boards) ? raw.job_boards : [],
  };
}

function ensureIsolatedDataDir() {
  // The reused writers (appendToPipeline/appendToScanHistory) and readers
  // (loadSeenUrls) expect 'data/pipeline.md' etc. to exist relative to cwd —
  // ensure senior-search/data/ exists before we chdir into it, so a first-run
  // scan doesn't fail on a missing directory (appendToPipeline auto-creates
  // the pipeline.md file itself, but not the containing directory).
  const dataDir = path.join(SENIOR_SEARCH_DIR, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const json = args.includes('--json');

  ensureIsolatedDataDir();
  const watchlist = loadWatchlist();
  const titleFilter = buildTitleFilter(watchlist.title_filter);
  const locationFilter = buildLocationFilter(watchlist.location_filter);
  const providers = await loadProviders(PROVIDERS_DIR);

  const entries = [...watchlist.tracked_companies, ...watchlist.job_boards];
  const enabled = entries.filter(e => e.enabled !== false);
  const needsAgentHandoff = enabled.filter(e => e.scan_method === 'websearch' && !e.provider && !e.careers_url_confirmed);
  const scannable = enabled.filter(e => !(e.scan_method === 'websearch' && !e.provider && !e.careers_url_confirmed));

  if (verbose && !json) {
    console.log(`Watchlist: ${entries.length} total, ${enabled.length} enabled, ${scannable.length} scannable now, ${needsAgentHandoff.length} need agent/manual verification first.`);
  }

  // ── Isolation boundary: everything from here down that touches a relative
  // data/ path resolves inside senior-search/, never the repo root. ──
  const originalCwd = process.cwd();
  process.chdir(SENIOR_SEARCH_DIR);

  let newOffers = [];
  let errors = [];
  try {
    const { seen: seenUrls } = loadSeenUrls({});
    const ctx = makeHttpCtx();

    for (const entry of scannable) {
      const resolved = resolveProvider(entry, providers, {});
      if (!resolved || resolved.error) {
        errors.push({ company: entry.name, error: resolved?.error || 'no provider resolved' });
        continue;
      }
      try {
        const jobs = await resolved.provider.fetch(entry, ctx);
        for (const job of jobs) {
          if (!job?.url || seenUrls.has(job.url)) continue;
          if (!titleFilter(job.title || '')) continue;
          if (!locationFilter(job.location || '')) continue;
          newOffers.push({ ...job, company: job.company || entry.name });
          seenUrls.add(job.url);
        }
      } catch (err) {
        errors.push({ company: entry.name, error: err.message });
      }
    }

    if (!dryRun && newOffers.length) {
      appendToPipeline(newOffers);
      appendToScanHistory(newOffers, new Date().toISOString().slice(0, 10));
    }
  } finally {
    process.chdir(originalCwd);
  }

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      newOffers: newOffers.length,
      offers: newOffers.map(o => ({ company: o.company, title: o.title, url: o.url, location: o.location, postedAt: o.postedAt })),
      errors,
      needsVerification: needsAgentHandoff.map(e => e.name),
    }));
    return;
  }

  console.log(`\nsenior-search scan complete.`);
  console.log(`  New offers found: ${newOffers.length}${dryRun ? ' (dry-run, not written)' : ` — written to senior-search/data/pipeline.md`}`);
  if (errors.length) {
    console.log(`  Errors: ${errors.length}`);
    for (const e of errors) console.log(`    - ${e.company}: ${e.error}`);
  }
  if (needsAgentHandoff.length) {
    console.log(`  Needs manual/agent verification (no confirmed ATS yet): ${needsAgentHandoff.map(e => e.name).join(', ')}`);
  }
  for (const offer of newOffers) {
    console.log(`  + ${offer.company} — ${offer.title} (${offer.url})`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('scan-watchlist.mjs')) {
  main().catch(err => {
    console.error('senior-search scan failed:', err);
    process.exitCode = 1;
  });
}
