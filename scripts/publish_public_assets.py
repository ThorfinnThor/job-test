#!/usr/bin/env python3
import json
import os
import shutil
from datetime import datetime, timezone

ROOT_ALL_JSON = "data/all_stopped_trials.json"
ROOT_ALL_CSV = "data/all_stopped_trials.csv"

ROOT_BIO_JSON = "data/biological_failure_trials.json"
ROOT_BIO_CSV = "data/biological_failure_trials.csv"

PUBLIC_DIR = os.path.join("web", "public")

PUBLIC_ALL_JSON = os.path.join(PUBLIC_DIR, "all_stopped_trials.json")
PUBLIC_ALL_CSV = os.path.join(PUBLIC_DIR, "all_stopped_trials.csv")

PUBLIC_BIO_JSON = os.path.join(PUBLIC_DIR, "biological_failure_trials.json")
PUBLIC_BIO_CSV = os.path.join(PUBLIC_DIR, "biological_failure_trials.csv")

PUBLIC_META = os.path.join(PUBLIC_DIR, "dataset_meta.json")

PUBLIC_SPECIALNESS = os.path.join(PUBLIC_DIR, "specialness_index.json")


def _load_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main() -> None:
    for p in [ROOT_ALL_JSON, ROOT_BIO_JSON]:
        if not os.path.exists(p):
            raise FileNotFoundError(f"Missing {p}. Run the data pipeline first.")

    os.makedirs(PUBLIC_DIR, exist_ok=True)

    all_rows = _load_json(ROOT_ALL_JSON)
    bio_rows = _load_json(ROOT_BIO_JSON)

    def max_date(rows):
        m = ""
        for r in rows:
            d = (r.get("last_update_post_date") or "").strip()
            if d and d > m:
                m = d
        return m

    all_max = max_date(all_rows)
    bio_max = max_date(bio_rows)

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    version = all_max or generated_at

    # Top 10 disease areas (UX shortcut)
    counts = {}
    for r in all_rows:
        a = (r.get("disease_area") or "Other").strip() or "Other"
        counts[a] = counts.get(a, 0) + 1
    top_10 = sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:10]
    top_areas = [{"area": a, "count": c} for a, c in top_10]

    meta = {
        "version": version,
        "generated_at_utc": generated_at,
        "source": "ClinicalTrials.gov API v2",
        "all": {
            "record_count": len(all_rows),
            "max_last_update_post_date": all_max,
        },
        "biological_failure": {
            "record_count": len(bio_rows),
            "max_last_update_post_date": bio_max,
        },
        "top_areas": top_areas,
        "notes": "Disease areas are keyword-based mappings from conditions/MeSH terms; countries are trial site countries.",
    }

    shutil.copyfile(ROOT_ALL_JSON, PUBLIC_ALL_JSON)
    shutil.copyfile(ROOT_BIO_JSON, PUBLIC_BIO_JSON)

    if os.path.exists(ROOT_ALL_CSV):
        shutil.copyfile(ROOT_ALL_CSV, PUBLIC_ALL_CSV)
    if os.path.exists(ROOT_BIO_CSV):
        shutil.copyfile(ROOT_BIO_CSV, PUBLIC_BIO_CSV)

    with open(PUBLIC_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # Build and publish enrichment/outlier aggregates used by /outliers
    try:
        # When invoked as: python scripts/publish_public_assets.py
        from build_specialness_assets import build_specialness_index  # type: ignore
    except Exception:
        # When invoked as a module: python -m scripts.publish_public_assets
        from scripts.build_specialness_assets import build_specialness_index  # type: ignore

    specialness = build_specialness_index(all_rows)
    with open(PUBLIC_SPECIALNESS, "w", encoding="utf-8") as f:
        json.dump(specialness, f, ensure_ascii=False, indent=2)
    print(f"Wrote: {PUBLIC_SPECIALNESS}")

    print(f"Wrote: {PUBLIC_ALL_JSON}")
    print(f"Wrote: {PUBLIC_BIO_JSON}")
    if os.path.exists(ROOT_ALL_CSV):
        print(f"Wrote: {PUBLIC_ALL_CSV}")
    if os.path.exists(ROOT_BIO_CSV):
        print(f"Wrote: {PUBLIC_BIO_CSV}")
    print(f"Wrote: {PUBLIC_META}")


if __name__ == "__main__":
    main()
