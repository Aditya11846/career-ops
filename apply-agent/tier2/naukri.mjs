#!/usr/bin/env node
/**
 * apply-agent/tier2/naukri.mjs — Naukri Tier 2 driver (single job, CLI)
 *
 * Thin wrapper around driver-core.runTier2Apply() for platform: 'naukri'.
 * No warm-intro gate (Naukri has no connections graph) — the driver-core
 * only runs that check for platform: 'linkedin'.
 *
 * Run with:
 *   npx tsx apply-agent/tier2/naukri.mjs --url <url> --company <name> \
 *     --role <role> [--location <loc>] [--report <num>]
 * (with `npm run dev` — or a production `next start` — running in web/)
 */

import { runTier2Apply } from './driver-core.mjs';

function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const url = parseArg(args, '--url');
  const company = parseArg(args, '--company') || '';
  const role = parseArg(args, '--role') || '';
  const location = parseArg(args, '--location') || '';
  const reportRef = parseArg(args, '--report') || null;

  if (!url) {
    console.error('Usage: tsx apply-agent/tier2/naukri.mjs --url <url> --company <name> --role <role> [--location <loc>] [--report <num>]');
    process.exitCode = 1;
    return;
  }

  const result = await runTier2Apply({ platform: 'naukri', url, company, role, location, reportRef });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
