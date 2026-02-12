"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import type { Job } from "@/lib/types";
import Filters from "./Filters";
import JobCard from "./JobCard";
import { applyFilters, collectFacetOptions, DEFAULT_FILTERS, sortJobs, type SortKey } from "@/lib/jobFilter";

function getParam(sp: URLSearchParams, k: string) {
  return sp.get(k) ?? "";
}

function parseCompanies(sp: URLSearchParams): string[] {
  const v = sp.get("company");
  if (!v) return [];
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

function parseStack(sp: URLSearchParams): string[] {
  const v = sp.get("stack");
  if (!v) return [];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function JobsClient({ jobs }: { jobs: Job[] }) {
  const sp = useSearchParams();

  const facets = useMemo(() => collectFacetOptions(jobs), [jobs]);

  const state = useMemo(() => {
    const params = new URLSearchParams(sp.toString());
    const q = getParam(params, "q");
    const companies = parseCompanies(params);
    const stack = parseStack(params);
    const posted = (getParam(params, "posted") || "any") as any;
    const sort = (getParam(params, "sort") || "newest") as SortKey;
    return { ...DEFAULT_FILTERS, q, companies, stack, posted, sort };
  }, [sp]);

  const filtered = useMemo(() => sortJobs(applyFilters(jobs, state), state.sort), [jobs, state]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <Filters companyOptions={facets.companyOptions} skillOptions={facets.skillOptions} />
      </aside>

      <main className="main">
        <div className="resultsHeader">
          <div className="resultsCount">{filtered.length} jobs</div>
        </div>

        <div className="cards">
          {filtered.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}

          {filtered.length === 0 && <div className="empty">No results. Try clearing filters or broadening your search.</div>}
        </div>
      </main>
    </div>
  );
}
