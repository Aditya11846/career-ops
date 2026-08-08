"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { FilteredJob, FilteredKind, FilteredPipelineSummary } from "@/lib/career-ops";
import { CompanyLogo } from "@/components/company-logo";
import { cn } from "@/lib/cn";

const KIND_LABEL: Record<FilteredKind, string> = {
  blacklist: "Blacklisted",
  domain: "Domain fit",
  geo: "Geo-restricted",
  dead: "Dead posting",
};

const KIND_TONE: Record<FilteredKind, string> = {
  blacklist: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  domain: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  geo: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  dead: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
};

const KINDS: FilteredKind[] = ["blacklist", "domain", "geo", "dead"];

/** Read-only view of the postings filter-inbox-by-fit.mjs moved out of
 *  data/pipeline.md — same triage the nightly cron runs, and the same triage
 *  Explore's "Add to pipeline" now runs automatically. Nothing here was
 *  deleted (that's deliberate, see AGENTS.md's archive-don't-erase
 *  principle) — this is just the first UI surface for those three files. */
export function FilteredList({ filtered }: { filtered: FilteredPipelineSummary }) {
  const [kind, setKind] = useState<FilteredKind | "all">("all");
  const [q, setQ] = useState("");

  const totalCount = KINDS.reduce((n, k) => n + filtered.counts[k], 0);
  const shownCount = filtered.items.length;

  const view = useMemo(() => {
    let rows = filtered.items;
    if (kind !== "all") rows = rows.filter((r) => r.kind === kind);
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((r) => `${r.company} ${r.role} ${r.location ?? ""}`.toLowerCase().includes(needle));
    return rows;
  }, [filtered.items, kind, q]);

  if (totalCount === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
        <p className="font-display text-lg">Nothing filtered yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
          Postings the domain-fit / geo-fit / liveness triage moves out of the pipeline will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs text-faint">
        Moved out by the same triage the nightly scan runs — nothing here is deleted. Showing the most recent{" "}
        <span className="font-medium text-muted">{shownCount.toLocaleString()}</span> of{" "}
        <span className="font-medium text-muted">{totalCount.toLocaleString()}</span> total.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setKind("all")}
          className={cn(
            "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            kind === "all" ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
          )}
        >
          All <span className="tabular-nums">{totalCount.toLocaleString()}</span>
        </button>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              kind === k ? KIND_TONE[k] : "border-border text-muted hover:text-foreground",
            )}
          >
            {KIND_LABEL[k]} <span className="tabular-nums">{filtered.counts[k].toLocaleString()}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
          <Search className="size-3.5 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter…"
            className="w-40 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </div>
      </div>

      {view.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">No matches.</p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Why filtered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.map((r: FilteredJob, i) => (
                <tr key={`${r.url}-${i}`} className="hover:bg-surface/40">
                  <td className="px-4 py-3 font-medium">
                    <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 transition-colors hover:text-brand">
                      <CompanyLogo name={r.company} size={20} />
                      {r.company}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {r.role}
                    {r.location && <span className="text-faint"> · {r.location}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", KIND_TONE[r.kind])}>
                      {KIND_LABEL[r.kind]}
                    </span>
                    <span className="ml-2 text-xs text-faint">{r.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
