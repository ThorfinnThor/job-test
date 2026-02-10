import SearchBar from "@/components/SearchBar";
import JobsClient from "@/components/JobsClient";
import { getJobs, getJobsMeta } from "@/lib/jobs";
import { formatBerlinDateTime } from "@/lib/jobFilter";
import { Suspense } from "react";

// This page depends on URL search params (client-side filtering),
// so we avoid build-time static prerendering.
export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const jobs = await getJobs();
  const meta = await getJobsMeta();

  const last = meta?.scrapedAt ?? jobs.map((j) => j.scrapedAt).sort().at(-1) ?? null;

  return (
    <div className="page">
      <div className="topbar">
        <Suspense fallback={<div className="searchWrap" />}>
          <SearchBar />
        </Suspense>
        <div className="lastUpdated">Last updated: {formatBerlinDateTime(last)}</div>
      </div>

      <Suspense fallback={<div className="empty">Loading…</div>}>
        <JobsClient jobs={jobs} />
      </Suspense>
    </div>
  );
}
