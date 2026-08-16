import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { rootScript, careerOpsRoot } from "@/lib/career-ops";

// /api/scan — Branch 1A autonomy trigger A: run the fire-hose scanner (scan.mjs,
// the zero-token watchlist scanner with the Smart 1-5 relevance tagger /
// salary-location capture / per-provider caps / fingerprint dedup / negative
// filter). NOT the discovery scanner (scan-ats-full.mjs — that's /api/explore).
//
// Streaming contract: NDJSON over the same ReadableStream pattern the Explore
// route uses (this codebase's SSE-equivalent — the frontend already consumes
// newline-delimited JSON events). Event kinds follow the 1A spec:
//   {"kind":"start","companies":N}
//   {"kind":"progress","found":N,"new":N}
//   {"kind":"offer","title":…,"company":…,"location":…,"relevance":N,"salary":…}
//   {"kind":"summary","found":N,"added":N,"droppedCrosslisted":N,"skipped":N}
//   {"kind":"error","message":…}
// A real scan (no --dry-run) so offers land in data/pipeline.md for the eval
// layer (scan-and-process.mjs) to drain. maxDuration 600s per the 1A spec's
// 300-600s window.

export const runtime = "nodejs";
export const maxDuration = 600;
export const dynamic = "force-dynamic";

// Stable stdout markers emitted by scan.mjs (verified against its source).
const OFFER_RE = /^  \+ (.+) \| (.+) \| (.+)$/; //  + Company | Title | Location
const TOTAL_FOUND_RE = /^Total jobs found:\s+(\d+)/;
const ADDED_RE = /^New offers added:\s+(\d+)/;
const SKIPPED_RE = /^Duplicates:\s+(\d+) skipped/;
const CROSSLIST_RE = /^Cross-listed \/ duplicated postings \(Smart 5\): (\d+) dropped/;

export async function POST(_req: NextRequest) {
  // Guard: a data-only checkout (or pre-onboarding) has no scanner. Fail soft.
  if (!fs.existsSync(rootScript("scan"))) {
    return Response.json(
      { error: "The watchlist scanner isn't available in this checkout yet." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream closed */
        }
      };

      // scan.mjs writes data/pipeline.md + data/scan-history.tsv. Both are
      // appended per-offer / deduped by URL — reentrant-safe, and PM2 (autonomy
      // B) is the only other writer, scheduled hours apart.
      const child = spawn(process.execPath, [rootScript("scan")], {
        cwd: careerOpsRoot(),
        env: { ...process.env },
      });

      let outBuf = "";
      let errBuf = "";
      let found = 0;
      let added = 0;
      let skipped = 0;
      let crosslisted = 0;
      let companies = 0;
      let started = false;
      let killed = false;

      const killer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        send({ kind: "error", message: "scan timed out after 600s" });
        controller.close();
      }, 590_000);

      const handleLine = (line: string) => {
        const m = line.match(OFFER_RE);
        if (m) {
          // relevance/salary ride in the pipeline line as ` | relevance: N` and
          // ` | salary: …` tagged segments after the 3 positional fields.
          let title = m[2];
          let location = m[3];
          let relevance: number | undefined;
          let salary: string | undefined;
          const rel = title.match(/\| relevance: (\d+)/);
          if (rel) {
            relevance = Number(rel[1]);
            title = title.replace(/\| relevance: \d+/, "").trim();
          }
          const sal = title.match(/\| salary: ([^|]+)/);
          if (sal) {
            salary = sal[1].trim();
            title = title.replace(/\| salary: [^|]+/, "").trim();
          }
          const loc = location.match(/\| relevance: (\d+)/);
          if (loc) {
            relevance ??= Number(loc[1]);
            location = location.replace(/\| relevance: \d+/, "").trim();
          }
          send({ kind: "offer", company: m[1].trim(), title: title.trim(), location: location.trim(), relevance, salary });
          return;
        }
        const c = line.match(/^Companies scanned:\s+(\d+)/);
        if (c) companies = Number(c[1]);
        const t = line.match(TOTAL_FOUND_RE);
        if (t) found = Number(t[1]);
        const a = line.match(ADDED_RE);
        if (a) added = Number(a[1]);
        const s = line.match(SKIPPED_RE);
        if (s) skipped = Number(s[1]);
        const x = line.match(CROSSLIST_RE);
        if (x) crosslisted = Number(x[1]);
        if (!started && found > 0) {
          started = true;
          send({ kind: "start", companies });
        }
        // Any progress on the stats lines → a progress event.
        if (found > 0) {
          send({ kind: "progress", found, added, skipped, crosslisted });
        }
      };

      child.stdout.on("data", (d: Buffer) => {
        outBuf += d.toString();
        let idx: number;
        while ((idx = outBuf.indexOf("\n")) !== -1) {
          handleLine(outBuf.slice(0, idx));
          outBuf = outBuf.slice(idx + 1);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        errBuf += d.toString();
        // scan.mjs routes errors/cooldown/skip summaries to stdout, but keep
        // stderr visible in case the child crashes hard.
        const text = errBuf.slice(-4000);
        if (/Error|Traceback|Cannot|ENOENT|EACCES/.test(text)) {
          send({ kind: "error", message: text.split("\n").slice(-3).join(" ").slice(0, 500) });
        }
      });
      child.on("error", (err) => {
        send({ kind: "error", message: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (!killed) {
          send({
            kind: "summary",
            companies,
            found,
            added,
            droppedCrosslisted: crosslisted,
            skipped,
            exitCode: code,
            free: true, // zero LLM tokens — the scanner only does HTTP + JSON
          });
        }
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
