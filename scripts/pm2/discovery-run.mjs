#!/usr/bin/env node
/**
 * discovery-run.cjs — PM2 job (autonomy B, 12-24h cadence).
 *
 * Reverse-ATS discovery across Greenhouse/Lever/Ashby/Workday public boards,
 * seeded by VC portfolios (--seeds) so NEW companies outside the manual
 * watchlist surface their security roles automatically. NOT --dry-run: matching
 * offers land in data/pipeline.md (tagged by scan-ats-full's own domain-fit
 * filtering), then scan-and-process.mjs drains the highest-relevance ones.
 *
 * Exit code 0 even on partial failure (PM2 autorestart-loops on non-zero).
 * Logs to .claude/notes/cron-logs/.
 */

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, appendFileSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/../..";
const LOG_DIR = join(ROOT, ".claude/notes/cron-logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, `pm2-discovery-${new Date().toISOString().slice(0, 10)}.log`);

// Seed sources (seeds/vc-portfolios.mjs) + window, env-tunable via PM2 env.
const seeds = process.env.DISCOVERY_SEEDS || "yc,a16z,sequoia,accel";
const sinceDays = Number(process.env.DISCOVERY_SINCE_DAYS) || 14;
const limitPerAts = Number(process.env.DISCOVERY_LIMIT) || 150;
const ats = process.env.DISCOVERY_ATS || "greenhouse,lever,ashby,workday";

const started = Date.now();
const r = spawnSync(
  process.execPath,
  [
    join(ROOT, "scan-ats-full.mjs"),
    "--since", String(sinceDays),
    "--ats", ats,
    "--limit", String(limitPerAts),
    "--seeds", seeds,
  ],
  { cwd: ROOT, encoding: "utf-8", timeout: 45 * 60_000 },
);

const line = `${new Date().toISOString()} [discovery] exit=${r.status ?? "signal"} ${r.signal ?? ""} ${(Date.now() - started) / 1000}s`;
appendFileSync(LOG, line + "\n");
if (r.stdout) appendFileSync(LOG, r.stdout.slice(-6000) + "\n");
if (r.stderr) appendFileSync(LOG, "STDERR: " + r.stderr.slice(-3000) + "\n");

process.exit(0);
