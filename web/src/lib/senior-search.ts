import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import type { InboxJob } from "@/lib/career-ops";

/**
 * senior-search/ is a fully isolated second workspace inside the same
 * career-ops checkout (Aditya's father's job search — see
 * senior-search/scan-watchlist.mjs's header comment for the isolation
 * rationale). This file deliberately mirrors career-ops.ts's shape rather
 * than parameterizing it, so the two workspaces' read paths can never
 * accidentally cross — every function here is hardwired to seniorSearchRoot(),
 * never careerOpsRoot() directly.
 */
export function seniorSearchRoot(): string {
  return path.join(careerOpsRoot(), "senior-search");
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(seniorSearchRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

/** Parse senior-search/data/pipeline.md — same format as career-ops.ts's readInbox(). */
export function readSeniorSearchInbox(): InboxJob[] {
  const md = read("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const parts = m[2].split("|").map((s) => s.trim());
    if (parts.length < 3 || !parts[0]) continue;
    jobs.push({
      done: m[1].toLowerCase() === "x",
      url: parts[0],
      company: parts[1],
      role: parts[2],
      location: parts[3] || undefined,
      compensation: parts[4] || undefined,
    });
  }
  return jobs;
}

/** Parse senior-search/data/scan-history.tsv — same shape as career-ops.ts's readScanDates(). */
export function readSeniorSearchScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue;
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

export type WatchlistCompany = {
  name: string;
  enabled: boolean;
  provider?: string;
  scanMethod?: string;
  notes?: string;
};

/** Read-only parse of senior-search/watchlist.yml's tracked_companies — this route never writes to it. */
export function readWatchlistCompanies(): WatchlistCompany[] {
  const raw = read("watchlist.yml");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return [];
  }
  const doc = (parsed ?? {}) as { tracked_companies?: unknown[]; job_boards?: unknown[] };
  const entries = [...(Array.isArray(doc.tracked_companies) ? doc.tracked_companies : []), ...(Array.isArray(doc.job_boards) ? doc.job_boards : [])];
  return entries
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      name: String(e.name ?? "Unknown"),
      enabled: e.enabled !== false,
      provider: typeof e.provider === "string" ? e.provider : undefined,
      scanMethod: typeof e.scan_method === "string" ? e.scan_method : undefined,
      notes: typeof e.notes === "string" ? e.notes : undefined,
    }));
}

export type SeniorSearchSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  watchlist: WatchlistCompany[];
};

export function seniorSearchSummary(): SeniorSearchSummary {
  const root = seniorSearchRoot();
  const scanDates = readSeniorSearchScanDates();
  return {
    root,
    rootExists: fs.existsSync(root),
    inbox: readSeniorSearchInbox().map((j) => ({ ...j, postedAt: scanDates.get(j.url) })),
    watchlist: readWatchlistCompanies(),
  };
}
