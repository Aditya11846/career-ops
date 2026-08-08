import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "@/lib/core/safe-write";
import { parseApplications } from "@/lib/tracker-table.mjs";

/**
 * Resolve the career-ops "home" — the directory holding the user's sibling
 * files (cv.md, data/, reports/). In production the web/ app lives inside the
 * career-ops checkout, so the home is its parent (..). Dev overrides via
 * CAREER_OPS_ROOT to read the user's real (gitignored) data from a separate
 * checkout — see web/.env.local.
 */
export function careerOpsRoot(): string {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  return path.resolve(process.cwd(), "..");
}

/**
 * Absolute path to a core root script (e.g. doctor, verify-portals). The `.mjs`
 * is assembled here from the bare name so the literal never appears as a direct
 * `execFile`/`spawn` argument — Next's bundler statically traces such literals
 * as module imports and fails the production build otherwise.
 */
export function rootScript(nameNoExt: string): string {
  return path.join(careerOpsRoot(), `${nameNoExt}.mjs`);
}

// Feature-detect the core's `tracker.mjs delete --num` row-delete (#1200) by probing
// the local script source — older checkouts lack it, so the delete UI hides itself.
export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export type InboxJob = {
  url: string;
  company: string;
  role: string;
  location?: string;
  compensation?: string;
  done: boolean;
  postedAt?: string;
  fitRank?: number | null;
  geoEligibility?: "india-eligible" | "global-remote" | "restricted" | "unknown" | null;
  geoEvidence?: string | null;
};

/** Parse data/pipeline.md — `- [ ] URL | Company | Role [| Location [| Compensation]]`.
 *  Positional split (NOT a greedy trailing group): the optional 4th `location`
 *  (#1015) and 5th `compensation` (#1017) columns must NOT bleed into `role`;
 *  any further trailing columns are ignored gracefully. */
export function readInbox(): InboxJob[] {
  const md = read("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const parts = m[2].split("|").map((s) => s.trim());
    if (parts.length < 3 || !parts[0]) continue; // need at least url | company | role
    // A trailing "posted: YYYY-MM-DD" segment (written by scan.mjs's
    // appendToPipeline) is NOT compensation -- postedAt is already joined
    // separately from data/scan-history.tsv below. Without this check it
    // silently lands here as garbage text (confirmed: 111/142 real rows).
    const rawCompensation = parts[4] || undefined;
    const compensation = rawCompensation && /^posted:\s*\d{4}-\d{2}-\d{2}$/.test(rawCompensation) ? undefined : rawCompensation;
    jobs.push({
      done: m[1].toLowerCase() === "x",
      url: parts[0],
      company: parts[1],
      role: parts[2],
      location: parts[3] || undefined, // optional 4th column (#1015)
      compensation, // optional 5th column (#1017); 6th+ ignored
    });
  }
  return jobs;
}

export type FilteredKind = "domain" | "geo" | "dead";

export type FilteredJob = {
  url: string;
  company: string;
  role: string;
  location?: string;
  reason: string;
  kind: FilteredKind;
};

const FILTERED_FILES: { rel: string; kind: FilteredKind }[] = [
  { rel: "data/pipeline-filtered.md", kind: "domain" },
  { rel: "data/pipeline-geo-filtered.md", kind: "geo" },
  { rel: "data/pipeline-dead-filtered.md", kind: "dead" },
];

// Cap how many rows we actually hand to the client per file — these files are
// append-only across every cron run ever (can run into the thousands), and
// rendering all of them as DOM rows would be slow for no benefit. Counts stay
// exact; only the row list is capped, to the MOST RECENT entries (tail of an
// append-only file), which is what you'd actually want to review.
const FILTERED_CAP = 300;

/** Extract the LAST balanced top-level "(...)" group at the end of `text`, by
 *  scanning backward with a depth counter — NOT a regex, because two separate
 *  cases both appear in real data and a simple first/last-paren regex can't
 *  handle both: a location that legitimately ends in its own parenthetical
 *  ("India (remote)") immediately followed by the real reason
 *  ("(ATS API 404 — posting removed)"), AND a reason that itself contains
 *  nested parens ("pattern matched: job (listing )?not found"). Returns null
 *  if the string doesn't end in ")" or the parens are unbalanced. */
