import type { Job } from "./types";

export type SortKey = "newest" | "oldest" | "company_az" | "title_az";

export type FilterState = {
  q: string;
  companies: string[]; // company.id
  stack: string[]; // skill ids
  posted: "any" | "1d" | "3d" | "7d" | "30d";
  sort: SortKey;
};

export const DEFAULT_FILTERS: FilterState = {
  q: "",
  companies: [],
  stack: [],
  posted: "any",
  sort: "newest"
};

const TZ = "Europe/Berlin";

export function formatBerlinDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("de-DE", { timeZone: TZ, year: "numeric", month: "short", day: "2-digit" });
}

export function formatBerlinDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE", { timeZone: TZ });
}

export function daysSincePosted(postedAt: string | null, now = new Date()): number | null {
  if (!postedAt) return null;
  const d = new Date(postedAt);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = now.getTime() - d.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function includesCI(hay: string, needle: string) {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function jobTextForSearch(job: Job): string {
  const parts = [
    job.title,
    job.company?.name,
    job.location ?? "",
    Array.isArray(job.locations) ? job.locations.join(" | ") : "",
    job.reqId ?? "",
    job.department ?? "",
    job.team ?? "",
    job.jobFamily ?? "",
    job.jobCategory ?? "",
    job.jobType ?? "",
    Array.isArray(job.skills) ? job.skills.join(" ") : "",
    job.description?.text ?? ""
  ];
  return parts.filter(Boolean).join("\n");
}

export function collectFacetOptions(jobs: Job[]) {
  const companies = new Map<string, string>(); // id->name
  const skillCounts = new Map<string, number>();

  for (const j of jobs) {
    if (j.company?.id && j.company?.name) companies.set(j.company.id, j.company.name);
    if (Array.isArray(j.skills)) {
      for (const s of j.skills) {
        if (!s) continue;
        skillCounts.set(s, (skillCounts.get(s) ?? 0) + 1);
      }
    }
  }

  const companyOptions = Array.from(companies.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Return counts only; UI can map ids to labels via lib/skills.
  const skillOptions = Array.from(skillCounts.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return { companyOptions, skillOptions };
}

export function applyFilters(all: Job[], f: FilterState): Job[] {
  const q = f.q.trim();
  const now = new Date();
  const selectedSkills = new Set(f.stack);

  return all.filter((job) => {
    if (f.companies.length > 0 && !f.companies.includes(job.company?.id)) return false;

    if (selectedSkills.size > 0) {
      const jobSkills = new Set(Array.isArray(job.skills) ? job.skills : []);
      // OR semantics: keep if any selected skill appears.
      let ok = false;
      for (const s of selectedSkills) {
        if (jobSkills.has(s)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }

    if (f.posted !== "any") {
      const days = daysSincePosted(job.postedAt, now);
      if (days === null) return false;

      const limit = f.posted === "1d" ? 1 : f.posted === "3d" ? 3 : f.posted === "7d" ? 7 : 30;
      if (days > limit) return false;
    }

    if (q) {
      const text = jobTextForSearch(job);
      if (!includesCI(text, q)) return false;
    }

    return true;
  });
}

export function sortJobs(jobs: Job[], sort: SortKey): Job[] {
  const copy = [...jobs];

  copy.sort((a, b) => {
    if (sort === "newest" || sort === "oldest") {
      const at = a.postedAt ? new Date(a.postedAt).getTime() : 0;
      const bt = b.postedAt ? new Date(b.postedAt).getTime() : 0;
      return sort === "newest" ? bt - at : at - bt;
    }

    if (sort === "company_az") {
      const c = (a.company?.name ?? "").localeCompare(b.company?.name ?? "");
      if (c !== 0) return c;
      return a.title.localeCompare(b.title);
    }

    const t = a.title.localeCompare(b.title);
    if (t !== 0) return t;
    return (a.company?.name ?? "").localeCompare(b.company?.name ?? "");
  });

  return copy;
}
