"use client";

import { useState } from "react";
import { Check, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { CompanyLogo } from "@/components/company-logo";

export type OverdueRelationship = { n: string; name: string; role: string; company: string; nextAction: string };

// One-tap overdue relationship row on the home dashboard — same demand-loop
// shape as FollowUpCard (applications), but for people (relationships.mjs).
// "Contacted today" calls /api/relationships {action:"touch"} and optimistically
// clears the row; "Snooze" is a client-only dismiss, same as FollowUpCard.
export function RelationshipFollowUpCard({ item, onLogged }: { item: OverdueRelationship; onLogged?: () => void }) {
  const [state, setState] = useState<"idle" | "logging" | "done" | "snoozed">("idle");
  if (state === "snoozed" || state === "done") return null;

  const log = async () => {
    setState("logging");
    try {
      await fetch("/api/relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "touch", n: item.n }),
      });
    } catch {
      /* best-effort */
    }
    onLogged?.();
    setState("done");
  };

  return (
    <div className="row-lift flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface/40 px-3.5 py-3 transition hover:border-brand/30">
      <div className="flex min-w-0 flex-[1_1_55%] items-center gap-3">
        <CompanyLogo name={item.company} size={22} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="font-medium text-foreground">{item.name}</span>
            {item.role && <span className="text-muted"> · {item.role}</span>}
          </p>
          <p className="flex items-center gap-1 text-[11px] text-faint">
            <Clock className="size-3" /> {item.nextAction ? `follow-up was due ${item.nextAction}` : "follow-up due"}
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={state === "logging"}
          onClick={log}
          className={cn("inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-brand-soft hover:text-brand max-sm:min-h-[44px]")}
        >
          <Check className="size-3.5" /> <span className="hidden sm:inline">Contacted today</span><span className="sm:hidden">Done</span>
        </button>
        <button type="button" onClick={() => setState("snoozed")} className="inline-flex shrink-0 items-center justify-center text-[11px] text-faint transition hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]">
          Snooze
        </button>
      </div>
    </div>
  );
}
