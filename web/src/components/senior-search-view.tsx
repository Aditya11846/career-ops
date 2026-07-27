"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, CheckCircle2, HelpCircle } from "lucide-react";
import type { InboxJob } from "@/lib/career-ops";
import type { WatchlistCompany } from "@/lib/senior-search";
import { Badge } from "@/components/ui/badge";

export function SeniorSearchView({
  inbox,
  watchlist,
  rootExists,
}: {
  inbox: InboxJob[];
  watchlist: WatchlistCompany[];
  rootExists: boolean;
}) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const scannable = watchlist.filter((c) => c.enabled);
  const needsVerification = watchlist.filter((c) => !c.enabled);

  async function runScan() {
    setScanning(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/senior-search/scan", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setLastResult(`Found ${data.newOffers} new offer${data.newOffers === 1 ? "" : "s"}.`);
        router.refresh();
      } else {
        setLastResult(`Scan failed: ${data.error}`);
      }
    } catch (err) {
      setLastResult(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }

  if (!rootExists) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-display text-2xl tracking-tight text-landing">Dad&apos;s Search</h1>
        <p className="mt-2 text-sm text-muted">senior-search/ workspace not found — nothing set up yet.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Dad&apos;s Search</h1>
          <p className="mt-1 text-sm text-muted">
            Isolated job search — Zero Trust, endpoint security, embedded systems. Comp-first, borderless, remote-only.
          </p>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <RefreshCw className={scanning ? "size-4 animate-spin" : "size-4"} />
          {scanning ? "Scanning…" : "Run scan"}
        </button>
      </div>

      {lastResult && <p className="mt-3 text-sm text-muted">{lastResult}</p>}

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-landing">Watchlist ({watchlist.length} companies)</h2>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {watchlist.map((c) => (
            <div key={c.name} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="truncate">{c.name}</span>
              {c.enabled ? (
                <Badge tone="good" className="inline-flex items-center gap-1">
                  <CheckCircle2 className="size-3" /> scanning
                </Badge>
              ) : (
                <Badge tone="warn" className="inline-flex items-center gap-1">
                  <HelpCircle className="size-3" /> needs verification
                </Badge>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {scannable.length} companies actively scanning, {needsVerification.length} awaiting ATS/provider verification before they can be enabled.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-landing">Pipeline ({inbox.length} postings)</h2>
        {inbox.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No postings yet — run a scan to populate this.</p>
        ) : (
          <ul className="mt-3 divide-y">
            {inbox.map((job) => (
              <li key={job.url} className="py-2 text-sm">
                <a href={job.url} target="_blank" rel="noreferrer" className="font-medium text-landing hover:underline">
                  {job.role}
                </a>
                <span className="text-muted"> — {job.company}{job.location ? ` · ${job.location}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