function splitTrailingParen(text: string): { before: string; inner: string } | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.endsWith(")")) return null;
  let depth = 1;
  let i = trimmed.length - 2;
  for (; i >= 0; i--) {
    const c = trimmed[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i < 0) return null;
  return { before: trimmed.slice(0, i).trim(), inner: trimmed.slice(i + 1, trimmed.length - 1) };
}

/** Parse one `- [ ] url | company | role [| location] (reason)` line, written by
 *  filter-inbox-by-fit.mjs. Reason is a parenthetical appended to whichever
 *  field is last (location if present, else role). */
function parseFilteredLine(line: string, kind: FilteredKind): FilteredJob | null {
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const segments = m[2].split("|").map((s) => s.trim());
  if (segments.length < 3 || !segments[0]) return null;
  const [url, company] = segments;
  const last = segments[segments.length - 1];
  const split = splitTrailingParen(last);
  const lastText = split ? split.before : last;
  const reason = split ? split.inner : "";
  const hasLocation = segments.length >= 4;
  return {
    url,
    company,
    role: hasLocation ? segments[2] : lastText,
    location: hasLocation ? lastText || undefined : undefined,
    reason,
    kind,
  };
}

export type FilteredPipelineSummary = {
  counts: Record<FilteredKind, number>;
  items: FilteredJob[]; // capped, most-recent-first, across all three files
};

