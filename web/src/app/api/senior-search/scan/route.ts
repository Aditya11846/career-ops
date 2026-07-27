import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { seniorSearchRoot } from "@/lib/senior-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ScanResult = {
  ok: boolean;
  newOffers?: number;
  offers?: Array<{ company: string; title: string; url: string; location?: string; postedAt?: string }>;
  errors?: Array<{ company: string; error: string }>;
  needsVerification?: string[];
  error?: string;
};

// Triggers a real (non-dry-run) senior-search scan. Unlike api/explore/route.ts's
// runDiscovery(), this is a BLOCKING spawn — scan-watchlist.mjs has no live
// per-company progress events yet (see its header comment), only a final
// summary, so there is nothing to stream. Waits for the child to close, parses
// its single --json stdout blob, returns it as the response body.
export async function POST() {
  const scriptPath = path.join(seniorSearchRoot(), "scan-watchlist.mjs");
  if (!fs.existsSync(scriptPath)) {
    return Response.json({ ok: false, error: "senior-search/scan-watchlist.mjs not found" } satisfies ScanResult, { status: 400 });
  }

  return new Promise<Response>((resolve) => {
    // scan-watchlist.mjs resolves all of its own paths internally via
    // import.meta.url + process.chdir() (see its header comment) — no env var
    // override is needed here, unlike scan-ats-full.mjs's CAREER_OPS_PORTALS.
    const child = spawn(process.execPath, [scriptPath, "--json"], {
      cwd: careerOpsRoot(),
    });

    let outBuf = "";
    let errBuf = "";

    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 230_000);

    child.stdout.on("data", (chunk) => {
      outBuf += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString();
    });

    child.on("error", (e) => {
      clearTimeout(killer);
      resolve(Response.json({ ok: false, error: e.message } satisfies ScanResult, { status: 500 }));
    });

    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        resolve(Response.json({ ok: false, error: errBuf.trim() || `scan-watchlist.mjs exited ${code}` } satisfies ScanResult, { status: 500 }));
        return;
      }
      try {
        const parsed = JSON.parse(outBuf.trim()) as ScanResult;
        resolve(Response.json(parsed));
      } catch {
        resolve(Response.json({ ok: false, error: "could not parse scan-watchlist.mjs --json output" } satisfies ScanResult, { status: 500 }));
      }
    });
  });
}
