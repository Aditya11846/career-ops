import { submitSession, closeSession } from "@/lib/apply/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Clicks the real Submit control on an already-filled, already-human-approved
// session. Requires confirm:true in the body — pure defense-in-depth so a
// stray/typo'd request against this route can't fire a real submission.
// The actual human-review gate lives one layer up: apply-agent/approve-queue.mjs
// only calls this route for entries the candidate has already marked
// "approved" after looking at the filled form themselves.
export async function POST(req: Request) {
  let body: { sessionId?: string; confirm?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.sessionId) {
    return Response.json({ ok: false, error: "sessionId is required" }, { status: 400 });
  }
  if (body.confirm !== true) {
    return Response.json({ ok: false, error: "confirm:true is required to submit" }, { status: 400 });
  }
  try {
    const result = await submitSession(body.sessionId);
    await closeSession(body.sessionId).catch(() => {});
    return Response.json(result);
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
