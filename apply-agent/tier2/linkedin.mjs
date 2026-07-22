#!/usr/bin/env node
/**
 * apply-agent/tier2/linkedin.mjs — LinkedIn Tier 2 driver (single job, CLI)
 *
 * Thin wrapper around driver-core.runTier2Apply() for platform: 'linkedin'.
 * A queue-driven daily runner (Phase 5's later "N jobs/day, paced" mode) can
 * import runTier2Apply + pacingDelay directly instead of shelling out to
 * this CLI per job — this file exists for the single-job/manual-test path,
 * mirroring how apply-agent/orchestrator.ts is invoked per job today.
 *
 * Run with:
 *   npx tsx apply-agent/tier2/linkedin.mjs --url <url> --company <name> \
 *     --role <role> [--location <loc>] [--report <num>] \
 *     [--connection-degree 1|2|3] [--connection-name "Jane Doe"]
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
  const degreeArg = parseArg(args, '--connection-degree');
  const connectionDegree = degreeArg ? Number(degreeArg) : null;
  const connectionName = parseArg(args, '--connection-name') || null;

  if (!url) {
    console.error('Usage: tsx apply-agent/tier2/linkedin.mjs --url <url> --company <name> --role <role> [--location <loc>] [--report <num>] [--connection-degree 1|2|3] [--connection-name "Jane Doe"]');
    process.exitCode = 1;
    return;
  }

  const result = await runTier2Apply({ platform: 'linkedin', url, company, role, location, reportRef, connectionDegree, connectionName });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
