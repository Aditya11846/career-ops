// Client-safe types + codec for the Explorer (job discovery). NO node imports —
// both client components and server routes import this for the shared shapes, so
// the filter contract, the discovered-offer shape, and the stream-event grammar
// can never drift between the two halves. Server-only logic (spawning the scanner,
// writing temp files) lives in lib/core/{scan,portals,pipeline}.ts.

export type AtsSource = "greenhouse" | "lever" | "ashby" | "workday";
export const ATS_SOURCES: AtsSource[] = ["greenhouse", "lever", "ashby", "workday"];
export const ATS_LABEL: Record<AtsSource, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
};

// VC portfolio seed sources (scan-ats-full.mjs --seeds, backed by
// seeds/vc-portfolios.mjs) — a company-first discovery path (funded/notable
// startups) instead of the raw full-ATS-directory walk. Labels copied
// verbatim from seeds/vc-portfolios.mjs's own SEED_SOURCES so the UI never
// drifts from what the scanner itself calls these.
export type SeedSource = "yc" | "a16z";
export const SEED_SOURCES: SeedSource[] = ["yc", "a16z"];
export const SEED_LABEL: Record<SeedSource, string> = {
  yc: "Y Combinator Portfolio",
  a16z: "Andreessen Horowitz (a16z) Portfolio",
};

/** The full UI filter state. The keyword/location lists mirror scan.mjs's
 *  buildTitleFilter / buildLocationFilter semantics; sinceDays/ats/limitPerAts map
 *  to scan-ats-full.mjs's --since / --ats / --limit. seeds maps to --seeds. */
export type ExploreFilters = {
  positive: string[];
  negative: string[];
  allow: string[];
  block: string[];
  alwaysAllow: string[];
  sinceDays: number;
  ats: AtsSource[];
  seeds: SeedSource[];
  limitPerAts: number;
};

// Representative subset of compute-fit.mjs's SUGGESTED_POSITIVE_TERMS
// (strong + moderate tiers, hand-picked — not all ~30, so the field starts
// useful rather than overwhelming). Hardcoded here rather than imported: this
// file is deliberately node-import-free (shared by client components), and
// compute-fit.mjs is a root-level system script outside the web bundle, same
// reason scan.ts loads it via a runtime dynamic import rather than a static
// one. Fully editable in the UI — a starting suggestion, not a lock.
const SUGGESTED_POSITIVE_DEFAULT = [
  "zero trust", "endpoint security", "embedded systems", "vulnerability",
  "incident response", "application security", "firmware", "cryptography",
];

export const DEFAULT_FILTERS: ExploreFilters = {
  positive: [...SUGGESTED_POSITIVE_DEFAULT],
  // Real starter exclude list — the job classes that produced live production
  // false positives before the word-boundary fix (Store Driver, CDL Delivery
  // Truck Driver) and their close relatives.
  negative: ["CDL", "delivery driver", "truck driver", "trucking", "transportation", "warehouse", "retail associate", "retail sales"],
  allow: [],
  block: [],
  alwaysAllow: [],
  sinceDays: 7,
  // Company-first (seed) discovery is now the default source (see SEED_LABEL
  // above); the raw full-ATS-directory walk is an explicit opt-in, not the
  // default — set ats back to [...ATS_SOURCES] to also (or instead) crawl it.
  ats: [],
  seeds: [...SEED_SOURCES],
  limitPerAts: 150,
};

