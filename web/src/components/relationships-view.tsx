"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Radar, Plus, Flame } from "lucide-react";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";

type Relationship = {
  n: string;
  name: string;
  role: string;
  company: string;
  lastContact: string;
  nextAction: string;
  status: string;
  notes: string;
  daysSinceContact: number | null;
  daysUntilNextAction: number | null;
  overdue: boolean;
  companyHeat: number | null;
};

export function RelationshipsView() {
  const [entries, setEntries] = useState<Relationship[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const { jobs, startJob } = useJobs();

  function reload() {
    setLoading(true);
    fetch("/api/relationships")
      .then((r) => r.json())
      .then((d) => {
        setAvailable(d.available);
        setEntries(d.entries ?? []);
      })
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  const heatJob = useMemo(() => {
    const runs = jobs.filter((j) => j.kind === "compute-heat").sort((a, b) => b.startedAt - a.startedAt);
    return runs[0];
  }, [jobs]);

  // pick up the result once a "compute-heat" run finishes, without a manual refresh
  useEffect(() => {
    if (heatJob?.status === "done") reload();
  }, [heatJob?.status]);

  const overdueCount = entries.filter((e) => e.overdue).length;
  const sorted = [...entries].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.daysUntilNextAction ?? Infinity) - (b.daysUntilNextAction ?? Infinity));

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 max-sm:pb-24">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Relationships</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="tabular-nums">{entries.length}</span> tracked ·{" "}
            <span className={cn("tabular-nums", overdueCount > 0 && "text-red-600 dark:text-red-400")}>{overdueCount}</span> overdue
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshHeatButton job={heatJob} onStart={() => startJob({ title: "Refresh company signals", subtitle: "funding / GitHub / Reddit / LinkedIn heat", kind: "compute-heat", input: "", page: "/relationships" })} />
          <button
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
          >
            <Plus className="size-4" /> Add contact
          </button>
        </div>
      </div>

      {showForm && <AddContactForm onDone={() => { setShowForm(false); reload(); }} />}

      {!available && !loading && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
          <code className="text-foreground">relationships.mjs</code> not found — this needs a complete career-ops checkout.
        </p>
      )}

      {loading && <p className="mt-6 text-sm text-faint">Loading…</p>}

      {!loading && available && entries.length === 0 && (
        <p className="mt-6 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
          No contacts tracked yet. Add the first person you're reaching out to — recruiter, hiring manager, or peer.
        </p>
      )}

      {!loading && sorted.length > 0 && (
        <ul className="mt-5 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
          {sorted.map((r) => (
            <li key={r.n} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="text-sm font-medium">{r.name}</span>
              <span className="text-xs text-faint">
                {r.role}
                {r.role && r.company ? " @ " : ""}
                {r.company}
              </span>
              {r.companyHeat !== null && (
                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-orange-500/15 text-orange-700 dark:text-orange-400">
                  <Flame className="size-3" /> {r.companyHeat}
                </span>
              )}
              <span className="ml-auto text-xs text-muted">
                last contact {r.lastContact || "never"}
                {r.nextAction && <> · next {r.nextAction}</>}
              </span>
              {r.overdue && <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-700 dark:text-red-400">overdue</span>}
              <TouchButton n={r.n} onDone={reload} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddContactForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await fetch("/api/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", name, role, company, nextAction, notes }),
    });
    setSaving(false);
    onDone();
  }

  return (
    <form onSubmit={submit} className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface/40 p-4 max-sm:grid-cols-1">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (required)" required className="rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50" />
      <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role (Recruiter, Hiring Manager…)" className="rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50" />
      <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" className="rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50" />
      <input type="date" value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Next follow-up date" className="rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50" />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (how you connected, context…)" className="col-span-2 rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50 max-sm:col-span-1" />
      <button type="submit" disabled={saving || !name.trim()} className="col-span-2 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50 max-sm:col-span-1">
        {saving ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

function TouchButton({ n, onDone }: { n: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function touch() {
    setBusy(true);
    await fetch("/api/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "touch", n }),
    });
    setBusy(false);
    onDone();
  }
  return (
    <button onClick={touch} disabled={busy} title="Mark as contacted today" className="rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50">
      {busy ? "…" : "Contacted today"}
    </button>
  );
}

function RefreshHeatButton({ job, onStart }: { job?: Job; onStart: () => void }) {
  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium text-brand max-sm:min-h-[44px]">
        <Loader2 className="size-4 animate-spin" /> Scoring…
      </Link>
    );
  return (
    <button
      onClick={onStart}
      title="Have the agent research funding/GitHub/Reddit/LinkedIn signals for tracked companies (real cost per run)"
      className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
    >
      <Radar className="size-4" /> Refresh company signals
    </button>
  );
}
