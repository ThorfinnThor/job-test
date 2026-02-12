#!/usr/bin/env python3
"""Build aggregate "outlier" (enrichment) assets for the web UI.

This script computes, for each:
  - group (lead sponsor OR disease area)
  - phase cohort (all, phase1..phase4)
  - stop-reason bucket (safety, efficacy/futility, operational, regulatory, other/unknown)

how unusually often the group appears in that bucket relative to the cohort baseline.

Key design constraints:
  - No third-party deps (GitHub Actions only installs requests).
  - Stable, explainable statistics: Beta prior + normal approximation.
  - Output is small (aggregates only) and suitable for static hosting.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Set, Tuple


PHASE_KEYS: List[str] = ["all", "phase1", "phase2", "phase3", "phase4"]
BUCKET_KEYS: List[str] = ["EFFICACY/FUTILITY", "SAFETY", "OPERATIONAL", "REGULATORY", "OTHER/UNKNOWN"]
SCOPE_KEYS: List[str] = ["all", "bio"]
GROUP_BY_KEYS: List[str] = ["company", "disease_area"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _as_str(x: Any) -> str:
    if x is None:
        return ""
    if isinstance(x, str):
        return x
    return str(x)


def _parse_semicolon_list(s: str) -> List[str]:
    return [t.strip().upper() for t in (s or "").split(";") if t.strip()]


def _phase_flags(phases_raw: str) -> Set[str]:
    """Map raw phase tokens to canonical cohorts.

    A trial can contribute to multiple cohorts if it spans phases.
    Examples:
      - "PHASE1; PHASE2" -> {phase1, phase2}
      - "PHASE1/PHASE2" -> {phase1, phase2}
      - "EARLY_PHASE1" -> {phase1}
    """

    tokens = _parse_semicolon_list(phases_raw)
    out: Set[str] = set()
    for t in tokens:
        if not t:
            continue
        if "PHASE1" in t or t == "EARLY_PHASE1":
            out.add("phase1")
        if "PHASE2" in t:
            out.add("phase2")
        if "PHASE3" in t:
            out.add("phase3")
        if "PHASE4" in t:
            out.add("phase4")
    return out


def _normalize_bucket(reason: str, why_short: str = "") -> str:
    """Normalize bucket to the 5-core set.

    We keep parity with filtering.ts / pharma-intelligence.tsx policy:
    - ENROLLMENT collapses into OTHER/UNKNOWN.
    """
    r = (reason or "").strip().upper()
    if not r:
        # lightweight fallback mirroring web/lib/filtering.ts
        w = (why_short or "").upper()
        if "EFFICACY" in w or "FUTILITY" in w or "INSUFFICIENT" in w:
            r = "EFFICACY/FUTILITY"
        elif "SAFETY" in w or "TOXIC" in w or "ADVERSE" in w:
            r = "SAFETY"
        elif "REGULAT" in w or "FDA" in w or "AUTHORITY" in w:
            r = "REGULATORY"
        elif "OPERATION" in w or "LOGISTIC" in w or "SUPPLY" in w:
            r = "OPERATIONAL"
        elif "ENROLL" in w or "RECRUIT" in w:
            r = "ENROLLMENT"
        else:
            r = "OTHER/UNKNOWN"

    if r == "ENROLLMENT":
        return "OTHER/UNKNOWN"
    if r in ("EFFICACY/FUTILITY", "SAFETY", "OPERATIONAL", "REGULATORY", "OTHER/UNKNOWN"):
        return r
    return "OTHER/UNKNOWN"


def _is_bio_failure(row: Mapping[str, Any]) -> bool:
    """Mirror the web isLikelyScientificFailure() heuristic."""
    label = (
        _as_str(row.get("failure_label") or row.get("classification_label") or row.get("failure_type") or "")
        .upper()
        .strip()
    )
    if "BIOLOGICAL_FAILURE" in label or "SCIENTIFIC_FAILURE" in label:
        return True

    bucket = _normalize_bucket(_as_str(row.get("classification_reason") or ""), _as_str(row.get("why_stopped") or ""))
    if bucket == "EFFICACY/FUTILITY":
        return True

    return False


def _phi(z: float) -> float:
    """Standard normal CDF."""
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _prob_beta_gt_baseline(alpha: float, beta: float, p0: float) -> float:
    """Approximate P(p > p0) for p ~ Beta(alpha,beta) using normal approx.

    We use a normal approximation to the Beta posterior for speed and determinism.
    For small n this is approximate, but the UI enforces a minimum n.
    """
    denom = alpha + beta
    if denom <= 0:
        return 0.5
    mu = alpha / denom
    var = (alpha * beta) / (denom * denom * (denom + 1.0))
    if var <= 0:
        if mu > p0:
            return 1.0
        if mu < p0:
            return 0.0
        return 0.5
    sd = math.sqrt(var)
    z = (mu - p0) / sd
    return float(_phi(z))


def _beta_mean_ci(alpha: float, beta: float, z: float = 1.645) -> Tuple[float, float, float]:
    """Return (mean, low, high) using normal approx; bounds are clipped to [0,1]."""
    denom = alpha + beta
    if denom <= 0:
        return 0.0, 0.0, 0.0
    mu = alpha / denom
    var = (alpha * beta) / (denom * denom * (denom + 1.0))
    sd = math.sqrt(max(0.0, var))
    lo = max(0.0, mu - z * sd)
    hi = min(1.0, mu + z * sd)
    return float(mu), float(lo), float(hi)


def build_specialness_index(
    rows: Iterable[Mapping[str, Any]],
    *,
    prior_a: float = 1.0,
    prior_b: float = 1.0,
) -> Dict[str, Any]:
    """Compute the specialness/enrichment index from raw trial rows."""

    # counts[scope][groupBy][phaseKey][bucketKey][groupValue] -> (n,k)
    # We store n separately and bucket hits separately, but fold into (n,k) at the end.
    n_counts: Dict[str, Dict[str, Dict[str, Dict[str, int]]]] = {
        scope: {gb: {pk: {} for pk in PHASE_KEYS} for gb in GROUP_BY_KEYS} for scope in SCOPE_KEYS
    }
    k_counts: Dict[str, Dict[str, Dict[str, Dict[str, Dict[str, int]]]]] = {
        scope: {gb: {pk: {bk: {} for bk in BUCKET_KEYS} for pk in PHASE_KEYS} for gb in GROUP_BY_KEYS}
        for scope in SCOPE_KEYS
    }

    baseline_n: Dict[str, Dict[str, int]] = {scope: {pk: 0 for pk in PHASE_KEYS} for scope in SCOPE_KEYS}
    baseline_k: Dict[str, Dict[str, Dict[str, int]]] = {
        scope: {pk: {bk: 0 for bk in BUCKET_KEYS} for pk in PHASE_KEYS} for scope in SCOPE_KEYS
    }

    def bump_map(m: MutableMapping[str, int], key: str, inc: int = 1) -> None:
        m[key] = m.get(key, 0) + inc

    for r in rows:
        phases_raw = _as_str(r.get("phases") or "")
        phase_set = _phase_flags(phases_raw)
        # Always include "all" cohort
        phase_set_with_all: Set[str] = set(phase_set)
        phase_set_with_all.add("all")

        bucket = _normalize_bucket(_as_str(r.get("classification_reason") or ""), _as_str(r.get("why_stopped") or ""))

        lead = (_as_str(r.get("lead_sponsor") or "") or "").strip() or "Unknown"
        area = (_as_str(r.get("disease_area") or "") or "").strip() or "Other"

        is_bio = _is_bio_failure(r)
        for scope in SCOPE_KEYS:
            if scope == "bio" and not is_bio:
                continue

            for pk in phase_set_with_all:
                if pk not in PHASE_KEYS:
                    continue

                baseline_n[scope][pk] += 1
                baseline_k[scope][pk][bucket] += 1

                # groupBy: company
                bump_map(n_counts[scope]["company"][pk], lead, 1)
                bump_map(k_counts[scope]["company"][pk][bucket], lead, 1)

                # groupBy: disease area
                bump_map(n_counts[scope]["disease_area"][pk], area, 1)
                bump_map(k_counts[scope]["disease_area"][pk][bucket], area, 1)

    # Build output payload (counts-first, computed metrics in UI)
    baselines: Dict[str, Dict[str, Dict[str, Any]]] = {
        scope: {pk: {bk: {} for bk in BUCKET_KEYS} for pk in PHASE_KEYS} for scope in SCOPE_KEYS
    }
    # results[scope][groupBy][phase] -> list[{group, n, k: [k_eff, k_safety, ...]}]
    results: Dict[str, Dict[str, Dict[str, List[Dict[str, Any]]]]] = {
        scope: {gb: {pk: [] for pk in PHASE_KEYS} for gb in GROUP_BY_KEYS} for scope in SCOPE_KEYS
    }

    for scope in SCOPE_KEYS:
        for pk in PHASE_KEYS:
            n_all = baseline_n[scope][pk]
            for bk in BUCKET_KEYS:
                k_all = baseline_k[scope][pk][bk]
                p0 = (k_all / n_all) if n_all > 0 else 0.0
                baselines[scope][pk][bk] = {
                    "n": int(n_all),
                    "k": int(k_all),
                    "rate": float(p0),
                }

            for gb in GROUP_BY_KEYS:
                n_map = n_counts[scope][gb][pk]
                rows_out: List[Dict[str, Any]] = []
                for g, n in n_map.items():
                    k_list = [int(k_counts[scope][gb][pk][bk].get(g, 0)) for bk in BUCKET_KEYS]
                    rows_out.append({"group": g, "n": int(n), "k": k_list})
                # Deterministic ordering (largest n first) to keep diffs stable
                rows_out.sort(key=lambda x: (-int(x.get("n") or 0), str(x.get("group") or "")))
                results[scope][gb][pk] = rows_out

    payload: Dict[str, Any] = {
        "generated_at_utc": _utc_now(),
        "prior": {"a": prior_a, "b": prior_b},
        "scopes": SCOPE_KEYS,
        "group_bys": GROUP_BY_KEYS,
        "phases": PHASE_KEYS,
        "buckets": BUCKET_KEYS,
        "baselines": baselines,
        "bucket_order": BUCKET_KEYS,
        "results": results,
        "notes": (
            "This file contains only aggregate counts (n and per-bucket k). "
            "The /outliers UI computes shrunk rates and rankings client-side using the included Beta(a,b) prior."
        ),
    }
    return payload


def main() -> None:
    root_json = os.environ.get("SPECIALNESS_SOURCE_JSON", "data/all_stopped_trials.json")
    out_path = os.environ.get("SPECIALNESS_OUT", os.path.join("web", "public", "specialness_index.json"))
    prior_a = float(os.environ.get("SPECIALNESS_PRIOR_A", "1"))
    prior_b = float(os.environ.get("SPECIALNESS_PRIOR_B", "1"))

    if not os.path.exists(root_json):
        raise FileNotFoundError(f"Missing {root_json}. Run the data pipeline first.")

    with open(root_json, "r", encoding="utf-8") as f:
        rows = json.load(f)

    payload = build_specialness_index(rows, prior_a=prior_a, prior_b=prior_b)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"Wrote: {out_path}")


if __name__ == "__main__":
    main()
