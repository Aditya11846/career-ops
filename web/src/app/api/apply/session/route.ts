import path from "node:path";
import { openSession } from "@/lib/apply/session";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the agentic drive + interpretation fallbacks spawn a planner

// Only these two platforms have a session-store login file; anything else
// (Tier 1 ATS forms) always opens a fresh, logged-out context.
const TIER2_PLATFORMS = new Set(["linkedin", "naukri"]);

// Open a persistent apply session: headed-but-off-screen Chrome opens the real
// form, we extract + tag its fields. The session stays open for fill + handoff.
// cliId enables the agentic fallback (the AI interprets the live form) when
// deterministic extraction is low-confidence. platform (Tier 2 only) resolves
// a saved storageState — cookies from the candidate's own manual login via
// apply-agent/session-store/login.mjs — never entered by this route itself.
export async function POST(req: Request) {
  let body: { url?: string; cliId?: string; agent?: boolean; _noApplyBtn?: boolean; platform?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return Response.json({ error: "A valid application URL (https://…) is required" }, { status: 400 });
  const platform = (body.platform ?? "").trim();
  const storageStatePath = TIER2_PLATFORMS.has(platform) ? path.join(careerOpsRoot(), "apply-agent/session-store", `${platform}.json`) : undefined;
  try {
    const session = await openSession(url, body.cliId, body.agent, body._noApplyBtn, storageStatePath);
    return Response.json(session);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not open the form" }, { status: 500 });
  }
}
