import { Suspense } from "react";
import { seniorSearchSummary } from "@/lib/senior-search";
import { SeniorSearchView } from "@/components/senior-search-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default function SeniorSearchPage() {
  const { inbox, watchlist, rootExists } = seniorSearchSummary();
  return (
    <Suspense>
      <SeniorSearchView inbox={inbox} watchlist={watchlist} rootExists={rootExists} />
    </Suspense>
  );
}
