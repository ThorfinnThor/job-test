import SearchBar from "@/components/SearchBar";
import JobsClient from "@/components/JobsClient";
import { getJobs, getJobsMeta } from "@/lib/jobs";
import { formatBerlinDateTime } from "@/lib/jobFilter";

export default async function JobsPage() {
  const jobs = await getJobs();
  const meta = await getJobsMeta();

  const last = meta?.scrapedAt ?? jobs.map((j) => j.scrapedAt).sort().at(-1) ?? null;

  return (
    <div className="page">
      <div className="topbar">
        <SearchBar />
        <div className="lastUpdated">Last updated: {formatBerlinDateTime(last)}</div>
      </div>

      <JobsClient jobs={jobs} />
    </div>
  );
}
