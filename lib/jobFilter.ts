import type { EmploymentType, Job, Workplace } from "./types";

export type SortKey = "newest" | "oldest" | "company_az" | "title_az";

export type FilterState = {
  q: string;
  companies: string[]; // company.id
  workplace: Workplace | "any";
  employment: EmploymentType | "any";
  location: string | "any"; // primary location only
  city: string | "any";
  country: string | "any";
  posted: "any" | "1d" | "3d" | "7d" | "30d";
  sort: SortKey;
};

export const DEFAULT_FILTERS: FilterState = {
  q: "",
  companies: [],
  workplace: "any",
  employment: "any",
  location: "any",
  city: "any",
  country: "any",
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

export function deriveCityCountry(rawLocation: string | null): { city: string | null; country: string | null } {
  const s = (rawLocation ?? "").trim();
  if (!s) return { city: null, country: null };

  // Avoid treating non-places as cities/countries.
  const low = s.toLowerCase();
  if (
    low.includes("remote") ||
    low.includes("hybrid") ||
    low.includes("onsite") ||
    low.includes("home office") ||
    low.includes("multiple locations") ||
    low.includes("mehrere standorte") ||
    low.includes("alle standorte")
  ) {
    return { city: null, country: null };
  }

  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    // Could be a city or a country. We keep it as city to enable a useful filter.
    return { city: parts[0], country: null };
  }

  const city = parts[0] || null;
  const country = parts[parts.length - 1] || null;
  return { city, country };
}

function locationCandidates(job: Job): string[] {
  const out: string[] = [];
  if (job.location) out.push(job.location);
  if (Array.isArray(job.locations)) {
    for (const l of job.locations) if (l) out.push(l);
  }
  // de-dupe
  return Array.from(new Set(out.map((x) => x.trim()).filter(Boolean)));
}

function jobTextForSearch(job: Job): string {
  const parts = [
    job.title,
    job.company?.name,
    job.location ?? "",
    Array.isArray(job.locations) ? job.locations.join(" | ") : "",
    job.workplaceRaw ?? "",
    job.timeType ?? "",
    job.reqId ?? "",
    job.department ?? "",
    job.team ?? "",
    job.jobFamily ?? "",
    job.jobCategory ?? "",
    job.jobType ?? "",
    job.description?.text ?? ""
  ];
  return parts.filter(Boolean).join("\n");
}

export function collectFacetOptions(jobs: Job[]) {
  const companies = new Map<string, string>(); // id->name
  const locations = new Set<string>();
  const cities = new Set<string>();
  const countries = new Set<string>();

  for (const j of jobs) {
    if (j.company?.id && j.company?.name) companies.set(j.company.id, j.company.name);
    if (j.location) locations.add(j.location);

    for (const loc of locationCandidates(j)) {
      const { city, country } = deriveCityCountry(loc);
      if (city) cities.add(city);
      if (country) countries.add(country);
    }
  }

  const companyOptions = Array.from(companies.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const locationOptions = Array.from(locations).sort((a, b) => a.localeCompare(b));

  const cityOptions = Array.from(cities).sort((a, b) => a.localeCompare(b));
  const countryOptions = Array.from(countries).sort((a, b) => a.localeCompare(b));

  return { companyOptions, locationOptions, cityOptions, countryOptions };
}

export function applyFilters(all: Job[], f: FilterState): Job[] {
  const q = f.q.trim();
  const now = new Date();
  const hasCountry = f.country !== "any";

  return all.filter((job) => {
    if (f.companies.length > 0 && !f.companies.includes(job.company?.id)) return false;
    if (f.workplace !== "any" && (job.workplace ?? null) !== f.workplace) return false;
    if (f.employment !== "any" && (job.employmentType ?? null) !== f.employment) return false;
    if (f.location !== "any" && (job.location ?? "") !== f.location) return false;

    if (f.city !== "any" || hasCountry) {
      const derived = locationCandidates(job).map((loc) => deriveCityCountry(loc));

      if (f.city !== "any") {
        const okCity = derived.some((x) => (x.city ?? "") === f.city);
        if (!okCity) return false;
      }

      if (hasCountry) {
        const okCountry = derived.some((x) => (x.country ?? "") === f.country);
        if (!okCountry) return false;
      }
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
