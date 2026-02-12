import Link from "next/link";
import { getChanges } from "@/lib/changes";
import { formatBerlinDateTime, formatBerlinDate } from "@/lib/jobFilter";
import { labelForSkill } from "@/lib/skills";

export const dynamic = "force-dynamic";

function SkillsPills({ skills }: { skills: string[] }) {
  const top = skills.slice(0, 10);
  if (!top.length) return null;
  return (
    <div className="metaRow">
      {top.map((s) => (
        <div key={s} className="pill pillNeutral">
          {labelForSkill(s)}
        </div>
      ))}
    </div>
  );
}

function JobLine({ title, company, location, postedAt }: any) {
  return (
    <div className="metaRow">
      <div className="metaItem">{company?.name ?? "—"}</div>
      <div className="metaItem">{location ?? "—"}</div>
      <div className="metaItem">Posted: {formatBerlinDate(postedAt ?? null)}</div>
      <div className="metaItem muted">{title}</div>
    </div>
  );
}

export default async function ChangesPage() {
  const changes = await getChanges();

  if (!changes) {
    return (
      <div className="page">
        <div className="detail">
          <h1>Changes</h1>
          <p className="muted">No changes file found yet. Run the scraper once to generate public/changes.json.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="topbar">
        <div>
          <h1 style={{ margin: 0 }}>Changes</h1>
          <div className="lastUpdated">
            Generated: {formatBerlinDateTime(changes.generatedAt)}
            {changes.previousScrapedAt ? ` · Previous scrape: ${formatBerlinDateTime(changes.previousScrapedAt)}` : ""}
            {changes.currentScrapedAt ? ` · Current scrape: ${formatBerlinDateTime(changes.currentScrapedAt)}` : ""}
          </div>
        </div>
      </div>

      <div className="detail" style={{ paddingTop: 0 }}>
        <div className="metaRow">
          <div className="pill pillNeutral">New: {changes.counts.new}</div>
          <div className="pill pillNeutral">Updated: {changes.counts.updated}</div>
          <div className="pill pillNeutral">Removed: {changes.counts.removed}</div>
          <a className="linkAnchor" href="/changes.json" target="_blank" rel="noreferrer">
            changes.json
          </a>
        </div>

        {changes.new.length ? (
          <div style={{ marginTop: 18 }}>
            <h2>New</h2>
            <div className="cards">
              {changes.new.map((j) => (
                <div key={j.id} className="card" style={{ display: "block" }}>
                  <Link className="cardTitle" href={`/jobs/${encodeURIComponent(j.id)}`}>
                    {j.title}
                  </Link>
                  <div className="cardCompany">{j.company?.name ?? "—"}</div>
                  <JobLine title={j.title} company={j.company} location={j.location} postedAt={j.postedAt} />
                  <SkillsPills skills={j.skills ?? []} />
                  <div className="metaRow">
                    <a className="linkAnchor" href={j.url} target="_blank" rel="noreferrer">
                      Open posting
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {changes.updated.length ? (
          <div style={{ marginTop: 18 }}>
            <h2>Updated</h2>
            <div className="cards">
              {changes.updated.map((u) => (
                <div key={u.after.id} className="card" style={{ display: "block" }}>
                  <Link className="cardTitle" href={`/jobs/${encodeURIComponent(u.after.id)}`}>
                    {u.after.title}
                  </Link>
                  <div className="cardCompany">{u.after.company?.name ?? "—"}</div>
                  <div className="metaRow">
                    {u.fields.map((f) => (
                      <div key={f} className="pill pillNeutral">
                        {f}
                      </div>
                    ))}
                  </div>
                  <JobLine title={u.after.title} company={u.after.company} location={u.after.location} postedAt={u.after.postedAt} />
                  <SkillsPills skills={u.after.skills ?? []} />
                  <div className="metaRow">
                    <a className="linkAnchor" href={u.after.url} target="_blank" rel="noreferrer">
                      Open posting
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {changes.removed.length ? (
          <div style={{ marginTop: 18 }}>
            <h2>Removed</h2>
            <div className="cards">
              {changes.removed.map((j) => (
                <div key={j.id} className="card" style={{ display: "block" }}>
                  <div className="cardTitle">{j.title}</div>
                  <div className="cardCompany">{j.company?.name ?? "—"}</div>
                  <JobLine title={j.title} company={j.company} location={j.location} postedAt={j.postedAt} />
                  <SkillsPills skills={j.skills ?? []} />
                  <div className="metaRow">
                    <a className="linkAnchor" href={j.url} target="_blank" rel="noreferrer">
                      Open posting
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
