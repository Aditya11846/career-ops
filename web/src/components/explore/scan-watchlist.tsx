"use client";

import { useState, useRef } from "react";

// Branch 1A autonomy trigger A — the visible button for /api/scan.
// Runs scan.mjs (fire-hose watchlist scanner with the Smart 1-5 relevance
// tagger / salary capture / per-provider caps / fingerprint dedup / negative
// filter) and streams its NDJSON events into a live list. Offers land in
// data/pipeline.md server-side; this is the status + count surface for Amit
// (web-first — no CLI needed to see the scan run).

type Event =
  | { kind: "start"; companies?: number }
  | { kind: "progress"; found: number; added: number; skipped: number; droppedCrosslisted: number }
  | { kind: "offer"; company: string; title: string; location: string; relevance?: number; salary?: string }
  | { kind: "summary"; found: number; added: number; droppedCrosslisted: number; skipped: number; exitCode: number | null }
  | { kind: "error"; message: string };

export function ScanWatchlist() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [offers, setOffers] = useState<Array<Event & { kind: "offer" }>>([]);
  const [summary, setSummary] = useState<Extract<Event, { kind: "summary" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = async () => {
    setRunning(true);
    setStatus("Starting…");
    setOffers([]);
    setSummary(null);
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/scan", { method: "POST", signal: ac.signal });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        setError((body as { error?: string } | null)?.error ?? `scan failed (HTTP ${res.status})`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let ev: Event;
          try {
            ev = JSON.parse(line) as Event;
          } catch {
            continue;
          }
          if (ev.kind === "start") setStatus(`Scanning ${ev.companies ?? "watchlist"} companies…`);
          else if (ev.kind === "progress") setStatus(`${ev.found} found · ${ev.added} new`);
          else if (ev.kind === "offer") setOffers((o) => [ev as Event & { kind: "offer" }, ...o].slice(0, 200));
          else if (ev.kind === "summary") {
            setSummary(ev);
            setStatus("Done");
          } else if (ev.kind === "error") setError(ev.message);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : "scan failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-100">Watchlist scan (fire-hose)</h3>
        <button
          onClick={run}
          disabled={running}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Scanning…" : "Scan watchlist"}
        </button>
        {running && (
          <button
            onClick={() => abortRef.current?.abort()}
            className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Stop
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-400">{status || "Zero-token scan of the tracked-companies watchlist. New offers land in the pipeline."}</p>
      {summary && (
        <p className="mt-1 text-xs text-emerald-300">
          {summary.added} new · {summary.found} found · {summary.droppedCrosslisted} cross-listed dropped · {summary.skipped} duplicates (exit {summary.exitCode})
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {offers.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-slate-300">
          {offers.map((o, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="text-slate-500">{o.company}</span>
              <span>{o.title}</span>
              <span className="ml-auto text-slate-500">
                {typeof o.relevance === "number" && <span className="mr-2 text-amber-300">r{o.relevance}</span>}
                {o.salary && <span className="mr-2">{o.salary}</span>}
                {o.location}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
