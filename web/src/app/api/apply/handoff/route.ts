import { handoffSession } from "@/lib/apply/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bring one already-filled, still-open apply session's browser window to the
// front so the human can review + click submit themselves. Used by the
// batch-approve queue (apply-agent/approve-queue.mjs) — never submits on its
// own, only makes the pre-filled tab visible on request.
export async function POST(req: Request) {
  let body: { sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.sessionId) {
    return Response.json({ ok: false, error: "sessionId is required" }, { status: 400 });
  }
  try {
    await handoffSession(body.sessionId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}
