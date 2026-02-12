import Link from "next/link";
import type { Metadata } from "next";
import { getJobById, excerpt } from "@/lib/jobs";
import { formatBerlinDate } from "@/lib/jobFilter";
import { labelForSkill } from "@/lib/skills";

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const job = await getJobById(decodeURIComponent(params.id));
  if (!job) return { title: "Job not found" };

  const desc = excerpt(job.description?.text, 180) || `Open role at ${job.company.name}.`;
  return {
    title: job.title,
    description: desc,
    alternates: { canonical: `/jobs/${encodeURIComponent(job.id)}` },
    openGraph: { title: job.title, description: desc, type: "article" }
  };
}

function jsonLd(job: any) {
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    hiringOrganization: { name: job.company?.name },
    employmentType: job.employmentType ?? undefined,
    description: job.description?.html ?? job.description?.text ?? undefined,
    url: job.url,
    datePosted: job.postedAt ?? undefined
  };
}

export default async function JobDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const job = await getJobById(id);

  if (!job) {
    return (
      <div className="page">
        <div className="detail">
          <Link className="linkAnchor" href="/jobs">
            ← Back
          </Link>
          <h1>Job not found</h1>
          <p className="muted">
            The job ID <span className="mono">{id}</span> is not in the current dataset.
          </p>
        </div>
      </div>
    );
  }

  const posted = formatBerlinDate(job.postedAt);
  const skills = Array.isArray(job.skills) ? job.skills : [];

  return (
    <div className="page">
      <div className="detail">
        <Link className="linkAnchor" href="/jobs">
          ← Back
        </Link>

        <div className="detailHeader">
          <h1 className="detailTitle">{job.title}</h1>
          <div className="detailCompany">{job.company?.name ?? "—"}</div>

          <div className="detailMeta">
            <div>
              <b>Location:</b> {job.location ?? "—"}
            </div>
            {Array.isArray(job.locations) && job.locations.length > 1 ? (
              <div>
                <b>All locations:</b> {job.locations.join(" | ")}
              </div>
            ) : null}
            <div>
              <b>Workplace:</b> {job.workplace ?? "unknown"} {job.workplaceRaw ? `(${job.workplaceRaw})` : ""}
            </div>
            <div>
              <b>Employment:</b> {job.employmentType ?? "—"} {job.timeType ? `(${job.timeType})` : ""}
            </div>
            {Array.isArray(job.skills) && job.skills.length ? (
              <div>
                <b>Stack:</b> {job.skills.map((s) => labelForSkill(s)).join(" · ")}
              </div>
            ) : null}
            <div>
              <b>Posted:</b> {posted}
            </div>
            {job.reqId ? (
              <div>
                <b>Req ID:</b> <span className="mono">{job.reqId}</span>
              </div>
            ) : null}
          </div>

          <div className="detailCtas">
            <a className="btnPrimary" href={job.applyUrl ?? job.url} target="_blank" rel="noreferrer">
              Apply
            </a>
            <a className="btn" href={job.url} target="_blank" rel="noreferrer">
              Open posting
            </a>
          </div>
        </div>

        <div className="detailBody">
          <h2>Description</h2>
          <div className="description">{job.description?.text ? job.description.text : "—"}</div>
        </div>

        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(job)) }} />
      </div>
    </div>
  );
}
