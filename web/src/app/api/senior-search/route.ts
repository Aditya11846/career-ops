import { seniorSearchSummary } from "@/lib/senior-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read fresh local files

// Exposes senior-search/'s own pipeline + watchlist status to the client —
// mirrors api/pipeline/route.ts's shape, but reads only from the isolated
// senior-search/ workspace, never the repo-root data used by Aditya's own search.
export async function GET() {
  const s = seniorSearchSummary();
  return Response.json({
    inbox: s.inbox,
    watchlist: s.watchlist,
    root: s.root,
    rootExists: s.rootExists,
  });
}
