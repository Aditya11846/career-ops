import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Branch 1A autonomy B — dashboard status for the PM2 scheduler. GET-only:
// reports whether the two cron jobs (career-ops-scan every 6h,
// career-ops-discovery every 12h) are online, when they last ran, and where
// their logs live. Degrades to a clear "not running" shape when PM2 isn't
// installed or the apps aren't started — the dashboard shows the state, it
// never pretends.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);

type JobStatus = {
  name: string;
  cron: string;
  state: "online" | "stopped" | "error" | "unknown";
  restarts: number;
  uptimeMs: number | null;
  lastRunAt: string | null;
  pid: number | null;
  log: string | null;
};

const JOBS: Array<{ name: string; cron: string }> = [
  { name: "career-ops-scan", cron: "5 */6 * * *" },
  { name: "career-ops-discovery", cron: "17 */12 * * *" },
];

export async function GET() {
  let rows: unknown[] = [];
  try {
    const { stdout } = await execFileP("pm2", ["jlist", "--silent"], { timeout: 10_000 });
    rows = JSON.parse(stdout);
  } catch {
    // pm2 not installed / not started — report all jobs unknown/offline.
  }

  const byName = new Map<string, Record<string, unknown>>();
  for (const row of rows as Array<{ name?: string }>) {
    if (row?.name) byName.set(row.name, row);
  }

  const jobs: JobStatus[] = JOBS.map((job) => {
    const p = byName.get(job.name);
    if (!p) {
      return { ...job, state: "unknown", restarts: 0, uptimeMs: null, lastRunAt: null, pid: null, log: null };
    }
    const pm = (p.pm2_env ?? {}) as Record<string, unknown>;
    const status = pm.status as string | undefined;
    const state: JobStatus["state"] = status === "online" ? "online" : status === "stopped" ? "stopped" : "error";
    // lastRunAt: pm2 doesn't expose a "last cron fire"; uptime is the best
    // online proxy. The run scripts timestamp their own log lines.
    return {
      ...job,
      state,
      restarts: Number(p.restart_time ?? 0),
      uptimeMs: typeof pm.pm_uptime === "number" ? Date.now() - pm.pm_uptime : null,
      lastRunAt: null,
      pid: typeof p.pid === "number" ? p.pid : null,
      log: typeof pm.pm_out_log_path === "string" ? pm.pm_out_log_path : null,
    };
  });

  return NextResponse.json({ ok: true, jobs, installed: rows.length > 0 });
}
