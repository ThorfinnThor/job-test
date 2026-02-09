import Link from "next/link";
import type { Job } from "@/lib/types";

export function JobCard({ job }: { job: Job }) {
  const tz = "Europe/Berlin";
  return (
    <div className="card">
      <h3 className="cardTitle">
        <Link href={`/jobs/${encodeURIComponent(job.id)}`}>{job.title}</Link>
      </h3>

      <div className="metaRow">
        <span className="pill">{job.company.name}</span>
        {job.location ? <span className="pill">{job.location}</span> : null}
        {job.workplace ? <span className="pill">{job.workplace}</span> : null}
        {job.employmentType ? <span className="pill">{job.employmentType}</span> : null}
        {job.department ? <span className="pill">{job.department}</span> : null}
      </div>

      <div className="small">
        <span>Source: {job.source.kind}</span>
        {job.postedAt ? (
          <>
            {" · "}
            <span>
              Posted: {new Date(job.postedAt).toLocaleDateString("de-DE", { timeZone: tz })}
            </span>
          </>
        ) : null}
        {" · "}
        <span>Scraped: {new Date(job.scrapedAt).toLocaleString("de-DE", { timeZone: tz })}</span>
      </div>
    </div>
  );
}