export type DiscoveredOffer = {
  url: string;
  company: string;
  title: string;
  location: string;
  /** YYYY-MM-DD, or "" when the engine reported n/a (AI offers always "") */
  postedAt: string;
  ats: string;
  source: string;
  /** which positive keyword matched the title (transparency, e.g. "ai" in "Nail") */
  matchedKeyword?: string;
  /** optional free-text ranking signal preserved to pipeline.md by the canonical
   *  writer (scan.mjs formatPipelineOffer). Generic and source-agnostic — an
   *  importer can attach a note; the deterministic scan omits it. */
  note?: string;
  // ── AI-search (modes/discover.md) additions — all optional, so the
  //    deterministic scan offer is unaffected (fields simply absent). ──
  /** present ONLY on AI offers → drives the "unverified" badge. AI finds can't be
   *  liveness-confirmed (AGENTS.md); the scan hits a live ATS API so it omits this. */
  verification?: "unconfirmed";
  /** one-line "why it matched" judgment (the thing a deterministic scan can't give) */
  why?: string;
  /** human freshness ("~5d ago", "unknown") shown when postedAt is "" */
  postedHint?: string;
  confidence?: "low" | "medium" | "high";
};

/** The two discovery surfaces: free deterministic Scan vs token-spending AI search. */
export type ExploreMode = "scan" | "ai";

/** Stream event grammar (NDJSON). `kind` discriminates. Discovery is FREE — the
 *  terminal `done` always carries cost {tokens:0, usd:0}. */
export type ScanEvent =
  | { kind: "start"; ats: string[]; sinceDays: number; limit: number; free: true }
  | { kind: "atsStart"; ats: string; companies: number }
  | { kind: "progress"; ats: string; scanned: number; total: number; matches: number }
  | { kind: "atsDone"; ats: string; unreachable: number }
  | { kind: "offer"; offer: DiscoveredOffer }
  | {
      kind: "summary";
      companiesScanned: number;
      unreachable: number;
      matches: number;
      // Authoritative degraded-vs-empty signals from the scanner's --json mode (#1199).
      // Absent on older local checkouts (the legacy human-stdout parse can't supply them).
      companiesAvailable?: number;
      capHit?: boolean;
      datasetStatus?: Record<string, "ok" | "stale" | "empty">;
      postingsDroppedNoDate?: number;
      // How many postings this scan dropped for scoring below TITLE_FIT_MIN_SCORE
      // on compute-fit.mjs's scoreDomainFit(title + location) — the same
      // domain-fit gate filter-inbox-by-fit.mjs already applies to every scan
      // result post-hoc, now applied live to the Explore stream itself.
      domainFiltered?: number;
    }
  | { kind: "log"; line: string }
  | { kind: "error"; message: string }
  | { kind: "done"; count: number; offers: DiscoveredOffer[]; cost?: { tokens: number; usd: number } };

// cleanChips is defined in clean-chips.mjs (plain JS) so it can be shared
// with the test suite without a TypeScript runner. Import for internal use
// and re-export for external consumers (filter-builder.tsx, etc.).
import { cleanChips } from "./clean-chips.mjs";
export { cleanChips };

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// An explicit empty selection is now a meaningful, intentional state (seed-
// only discovery, ats deselected) — not "unset, fall back to everything".
// Only a genuinely missing/non-array value falls back to the full list.
function cleanAts(v: unknown): AtsSource[] {
  if (!Array.isArray(v)) return [...ATS_SOURCES];
  const out = v
    .map((a) => String(a).toLowerCase())
    .filter((a): a is AtsSource => (ATS_SOURCES as string[]).includes(a));
  return Array.from(new Set(out));
}

function cleanSeeds(v: unknown): SeedSource[] {
  if (!Array.isArray(v)) return [...SEED_SOURCES];
  const out = v
    .map((s) => String(s).toLowerCase())
    .filter((s): s is SeedSource => (SEED_SOURCES as string[]).includes(s));
  return Array.from(new Set(out));
}

/** Apply a (possibly partial) action/assistant patch onto a base. The assistant
 *  emits {positive,negative,allow,block,alwaysAllow,since,ats,limit}. With
 *  merge=true, list fields are ADDED to the base; otherwise the given fields
 *  REPLACE. Unspecified fields are left as-is. */
