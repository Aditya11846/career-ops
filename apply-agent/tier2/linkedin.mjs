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
 *
 * STATUS (2026-07-23): kept in place deliberately, not dead code to delete —
 * LinkedIn Tier 2 auto-apply is currently BLOCKED BY DESIGN, not by a bug.
 * See apply-agent/session-store/login.mjs's file header for the full
 * writeup: the li_at session cookie is confirmed present and correctly
 * decrypted, but LinkedIn's own anti-automation detection forces a
 * CDP-controlled browser back to login even with a valid cookie. A stealth
 * workaround exists (patchright etc., hiding Playwright's CDP fingerprint)
 * but is deliberately not used — evading LinkedIn's bot detection
 * contradicts this project's explicit design stance. This file (and
 * driver-core.mjs's platform==='linkedin' branch, including the warm-intro
 * gate) is left working and documented in case LinkedIn's detection
 * behavior ever changes; Naukri is the supported Tier 2 path for now.
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
