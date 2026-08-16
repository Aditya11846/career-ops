"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Loader2, Users2, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

// Fires the real career-ops "contacto" mode (worker kind "contacto") — finds
// real hiring-manager/recruiter/peer/interviewer contacts for THIS application
// via WebSearch, drafts a per-persona outreach message, and adds each real
// contact found to the relationship tracker (draft saved in its notes).
// Draft-only, always: nothing here ever sends a message on the user's behalf.
export function FindContactsButton({ n, company }: { n: string; company: string }) {
  const { jobs, startJob } = useJobs();
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "contacto" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const run = () =>
    startJob({ title: `Find contacts · ${company}`, subtitle: "hiring manager / recruiter / peers, draft outreach", kind: "contacto", input: n, page: `/pipeline/${n}` });

  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 animate-spin" /> Finding contacts…
      </Link>
    );

  if (job?.status === "done")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Link href="/relationships" className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]">
          <Users2 className="size-3.5" /> {job.result?.summary ?? "View contacts"}
        </Link>
        <button onClick={run} title="Run again" className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]">
          <RotateCcw className="size-3" />
        </button>
      </span>
    );

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={run}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        title="PEOPLE, not company signals: finds the hiring manager, recruiter, and team peers for this role (real LinkedIn/email when discoverable) and drafts outreach messages (draft only, never sent automatically). For company-level hiring signals instead, use 'Refresh company signals' on the Relationships page."
      >
        <Users2 className="size-3.5" /> Find contacts
      </button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}
