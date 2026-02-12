"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SortKey } from "@/lib/jobFilter";
import { SKILL_GROUPS, SKILL_BY_ID, groupLabel, labelForSkill } from "@/lib/skills";

type CompanyOption = { id: string; name: string };
type SkillCountOption = { id: string; count: number };

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

export default function Filters(props: {
  companyOptions: CompanyOption[];
  skillOptions: SkillCountOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const selectedCompanies = useMemo(() => getMulti(new URLSearchParams(sp.toString()), "company"), [sp]);
  const selectedStack = useMemo(() => getMulti(new URLSearchParams(sp.toString()), "stack"), [sp]);

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

  function toggleStack(id: string) {
    const curr = new Set(selectedStack);
    if (curr.has(id)) curr.delete(id);
    else curr.add(id);
    push(setMulti(new URLSearchParams(sp.toString()), "stack", Array.from(curr)));
  }

  function clearAll() {
    const next = new URLSearchParams(sp.toString());
    [
      "company",
      "stack",
      "posted",
      "sort",
      "q",
      // legacy params kept for backwards compatibility; clear them too
      "workplace",
      "employment",
      "location",
      "city",
      "country"
    ].forEach((k) => next.delete(k));
    push(next);
  }

  const groupedSkills = useMemo(() => {
    const byGroup = new Map<string, SkillCountOption[]>();
    for (const s of props.skillOptions) {
      const meta = SKILL_BY_ID.get(s.id);
      const g = meta?.group ?? "other";
      const bucket = byGroup.get(g) ?? [];
      if (!byGroup.has(g)) byGroup.set(g, bucket);
      bucket.push(s);

    }
    // sort within group by count desc
    for (const arr of byGroup.values()) {
      arr.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    }

    // group ordering: known groups first, then others
    const ordered: { groupId: string; label: string; items: SkillCountOption[] }[] = [];
    for (const g of SKILL_GROUPS) {
      const items = byGroup.get(g.id);
      if (items && items.length) ordered.push({ groupId: g.id, label: g.label, items });
    }
    const extra = Array.from(byGroup.keys())
      .filter((k) => !SKILL_GROUPS.some((g) => g.id === k))
      .sort((a, b) => a.localeCompare(b));
    for (const g of extra) {
      ordered.push({ groupId: g, label: groupLabel(g), items: byGroup.get(g) });
    }
    return ordered;
  }, [props.skillOptions]);

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
        <div className="filterLabel">Stack</div>
        <div className="checkList">
          {groupedSkills.map((g) => (
            <div key={g.groupId} className="stackGroup">
              <div className="stackGroupLabel">{g.label}</div>
              {g.items.map((s) => (
                <label key={s.id} className="checkItem">
                  <input type="checkbox" checked={selectedStack.includes(s.id)} onChange={() => toggleStack(s.id)} />
                  <span>
                    {labelForSkill(s.id)} <span className="muted">({s.count})</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
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
