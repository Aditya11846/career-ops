import { Suspense } from "react";
import { RelationshipsView } from "@/components/relationships-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default function RelationshipsPage() {
  return (
    <Suspense>
      <RelationshipsView />
    </Suspense>
  );
}
