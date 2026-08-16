#!/usr/bin/env node
/**
 * scan-and-process-run.cjs — PM2 job (autonomy B, 6h cadence).
 *
 * Stage 1: scan.mjs — the zero-token fire-hose watchlist scan (Smart 1-5: the
 *   relevance tagger, salary/location capture, per-provider concurrency caps,
 *   fingerprint cross-listing dedup, negative filter). Writes new offers to
 *   data/pipeline.md tagged `relevance: N`.
 * Stage 2: scan-and-process.mjs — drains the pipeline's top-N by relevance
 *   (default 20) into real evaluations + tracker rows. Spends tokens ONLY on
 *   offers that don't already have a report; zero new offers → zero spend.
 *
 * Exit code: 0 even on partial failures (PM2 treats non-zero as crash and
 * autorestart-loops). Each stage logs to .claude/notes/cron-logs/.
 */

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, appendFileSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/../..";
const LOG_DIR = join(ROOT, ".claude/notes/cron-logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, `pm2-scan-${new Date().toISOString().slice(0, 10)}.log`);

function run(stage, args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf-8", timeout: 30 * 60_000 });
  const line = `${new Date().toISOString()} [${stage}] exit=${r.status ?? "signal"} ${r.signal ?? ""} ${(Date.now() - started) / 1000}s`;
  appendFileSync(LOG, line + "\n");
  if (r.stdout) appendFileSync(LOG, r.stdout.slice(-4000) + "\n");
  if (r.stderr) appendFileSync(LOG, "STDERR: " + r.stderr.slice(-2000) + "\n");
  return r.status === 0;
}

// scan-and-process top-N: default 20 per the 1A spec; env-tunable (PM2 env).
const topN = Number(process.env.SCAN_PROCESS_TOP_N) || 20;

run("scan", [join(ROOT, "scan.mjs")]);
run("scan-and-process", [join(ROOT, "scan-and-process.mjs"), "--top", String(topN)]);

process.exit(0);
