"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function setParam(params: URLSearchParams, key: string, value: string) {
  if (!value) params.delete(key);
  else params.set(key, value);
}

export default function SearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const initial = useMemo(() => sp.get("q") ?? "", [sp]);
  const [value, setValue] = useState(initial);

  function apply(v: string) {
    const params = new URLSearchParams(sp.toString());
    setParam(params, "q", v.trim());
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="searchWrap">
      <input
        className="searchInput"
        placeholder="Search title, location, keywords…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply(value);
          if (e.key === "Escape") {
            setValue("");
            apply("");
          }
        }}
      />
      <button className="btn" onClick={() => apply(value)}>
        Search
      </button>
    </div>
  );
}
