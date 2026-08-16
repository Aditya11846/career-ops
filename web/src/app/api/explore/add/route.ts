import { NextRequest } from "next/server";
import { addOffersToPipeline, runInboxTriage } from "@/lib/core/pipeline";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Free + reversible: append chosen discovered offers to data/pipeline.md AND
// record them in data/scan-history.tsv, via the core's CANONICAL exported writers
// (no parallel writer). No tokens spent.
//
// Automatic-always triage (2026-08-06 decision): every successful add is
// immediately run through the SAME domain-fit/geo-fit gate + ranking the
// nightly cron applies (filter-inbox-by-fit.mjs -> score-inbox.mjs), so
// Explore's manual add path can never flood data/pipeline.md with the kind
// of unfiltered noise a raw scan produces — no separate "triaged" button,
// no opt-out. Still zero LLM tokens; filter-inbox-by-fit.mjs does real
// (free) liveness HTTP checks against the WHOLE pending list each run, so
// this can take a few seconds to tens of seconds depending on pipeline
// size — acceptable since it's still far faster than manual eyeballing.
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[] };
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ added: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ added: 0 });

  const result = await addOffersToPipeline(offers);
  if (!result.added) return Response.json(result);

  const triage = await runInboxTriage();
  return Response.json({ ...result, triage });
}
