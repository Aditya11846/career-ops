import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import type { DiscoveredOffer } from "./scan";

/**
 * "Add to pipeline" — appends user-selected discovered offers to data/pipeline.md
 * AND records them in data/scan-history.tsv (so future scans dedup them). We reuse
 * the CANONICAL writers exported by the core's scan.mjs (`appendToPipeline`,
 * `appendToScanHistory`) instead of re-implementing the line format / section
 * markers — single source of truth, per the web↔core contract. We invoke them in
 * a short-lived node process (cwd = the user's career-ops root) so the core's own
 * code does the writing; the web never owns a parallel copy of that logic.
 *
 * Discovered-but-not-added offers stay "new" (a dry-run scan writes nothing);
 * only an explicit add records them as seen. No tokens are spent here.
 */
export type AddResult = { added: number; error?: string };

export function addOffersToPipeline(offers: DiscoveredOffer[]): Promise<AddResult> {
  const clean = offers
    .filter((o) => o && typeof o.url === "string" && /^https?:\/\//i.test(o.url))
    .map((o) => ({
      url: o.url,
      company: o.company || "",
      title: o.title || "",
      location: o.location || "",
      source: o.source || o.ats || "explorer",
      // Preserve the optional per-offer signal so it survives to pipeline.md.
      // The core writer treats an empty note as absent (byte-identical output).
      note: o.note || "",
    }));
  if (clean.length === 0) return Promise.resolve({ added: 0 });

  // Data-only / pre-scan-ats checkout has no scan.mjs writers → fail with an
  // actionable message instead of a silent added:0.
  if (!fs.existsSync(rootScript("scan"))) {
    return Promise.resolve({ added: 0, error: "This checkout is data-only — the pipeline writer (scan.mjs) isn't available." });
  }

  const scanUrl = pathToFileURL(rootScript("scan")).href;
  const code = `
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(scanUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  try {
    const offers = JSON.parse(input);
    const date = new Date().toISOString().slice(0, 10);
    appendToPipeline(offers);
    appendToScanHistory(offers, date, "added");
    process.stdout.write(JSON.stringify({ added: offers.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ added: 0, error: e instanceof Error ? e.message : "spawn failed" }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim() || "{}") as AddResult;
        resolve({ added: parsed.added ?? 0, error: parsed.error });
      } catch {
        resolve({ added: 0, error: err.trim().slice(0, 200) || "writer returned no result" });
      }
    });
    child.stdin.write(JSON.stringify(clean));
    child.stdin.end();
  });
}

/**
 * Result of the zero-LLM triage pass — domain-fit + geo-eligibility gate
 * (filter-inbox-by-fit.mjs) followed by ranking (score-inbox.mjs), the SAME
 * two scripts the nightly cron (scripts/cron-daily-scan.sh) runs after
 * scan.mjs. Explore's "Add to pipeline" runs them too, right after writing,
 * so a manually-added posting gets the identical domain/geo gate + fit score
 * the cron gives every automatically-scanned one — no separate unfiltered
 * path into data/pipeline.md.
 */
export type TriageResult = {
  ranked: number;
  kept?: number;
  domainFiltered?: number;
  geoFiltered?: number;
  deadFiltered?: number;
  error?: string;
};

function runScript(nameNoExt: string): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [rootScript(nameNoExt)], { cwd: careerOpsRoot(), env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ out, err: e instanceof Error ? e.message : "spawn failed", code: null }));
    child.on("close", (code) => resolve({ out, err, code }));
  });
}

export async function runInboxTriage(): Promise<TriageResult> {
  if (!fs.existsSync(rootScript("filter-inbox-by-fit")) || !fs.existsSync(rootScript("score-inbox"))) {
    return { ranked: 0, error: "This checkout is data-only — the triage scripts aren't available." };
  }

  const filterRun = await runScript("filter-inbox-by-fit");
  if (filterRun.code !== 0) {
    return { ranked: 0, error: filterRun.err.trim().slice(0, 200) || "filter-inbox-by-fit.mjs failed" };
  }
  const domainFiltered = Number(filterRun.out.match(/Domain-fit filter: (\d+) moved/)?.[1] ?? 0);
  const geoFiltered = Number(filterRun.out.match(/Geo filter: (\d+) moved/)?.[1] ?? 0);
  const deadFiltered = Number(filterRun.out.match(/Liveness filter: (\d+) moved/)?.[1] ?? 0);
  const kept = Number(filterRun.out.match(/(\d+) stay in data\/pipeline\.md/)?.[1] ?? 0);

  const scoreRun = await runScript("score-inbox");
  if (scoreRun.code !== 0) {
    return { ranked: 0, kept, domainFiltered, geoFiltered, deadFiltered, error: scoreRun.err.trim().slice(0, 200) || "score-inbox.mjs failed" };
  }
  const ranked = Number(scoreRun.out.match(/Scored (\d+) pending entries/)?.[1] ?? 0);

  return { ranked, kept, domainFiltered, geoFiltered, deadFiltered };
}