export function readFilteredPipeline(): FilteredPipelineSummary {
  const counts: Record<FilteredKind, number> = { domain: 0, geo: 0, dead: 0 };
  const items: FilteredJob[] = [];
  for (const { rel, kind } of FILTERED_FILES) {
    const md = read(rel);
    if (!md) continue;
    const lines = md.split("\n").filter((l) => /^\s*-\s*\[/.test(l));
    counts[kind] = lines.length;
    for (const line of lines.slice(-FILTERED_CAP).reverse()) {
      const parsed = parseFilteredLine(line, kind);
      if (parsed) items.push(parsed);
    }
  }
  return { counts, items };
}

export type PostingSignal = {
  rank: number | null;
  geoEligibility: InboxJob["geoEligibility"];
  geoEvidence: string | null;
};

/**
 * Read data/posting-signals.json -> Map<url, PostingSignal>, written by
 * score-inbox.mjs. Same tolerant-missing-file contract as readScanDates():
 * no file -> empty map, a malformed record is skipped, never thrown.
 */
export function readPostingSignals(): Map<string, PostingSignal> {
  const raw = read("data/posting-signals.json");
  const signals = new Map<string, PostingSignal>();
  if (!raw) return signals;
  try {
    const parsed = JSON.parse(raw) as Record<string, { rank?: number | null; geoEligibility?: string; geoEvidence?: string }>;
    for (const [url, record] of Object.entries(parsed)) {
      signals.set(url, {
        rank: typeof record?.rank === "number" ? record.rank : null,
        geoEligibility: (record?.geoEligibility as InboxJob["geoEligibility"]) ?? null,
        geoEvidence: record?.geoEvidence ?? null,
      });
    }
  } catch {
    // malformed file -- treat as empty, never throw
  }
  return signals;
}

/**
 * Read data/scan-history.tsv → Map<url, first_seen(YYYY-MM-DD)>. The scanner
 * already stamps every discovered posting with the date it was first seen
 * (col 2), so we derive the inbox's freshness signal here WITHOUT touching the
 * core (see the inbox-triage build: freshness = option A, no scanner change).
 * Tolerant by construction: no file → empty map (freshness facet just hides);
 * a malformed row is skipped, never thrown (missing ≠ corrupt).
 */
export function readScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue; // skip header
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    // keep the EARLIEST first_seen if a url recurs (it's "first" seen, after all)
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

export type Application = {
  n: string;
  date: string;
  company: string;
  /** Intermediary channel (#1596): agency/recruiter firm, "—" for direct, "" when the tracker has no Via column. */
  via: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
};

/**
 * Parse data/applications.md — the tracker table (source of truth).
 * The header-aware parsing lives in tracker-table.mjs, which resolves headers
 * through the SAME alias table the Node tooling uses (tracker-aliases.json,
 * exported by tracker-parse.mjs as HEADER_ALIASES) — one shared source, no
 * web-side mirror to drift (#954, PR #1598 review).
 */
export function readApplications(): Application[] {
  const md = read("data/applications.md");
  if (!md) return [];
  return parseApplications(md, careerOpsRoot());
}

/**
 * Server-side lifecycle of the user's setup — mirrors the prerequisite list that
 * doctor.mjs uses (cv.md, config/profile.yml, modes/_profile.md, portals.yml), by
 * plain file-stat (no subprocess). Drives the home branch: first-run (no CV) →
 * the CV takeover; in-between (CV but no profile) → gentle nudges; established.
 */
export type LifecyclePhase = "first-run" | "in-between" | "established";
/**
 * Server-side lifecycle, mirroring the core doctor.mjs prerequisite list with the
 * SAME existsSync semantics (the SSOT the OnboardingBanner already reads via
 * /api/doctor). The 4 user-layer prereqs: cv.md, config/profile.yml,
 * modes/_profile.md, portals.yml.
 *   - first-run  → a TRULY empty install (no cv AND no data): the CV takeover.
 *     CRITICAL back-compat (maintainer): NEVER force onboarding on a user who
 *     already has data (a full pipeline/tracker with no cv.md is valid).
 *   - in-between → has cv/data but setup incomplete: dashboard + the nudge banner.
 *   - established → all 4 prereqs present.
 * onboardingNeeded mirrors doctor.mjs: true if ANY prereq is missing → show banner.
 */
export function doctorState(): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(careerOpsRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  const hasData = readApplications().length > 0 || readInbox().some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
  filtered: FilteredPipelineSummary;
};

export function pipelineSummary(): PipelineSummary {
  const root = careerOpsRoot();
  const scanDates = readScanDates();
  const postingSignals = readPostingSignals();
  return {
    root,
    rootExists: fs.existsSync(root),
    // join the freshness date (first_seen) and the cheap fit rank (from
    // score-inbox.mjs) onto each raw posting — the inbox's triage view
    // orders/faceted-filters on both entirely client-side.
    inbox: readInbox().map((j) => {
      const signal = postingSignals.get(j.url);
      return {
        ...j,
        postedAt: scanDates.get(j.url),
        fitRank: signal?.rank ?? null,
        geoEligibility: signal?.geoEligibility ?? null,
        geoEvidence: signal?.geoEvidence ?? null,
      };
    }),
    applications: readApplications(),
    filtered: readFilteredPipeline(),
  };
}

export type ReportData = { content: string; file: string };

/** Locate the evaluation report for an application number
 *  (reports/{n}-{slug}-{date}.md; the leading number may be zero-padded). */
export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  let files: string[];
  try {
    files = fs.readdirSync(path.join(careerOpsRoot(), "reports"));
  } catch {
    return null;
  }
  const match = files.find((f) => f.endsWith(".md") && parseInt(f, 10) === target);
  return match ? path.join(careerOpsRoot(), "reports", match) : null;
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return { content: fs.readFileSync(file, "utf8"), file: path.basename(file) };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  return readApplications().find((a) => a.n === n) ?? null;
}

/** The CANONICAL user-customization file the CLI/TUI reads. Durable facts the
 *  web assistant learns go HERE (single source of truth) inside a managed marker
 *  block — so the CLI sees them too. No web-only memory store (that would drift). */
export function profilePath(): string {
  return path.join(careerOpsRoot(), "modes", "_profile.md");
}

const NOTES_START = "<!-- co-web-notes:start -->";
const NOTES_END = "<!-- co-web-notes:end -->";

/** Read back ONLY the web-assistant managed notes from modes/_profile.md (small,
 *  focused — the agent reads the rest of the canonical files itself). Falls back
 *  to the legacy web-only memory file for back-compat. */
export function readMemory(): string {
  try {
    const md = fs.readFileSync(profilePath(), "utf8");
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) return md.slice(i + NOTES_START.length, j).trim();
  } catch {
    /* no _profile.md yet */
  }
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), ".career-ops-web", "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Append a durable fact to the canonical modes/_profile.md (creating the file +
 *  managed block if needed), PRESERVING existing user content. */
export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}
