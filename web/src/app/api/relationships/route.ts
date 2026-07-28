import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same shape as /api/followups: the web NEVER reimplements the tracking
// logic, it shells out to the core's own relationships.mjs (--json / --add /
// --touch) and reads its verdict. Keeps the CLI and the dashboard byte-identical.
function run(args: string[]): Promise<string> {
  const script = rootScript("relationships");
  return new Promise((resolve) => {
    execFile("node", [script, ...args], { cwd: careerOpsRoot(), timeout: 15_000 }, (_e, out) => resolve(out || ""));
  });
}

export async function GET() {
  const script = rootScript("relationships");
  if (!fs.existsSync(script)) return Response.json({ available: false, entries: [] });
  const stdout = await run(["--json"]);
  try {
    const entries = JSON.parse(stdout);
    return Response.json({ available: true, entries: Array.isArray(entries) ? entries : [] });
  } catch {
    return Response.json({ available: false, entries: [] });
  }
}

export async function POST(req: Request) {
  let body: { action?: "add" | "touch"; name?: string; role?: string; company?: string; contact?: string; nextAction?: string; notes?: string; n?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  if (body.action === "add") {
    if (!body.name?.trim()) return new Response(JSON.stringify({ error: "name required" }), { status: 400 });
    const args = ["--add", "--name", body.name, "--role", body.role || "", "--company", body.company || ""];
    if (body.contact) args.push("--contact", body.contact);
    if (body.nextAction) args.push("--next-action", body.nextAction);
    if (body.notes) args.push("--notes", body.notes);
    const stdout = await run(args);
    try {
      return Response.json(JSON.parse(stdout));
    } catch {
      return new Response(JSON.stringify({ error: "add failed", raw: stdout }), { status: 500 });
    }
  }

  if (body.action === "touch") {
    if (!body.n) return new Response(JSON.stringify({ error: "n required" }), { status: 400 });
    const args = ["--touch", body.n];
    if (body.nextAction) args.push("--next-action", body.nextAction);
    const stdout = await run(args);
    try {
      return Response.json(JSON.parse(stdout));
    } catch {
      return new Response(JSON.stringify({ error: "touch failed", raw: stdout }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "unknown action" }), { status: 400 });
}
