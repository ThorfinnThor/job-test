import json
import os
from datetime import datetime
from typing import Dict, Any, List

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_ALL = os.path.join(ROOT, "data", "all_stopped_trials.json")
DATA_META = os.path.join(ROOT, "data", "dataset_meta.json")

OUT_DIR = os.path.join(ROOT, "web", "public", "data")


def _ensure_dir(p: str):
    os.makedirs(p, exist_ok=True)


def _read_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: str, obj: Any):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def _first_semicolon(s: str) -> str:
    if not s:
        return ""
    parts = [p.strip() for p in s.split(";") if p.strip()]
    return parts[0] if parts else ""


def _build_search_blob(r: Dict[str, Any]) -> str:
    fields = [
        r.get("nct_id", ""),
        r.get("brief_title", ""),
        r.get("lead_sponsor", ""),
        r.get("collaborators", ""),
        r.get("disease_area", ""),
        r.get("conditions", ""),
        r.get("intervention_names", ""),
        r.get("mesh_terms", ""),
        r.get("why_stopped", ""),
        r.get("overall_status", ""),
        r.get("phases", ""),
    ]
    blob = " | ".join([str(x) for x in fields if x])
    return blob.lower()


def main():
    _ensure_dir(OUT_DIR)

    trials: List[Dict[str, Any]] = _read_json(DATA_ALL)

    # meta (optional)
    meta = {}
    if os.path.exists(DATA_META):
        meta = _read_json(DATA_META)
    else:
        meta = {"version": datetime.utcnow().strftime("%Y-%m-%d"), "generated_at_utc": datetime.utcnow().isoformat() + "Z"}

    # Compact index rows (small payload)
    index_rows = []
    details_chunks: Dict[int, Dict[str, Any]] = {i: {} for i in range(10)}

    for r in trials:
        nct = r.get("nct_id", "")
        if not nct:
            continue

        why = (r.get("why_stopped") or "").strip()
        why_short = why[:220] + ("…" if len(why) > 220 else "")

        # compact row for list/grid view
        idx = {
            "nct_id": nct,
            "brief_title": r.get("brief_title", ""),
            "overall_status": r.get("overall_status", ""),
            "phases": r.get("phases", ""),
            "disease_area": r.get("disease_area", "Other") or "Other",
            "lead_sponsor": r.get("lead_sponsor", ""),
            "collaborators": r.get("collaborators", ""),
            "condition_first": _first_semicolon(r.get("conditions", "")),
            "intervention_first": _first_semicolon(r.get("intervention_names", "")),
            "why_stopped_short": why_short,
            "classification_label": r.get("classification_label", ""),
            "classification_reason": r.get("classification_reason", ""),
            "classification_confidence": r.get("classification_confidence", ""),
            "classification_evidence": r.get("classification_evidence", ""),
            "last_update_post_date": r.get("last_update_post_date", ""),
            "url": r.get("url", ""),
            "search_blob": _build_search_blob(r),
        }
        index_rows.append(idx)

        # details row (full fields) -> chunk by last digit for cheap on-demand fetch
        last_digit = int(nct[-1]) if nct[-1].isdigit() else 0
        details_chunks[last_digit][nct] = {
            "nct_id": nct,
            "brief_title": r.get("brief_title", ""),
            "why_stopped": r.get("why_stopped", ""),
            "conditions": r.get("conditions", ""),
            "intervention_names": r.get("intervention_names", ""),
            "intervention_types": r.get("intervention_types", ""),
            "mesh_terms": r.get("mesh_terms", ""),
            "disease_area": r.get("disease_area", "Other") or "Other",
            "lead_sponsor": r.get("lead_sponsor", ""),
            "collaborators": r.get("collaborators", ""),
            "overall_status": r.get("overall_status", ""),
            "phases": r.get("phases", ""),
            "last_update_post_date": r.get("last_update_post_date", ""),
            "classification_label": r.get("classification_label", ""),
            "classification_reason": r.get("classification_reason", ""),
            "classification_confidence": r.get("classification_confidence", ""),
            "classification_evidence": r.get("classification_evidence", ""),
            "url": r.get("url", ""),
        }

    # Write outputs
    _write_json(os.path.join(OUT_DIR, "meta.json"), meta)
    _write_json(os.path.join(OUT_DIR, "trials_index.json"), index_rows)
    for d in range(10):
        _write_json(os.path.join(OUT_DIR, f"trials_details_{d}.json"), details_chunks[d])

    print(f"Wrote {len(index_rows)} index rows and 10 details chunks to {OUT_DIR}")


if __name__ == "__main__":
    main()
