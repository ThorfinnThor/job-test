"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { EmploymentType, Workplace } from "@/lib/types";
import type { SortKey } from "@/lib/jobFilter";

type WorkplaceSelect = "any" | Exclude<Workplace, null>;
type EmploymentSelect = "any" | Exclude<EmploymentType, null>;

type CompanyOption = { id: string; name: string };

function updateParams(sp: URLSearchParams, updates: Record<string, string | null>) {
  const next = new URLSearchParams(sp.toString());
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, v);
  }
  return next;
}

function getMulti(sp: URLSearchParams, key: string) {
  const v = sp.get(key);
  if (!v) return [];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function setMulti(sp: URLSearchParams, key: string, values: string[]) {
  const next = new URLSearchParams(sp.toString());
  if (!values.length) next.delete(key);
  else next.set(key, values.join(","));
  return next;
}

export default function Filters(props: { companyOptions: CompanyOption[]; locationOptions: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const selectedCompanies = useMemo(() => getMulti(new URLSearchParams(sp.toString()), "company"), [sp]);

  // URLSearchParams values are strings; keep <select value> strictly string (never null)
  // to satisfy React/TS typing.
  const workplaceParam = sp.get("workplace") ?? "any";
  const employmentParam = sp.get("employment") ?? "any";

  const workplace: WorkplaceSelect =
    workplaceParam === "remote" || workplaceParam === "hybrid" || workplaceParam === "onsite" ? workplaceParam : "any";

  const employment: EmploymentSelect =
    employmentParam === "full_time" ||
    employmentParam === "part_time" ||
    employmentParam === "contract" ||
    employmentParam === "internship" ||
    employmentParam === "temporary"
      ? employmentParam
      : "any";

  const location = sp.get("location") ?? "any";
  const posted = sp.get("posted") ?? "any";
  const sort = (sp.get("sort") ?? "newest") as SortKey;

  function push(next: URLSearchParams) {
    router.replace(`${pathname}?${next.toString()}`);
  }

  function toggleCompany(id: string) {
    const curr = new Set(selectedCompanies);
    if (curr.has(id)) curr.delete(id);
    else curr.add(id);
    push(setMulti(new URLSearchParams(sp.toString()), "company", Array.from(curr)));
  }

  function clearAll() {
    const next = new URLSearchParams(sp.toString());
    ["company", "workplace", "employment", "location", "posted", "sort", "q"].forEach((k) => next.delete(k));
    push(next);
  }

  return (
    <div className="filters">
      <div className="filtersHeader">
        <div className="filtersTitle">Filters</div>
        <button className="link" onClick={clearAll}>
          Clear
        </button>
      </div>

      <div className="filterGroup">
        <div className="filterLabel">Company</div>
        <div className="checkList">
          {props.companyOptions.map((c) => (
            <label key={c.id} className="checkItem">
              <input type="checkbox" checked={selectedCompanies.includes(c.id)} onChange={() => toggleCompany(c.id)} />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="filterGroup">
        <div className="filterLabel">Workplace</div>
        <select
          className="select"
          value={workplace}
          onChange={(e) => push(updateParams(new URLSearchParams(sp.toString()), { workplace: e.target.value }))}
        >
          <option value="any">Any</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">Onsite</option>
        </select>
      </div>

      <div className="filterGroup">
        <div className="filterLabel">Employment</div>
        <select
          className="select"
          value={employment}
          onChange={(e) => push(updateParams(new URLSearchParams(sp.toString()), { employment: e.target.value }))}
        >
          <option value="any">Any</option>
          <option value="full_time">Full-time</option>
          <option value="part_time">Part-time</option>
          <option value="contract">Contract</option>
          <option value="internship">Internship</option>
          <option value="temporary">Temporary</option>
        </select>
      </div>

      <div className="filterGroup">
        <div className="filterLabel">Location</div>
        <select
          className="select"
          value={location}
          onChange={(e) => push(updateParams(new URLSearchParams(sp.toString()), { location: e.target.value }))}
        >
          <option value="any">Any</option>
          {props.locationOptions.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="filterGroup">
        <div className="filterLabel">Posted</div>
        <select
          className="select"
          value={posted}
          onChange={(e) => push(updateParams(new URLSearchParams(sp.toString()), { posted: e.target.value }))}
        >
          <option value="any">Any time</option>
          <option value="1d">Last 24h</option>
          <option value="3d">Last 3 days</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>

      <div className="filterGroup">
        <div className="filterLabel">Sort</div>
        <select
          className="select"
          value={sort}
          onChange={(e) => push(updateParams(new URLSearchParams(sp.toString()), { sort: e.target.value }))}
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="company_az">Company A–Z</option>
          <option value="title_az">Title A–Z</option>
        </select>
      </div>
    </div>
  );
}
