import fs from "node:fs";
import { ExplorerView } from "@/components/explore/explorer-view";
import { ScanWatchlist } from "@/components/explore/scan-watchlist";
import { seedExploreFilters } from "@/lib/core/portals";
import { readInbox, readApplications, careerOpsRoot } from "@/lib/career-ops";
import { DEFAULT_FILTERS } from "@/lib/explore";

// Read live data at request time so a bare checkout (or `next build` with no
// CAREER_OPS_ROOT) never fails — discovery seeds are best-effort.
export const dynamic = "force-dynamic";

export default function ExplorePage() {
  let seed: { filters: typeof DEFAULT_FILTERS; seededFrom: string[] } = { filters: DEFAULT_FILTERS, seededFrom: [] };
  try {
    seed = seedExploreFilters();
  } catch {
    /* bare checkout → defaults */
  }
  let rootExists = false;
  try {
    rootExists = fs.existsSync(careerOpsRoot());
  } catch {
    /* ignore */
  }
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {/* 1A autonomy trigger A — watchlist fire-hose scan (scan.mjs), the
          sibling the Discover button never ran (it only launches scan-ats-full
          discovery). New offers land in data/pipeline.md for the eval layer. */}
      <ScanWatchlist />
      <ExplorerView seed={seed} inboxSnapshot={readInbox()} appsSnapshot={readApplications()} rootExists={rootExists} />
    </div>
  );
}
