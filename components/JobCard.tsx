import Link from "next/link";
import type { Job } from "@/lib/types";
import { formatBerlinDate } from "@/lib/jobFilter";

function pillClass(kind: string | null) {
  if (kind === "remote") return "pill pillRemote";
  if (kind === "hybrid") return "pill pillHybrid";
  if (kind === "onsite") return "pill pillOnsite";
  return "pill pillNeutral";
}

function empLabel(emp: Job["employmentType"]) {
  if (emp === "full_time") return "Full-time";
  if (emp === "part_time") return "Part-time";
  if (emp === "contract") return "Contract";
  if (emp === "internship") return "Internship";
  if (emp === "temporary") return "Temporary";
  return "—";
}

// Named export for compatibility (some files may import { JobCard })
export function JobCard({ job }: { job: Job }) {
  const posted = formatBerlinDate(job.postedAt);

  return (
    <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="card">
      <div className="cardTop">
        <div className="cardTitle">{job.title}</div>
        <div className="cardCompany">{job.company?.name ?? "—"}</div>
      </div>

      <div className="metaRow">
        <div className="metaItem">{job.location ?? "—"}</div>
        <div className={pillClass(job.workplace ?? null)}>{job.workplace ?? "unknown"}</div>
        <div className="pill pillNeutral">{empLabel(job.employmentType)}</div>
        <div className="metaItem">Posted: {posted}</div>
      </div>
    </Link>
  );
}

export default JobCard;