export function parseExplorePatch(
  raw: Record<string, unknown>,
  base: ExploreFilters = DEFAULT_FILTERS,
  merge = false,
): ExploreFilters {
  const next: ExploreFilters = { ...base, ats: [...base.ats], seeds: [...base.seeds] };
  const lists: [keyof ExploreFilters, string][] = [
    ["positive", "positive"],
    ["negative", "negative"],
    ["allow", "allow"],
    ["block", "block"],
    ["alwaysAllow", "alwaysAllow"],
  ];
  for (const [field, key] of lists) {
    if (raw[key] === undefined) continue;
    const incoming = cleanChips(raw[key]);
    next[field] = (merge ? cleanChips([...(base[field] as string[]), ...incoming]) : incoming) as never;
  }
  if (raw.since !== undefined) next.sinceDays = clampNum(raw.since, 1, 60, base.sinceDays);
  if (raw.sinceDays !== undefined) next.sinceDays = clampNum(raw.sinceDays, 1, 60, base.sinceDays);
  if (raw.limit !== undefined) next.limitPerAts = clampNum(raw.limit, 50, 500, base.limitPerAts);
  if (raw.limitPerAts !== undefined) next.limitPerAts = clampNum(raw.limitPerAts, 50, 500, base.limitPerAts);
  if (raw.ats !== undefined) next.ats = cleanAts(raw.ats);
  if (raw.seeds !== undefined) next.seeds = cleanSeeds(raw.seeds);
  return next;
}

/** URL <-> filters codec (so a search is shareable/restorable). */
export function filtersToParams(f: ExploreFilters): string {
  const sp = new URLSearchParams();
  if (f.positive.length) sp.set("q", f.positive.join(","));
  if (f.negative.length) sp.set("not", f.negative.join(","));
  if (f.allow.length) sp.set("loc", f.allow.join(","));
  if (f.block.length) sp.set("noloc", f.block.join(","));
  if (f.alwaysAllow.length) sp.set("home", f.alwaysAllow.join(","));
  if (f.sinceDays !== DEFAULT_FILTERS.sinceDays) sp.set("since", String(f.sinceDays));
  if (f.ats.join(",") !== DEFAULT_FILTERS.ats.join(",")) sp.set("ats", f.ats.join(","));
  if (f.seeds.join(",") !== DEFAULT_FILTERS.seeds.join(",")) sp.set("seeds", f.seeds.join(","));
  if (f.limitPerAts !== DEFAULT_FILTERS.limitPerAts) sp.set("limit", String(f.limitPerAts));
  return sp.toString();
}

export function paramsToFilters(sp: URLSearchParams, base: ExploreFilters = DEFAULT_FILTERS): ExploreFilters {
  const split = (s: string | null) => (s ? s.split(",") : undefined);
  return parseExplorePatch(
    {
      positive: split(sp.get("q")),
      negative: split(sp.get("not")),
      allow: split(sp.get("loc")),
      block: split(sp.get("noloc")),
      alwaysAllow: split(sp.get("home")),
      since: sp.get("since") ?? undefined,
      ats: split(sp.get("ats")),
      seeds: split(sp.get("seeds")),
      limit: sp.get("limit") ?? undefined,
    },
    base,
  );
}

/** AI-search URL codec (so an AI hunt is shareable/restorable). */
export function aiToParams(intent: string): string {
  const sp = new URLSearchParams();
  sp.set("mode", "ai");
  if (intent.trim()) sp.set("intent", intent.trim());
  return sp.toString();
}

export function paramsToAi(sp: URLSearchParams): string | null {
  if (sp.get("mode") !== "ai") return null;
  return sp.get("intent") ?? "";
}

/** Is the search broad enough that "nothing found" means "you're current"
 *  (good news) rather than "loosen your filters" (actionable)? */
export function isBroadSearch(f: ExploreFilters): boolean {
  return f.positive.length <= 1 && f.block.length === 0 && f.allow.length === 0;
}
