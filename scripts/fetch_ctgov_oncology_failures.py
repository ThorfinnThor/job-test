#!/usr/bin/env python3
"""Fetch ClinicalTrials.gov (API v2) studies that are SUSPENDED/TERMINATED/WITHDRAWN
and are interventional with DRUG/BIOLOGICAL interventions.

Classify whyStopped into:
- BIOLOGICAL_FAILURE (SAFETY or EFFICACY/FUTILITY)
- NON_BIOLOGICAL (OPERATIONAL)
- UNCLEAR

Assign disease areas (keyword taxonomy) and extract trial site countries.

Outputs:
- data/all_stopped_trials.csv
- data/biological_failure_trials.csv
- data/all_stopped_trials.json
- data/biological_failure_trials.json

Notes on this version:
- Expands OPERATIONAL/SAFETY/EFFICACY phrase coverage to reduce OTHER/UNKNOWN.
- Adds a safe second-pass classifier that, when whyStopped is vague or empty,
  mines briefSummary/detailedDescription for a short stop-reason snippet.
  (Schema/output columns remain unchanged; description text is NOT exported.)
"""

from __future__ import annotations

import csv
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import requests

BASE_URL = "https://clinicaltrials.gov/api/v2/studies"

MAX_STUDIES_TOTAL = int(os.getenv("MAX_STUDIES_TOTAL", "50000"))
LAST_UPDATE_FROM = os.getenv("LAST_UPDATE_FROM", "2015-01-01")
PAGE_SIZE = int(os.getenv("PAGE_SIZE", "100"))
SLEEP_SECONDS = float(os.getenv("SLEEP_SECONDS", "1.2"))
TIMEOUT = 60

OVERRIDES_PATH = os.getenv("OVERRIDES_PATH", "overrides.csv")


@dataclass(frozen=True)
class Classification:
    label: str          # BIOLOGICAL_FAILURE | NON_BIOLOGICAL | UNCLEAR
    reason: str         # SAFETY | EFFICACY/FUTILITY | OPERATIONAL | OTHER/UNKNOWN
    confidence: str     # HIGH | MEDIUM | LOW
    matched_evidence: str


def get_nested(d: Dict[str, Any], path: List[str], default=None):
    cur: Any = d
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def normalize_text(s: Optional[str]) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip().lower()


# -----------------------------
# Disease area taxonomy (primary + matched list)
# -----------------------------

DISEASE_AREA_TAXONOMY: List[Tuple[str, List[str]]] = [
    ("Oncology", [
        "cancer", "oncology", "neoplasm", "tumor", "tumour", "malign", "carcinoma", "sarcoma", "lymphoma", "leukemia",
        "myeloma", "metast", "melanoma", "glioma",
    ]),
    ("Cardiovascular", [
        "cardio", "heart", "myocard", "coronary", "atrial", "ventric", "hypertension", "ischemi",
        "thromb", "embol", "heart failure", "arrhythm", "angina",
    ]),
    ("Neurology", [
        "alzheimer", "parkinson", "multiple sclerosis", "epilep", "seizure", "migraine", "neuro", "dementia",
        "amyotrophic", "als", "neuropath",
    ]),
    ("Infectious Disease", [
        "infection", "infectious", "virus", "viral", "bacterial", "fungal", "hiv", "aids", "hepatitis", "influenza",
        "covid", "sars", "tuberc", "malaria", "pneumonia", "sepsis",
    ]),
    ("Immunology & Autoimmune", [
        "autoimmune", "lupus", "rheumatoid", "arthritis", "psoriasis", "crohn", "ulcerative colitis", "ibd",
        "inflamm", "immun", "ankylosing", "vasculitis",
    ]),
    ("Endocrine & Metabolic", [
        "diabetes", "obesity", "metabolic", "thyroid", "insulin", "dyslip", "cholesterol",
        "hyperlip", "metabolic syndrome",
    ]),
    ("Psychiatry & Mental Health", [
        "depress", "bipolar", "schiz", "anxiety", "ptsd", "autism", "adhd", "mental", "psychiatr", "substance use",
        "addiction",
    ]),
    ("Respiratory", [
        "asthma", "copd", "pulmonary", "lung", "respiratory", "bronch", "pneumon", "fibrosis",
    ]),
    ("Gastroenterology & Hepatology", [
        "gastro", "hepatic", "hepat", "liver", "cirrhos", "pancrea", "colitis", "crohn", "ulcer", "intestinal",
        "bowel", "nash", "nafld",
    ]),
    ("Renal & Urology", [
        "renal", "kidney", "nephro", "urology", "bladder", "prostate", "urinary",
    ]),
    ("Dermatology", [
        "dermat", "skin", "eczema", "atopic", "psoriasis", "acne",
    ]),
    ("Ophthalmology", [
        "ocular", "eye", "retina", "macular", "glaucoma", "ophthalm",
    ]),
    ("Hematology (non-onc)", [
        "hemoph", "sickle", "thalassem", "anemia", "anaemia", "hematolog", "haematolog",
    ]),
    ("Musculoskeletal", [
        "osteo", "bone", "fracture", "muscle", "tendon", "ligament", "orthopedic", "orthopaedic",
    ]),
]


def assign_disease_areas(conditions: List[str], mesh_terms: List[str]) -> Tuple[str, str]:
    text = normalize_text(" ; ".join(conditions + mesh_terms))
    if not text:
        return "Other", ""

    scores: Dict[str, int] = {}
    matched: Set[str] = set()

    for area, kws in DISEASE_AREA_TAXONOMY:
        score = 0
        for kw in kws:
            if kw in text:
                score += 1
        if score > 0:
            scores[area] = score
            matched.add(area)

    if not scores:
        return "Other", ""

    primary = sorted(scores.items(), key=lambda x: (-x[1], x[0]))[0][0]
    return primary, "; ".join(sorted(matched))


# -----------------------------
# whyStopped classification (rule-based + safe 2nd-pass snippet mining)
# -----------------------------

SAFETY_TERMS = [
    "safety", "safety concern", "safety concerns",
    "safety issue", "safety issues",
    "safety reasons",
    "adverse event", "adverse events",
    "adverse effect", "adverse effects",
    "serious adverse",
    "sae", "saes",
    "toxicity", "toxic",
    "unacceptable toxicity",
    "dose limiting", "dose-limiting", "dose limiting toxicity", "dlt", "dlts",
    "intolerable",
    "unacceptable risk",
    "risk/benefit", "risk benefit", "risk-benefit",
    "safety profile",
    # Regulatory / monitoring committee signals
    "clinical hold", "fda clinical hold", "regulatory hold",
    "dsmb", "data safety monitoring board",
    "dmc", "data monitoring committee",
]

EFFICACY_TERMS = [
    "efficacy concern", "efficacy concerns",
    "lack of efficacy",
    "insufficient efficacy",
    "no efficacy",
    "ineffective",
    "no benefit",
    "no signal of activity",
    "no signal of efficacy",
    "no activity",
    "unmet primary endpoint",
    "unmet endpoint",
    "failed to meet",
    "did not meet",
    "primary endpoint",
    "endpoint not met",
    "end point not met",
    "end-point not met",
    "futility",
    "futile",
    "futility analysis",
    "interim analysis",
    "stopping for futility",
    # Common phrases
    "lack of response",
    "no response",
    "no clinical benefit",
    "no meaningful benefit",
]

# Operational/admin reasons are the #1 driver of OTHER/UNKNOWN if not covered well.
OPERATIONAL_TERMS = [
    "recruit", "recruitment", "enrollment", "enrolment", "accrual",
    "insufficient accrual", "slow accrual", "low accrual", "poor accrual",
    "unable to enroll", "unable to enrol",
    "no participants enrolled", "no patients enrolled", "no subjects enrolled",
    "not enough participants", "insufficient enrollment", "insufficient enrolment",

    "funding", "budget", "financial",
    "lack of funds", "insufficient funds", "not funded", "lack of resources",

    "administrative", "logistical", "site closure", "site closed", "site closures", "staffing",
    "regulatory delay", "protocol deviation",

    "sponsor decision", "sponsor's decision", "sponsors decision",
    "sponsor request", "per sponsor request", "at sponsor request",
    "terminated by sponsor", "sponsor withdrew support", "withdrew support",
    "sponsor-initiated", "sponsor initiated",

    "company decision", "business decision", "business reasons", "corporate decision",
    "strategic decision", "strategic reasons",
    "prioritisation", "prioritization",
    "portfolio", "commercial reasons",

    "external environment", "changes in the external environment",
    "development halted", "development has been halted", "programme halted", "program halted",
    "no longer pursuing",
    "competitive landscape", "competitive", "market dynamics", "market",

    "covid", "pandemic",

    # Common CT.gov operational phrasing
    "investigator decision", "investigator request",
    "pi decision", "pi request", "pi left", "pi left institution",
    "principal investigator left", "investigator left",

    "study never started", "never started", "never initiated", "not initiated",

    "drug supply", "drug supply issues", "supply issues", "manufacturing issues",
    "contract issues", "agreement issues",

    "feasibility", "feasibility issues", "not feasible",
]


REGULATORY_TERMS = [
    # Regulators / agencies (explicit)
    "fda", "food and drug administration",
    "ema", "european medicines agency",
    "mhra", "medicines and healthcare products regulatory agency",
    "health canada",
    "tga", "therapeutic goods administration",
    "anvisa",
    "pmda",
    "nmpa",
    "competent authority",
    "health authority",
    "regulatory authority", "regulatory authorities",
    "regulator", "regulatory",

    # Explicit regulatory actions / artifacts
    "clinical hold", "fda clinical hold", "regulatory hold",
    "inspection", "gcp", "good clinical practice",
    "audit", "audit findings",
    "non-compliance", "noncompliance",
    "warning letter",
    "approval not obtained", "not approved by", "not approved",
    "regulatory approval",
]

# "Anchors" are the only tokens that can unlock the REGULATORY bucket.
# This prevents vague language like "on hold" / "unable to open" from being mislabeled as regulatory.
#
# IMPORTANT (user requirement):
#   - REGULATORY should only fire for explicit FDA/EMA/authority/clinical-hold style reasons.
#   - The mere presence of the word "regulatory" is NOT sufficient.
REGULATORY_ANCHOR_PAT = re.compile(
    r"\b("
    # Named regulators / agencies
    r"fda|food and drug administration|ema|european medicines agency|mhra|health canada|"
    r"therapeutic goods administration|\btga\b|anvisa|pmda|nmpa|"
    # Explicit authority phrases
    r"regulatory authority|regulatory authorities|health authority|health authorities|competent authority|"
    r"regulatory agency|regulatory agencies|regulator|regulators|"
    # Explicit regulatory actions
    r"clinical hold|fda clinical hold|regulatory hold|"
    # Explicit request/mandate phrases (anchor without relying on bare 'regulatory')
    r"regulatory request|regulatory requests"
    r")\b"
)

# Hard block: deny REGULATORY when the text explicitly states the stop was NOT regulatory.
REGULATORY_NEGATION_PATTERNS = [
    r"\bnot\s+due\s+to\b.{0,120}\bregulat",                 # not due to ... regulat*
    r"\bnot\s+because\s+of\b.{0,120}\bregulat",
    r"\bno\s+request(?:s)?\s+from\b.{0,120}\bregulat",      # no requests from ... regulat*
    r"\bnot\s+requested\s+by\b.{0,120}\bregulat",
    r"\bwithout\b.{0,120}\bregulat",
    r"\bno\b.{0,60}\bregulatory\b.{0,60}\brequest",         # no regulatory request
    r"\bno\b.{0,60}\brequest\b.{0,60}\bregulatory",         # no request ... regulatory
    r"\bno\b.{0,60}\bregulatory\b.{0,60}\bconcern",         # no regulatory concern
    r"\bno\b.{0,60}\bregulatory\b.{0,60}\bissue",           # no regulatory issue
]

# Positive-causality cues. We only assign REGULATORY if there is an explicit anchor AND
# at least one of these cues is present (prevents generic mentions like "regulatory developments").
REGULATORY_POSITIVE_CUES = [
    "due to", "because of", "at the request of", "requested by", "required by",
    "per fda", "per ema", "based on fda", "based on ema", "fda feedback", "ema feedback",
    "following fda", "following ema", "as requested by",
    "clinical hold", "fda clinical hold", "regulatory hold", "placed on hold by",
    "approval not obtained", "not approved by", "not approved", "regulatory approval",
    "inspection", "audit", "gcp", "non-compliance", "warning letter",
    "ind", "cta",
    "regulatory request", "regulatory requests",
]

def _is_regulatory_negated(txt: str) -> bool:
    if not txt:
        return False
    for p in REGULATORY_NEGATION_PATTERNS:
        if re.search(p, txt, flags=re.IGNORECASE | re.DOTALL):
            return True
    return False

def _has_positive_regulatory_cue(txt: str) -> bool:
    if not txt:
        return False
    t = txt.lower()
    return any(cue in t for cue in REGULATORY_POSITIVE_CUES)

REGULATORY_WEIGHTS: Dict[str, int] = {
    # Agencies / explicit regulators
    "fda": 5,
    "food and drug administration": 5,
    "ema": 5,
    "european medicines agency": 5,
    "mhra": 5,
    "health canada": 5,
    "tga": 4,
    "therapeutic goods administration": 5,
    "anvisa": 5,
    "pmda": 5,
    "nmpa": 5,
    "competent authority": 4,
    "health authority": 4,
    "regulatory authority": 4,
    "regulatory authorities": 4,
    "regulator": 3,
    "regulatory": 2,

    # Actions / outcomes
    "clinical hold": 5,
    "fda clinical hold": 6,
    "regulatory hold": 5,
    "warning letter": 5,
    "inspection": 4,
    "audit": 3,
    "audit findings": 4,
    "gcp": 4,
    "good clinical practice": 4,
    "non-compliance": 4,
    "noncompliance": 4,
    "approval not obtained": 4,
    "not approved by": 4,
    "not approved": 3,
    "regulatory approval": 4,
}


EFFICACY_WEIGHTS: Dict[str, int] = {
    "efficacy concerns": 2,
    "efficacy concern": 2,
    "lack of efficacy": 3,
    "insufficient efficacy": 3,
    "no efficacy": 3,
    "ineffective": 2,
    "no benefit": 2,
    "no clinical benefit": 3,
    "no meaningful benefit": 3,
    "lack of response": 2,
    "no response": 2,
    "unmet primary endpoint": 3,
    "unmet endpoint": 2,
    "endpoint not met": 3,
    "did not meet": 3,
    "failed to meet": 3,
    "futility": 3,
    "futility analysis": 3,
    "stopping for futility": 3,
    "interim analysis": 2,  # raise so "interim analysis" alone can contribute
    "no signal of activity": 3,
    "no signal of efficacy": 3,
    "no activity": 2,
}

SAFETY_WEIGHTS: Dict[str, int] = {
    "safety concerns": 2,
    "safety concern": 2,
    "safety issues": 2,
    "safety issue": 2,
    "safety reasons": 3,
    "adverse event": 2,
    "adverse events": 2,
    "serious adverse": 3,
    "toxicity": 2,
    "unacceptable toxicity": 3,
    "unacceptable risk": 3,
    "risk/benefit": 2,
    "risk benefit": 2,
    "risk-benefit": 2,
    "safety profile": 2,
    "clinical hold": 3,
    "fda clinical hold": 3,
    "regulatory hold": 2,
    "dsmb": 2,
    "data safety monitoring board": 3,
    "dmc": 2,
    "data monitoring committee": 3,
}

CAUSAL_CUES = [
    r"\bdue to\b", r"\bbecause of\b", r"\bsecondary to\b", r"\bas a result of\b",
    r"\bresulting from\b", r"\bprompted by\b", r"\bdriven by\b", r"\brelated to\b",
]

NEGATION_CUES = [
    # Generic negation tokens
    "no ", "not ", "without ", "none ", "neither ", "nor ",

    # Contractions (critical for CT.gov prose, e.g., "wasn't due to")
    "n't ",

    # Common causal-negation phrases
    "not due to", "not because of", "not prompted by", "not related to",
    "unrelated to", "not caused by", "not attributable to",

    # Contraction variants of the above
    "n't due to", "n't because of", "n't prompted by", "n't related to",

    # Other frequent negations
    "cannot ", "can't ", "won't ", "didn't ", "doesn't ", "don't ",
    "isn't ", "aren't ", "wasn't ", "weren't ",
]

NO_BENEFIT_RISK_IMPACT_PATTERNS = [
    "no benefit-risk impact",
    "no benefit risk impact",
    "no impact on benefit-risk",
    "no impact on benefit risk",
    "no impact to benefit-risk",
    "no impact to benefit risk",
]

NON_SAFETY_PATTERNS = ["non-safety", "non safety", "non–safety", "nonsafety"]
NON_EFFICACY_PATTERNS = ["non-efficacy", "non efficacy", "non–efficacy", "nonefficacy"]

# If whyStopped is generic/placeholder, try mining a snippet from descriptions.
GENERIC_WHY_STOPPED_PATTERNS = [
    "see detailed description",
    "see the detailed description",
    "see study description",
    "see description",
    "see details",
    "reason described",
    "refer to",
]

STOP_SNIPPET_CUES = [
    "terminated", "withdrawn", "suspended",
    "stopped", "halted", "discontinued",
    "clinical hold",
]


def request_with_retries(session: requests.Session, url: str, params: Dict[str, Any]) -> Dict[str, Any]:
    backoff = 2.0
    for _ in range(1, 7):
        resp = session.get(url, params=params, timeout=TIMEOUT)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (429, 500, 502, 503, 504):
            time.sleep(backoff)
            backoff = min(backoff * 2.0, 60.0)
            continue
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
    raise RuntimeError("Exceeded retries due to repeated throttling or server errors.")


def iter_all_studies(session: requests.Session) -> Iterable[Dict[str, Any]]:
    params: Dict[str, Any] = {
        "filter.overallStatus": "TERMINATED,SUSPENDED,WITHDRAWN",
        "query.term": f"AREA[LastUpdatePostDate]RANGE[{LAST_UPDATE_FROM},MAX]",
        "sort": "LastUpdatePostDate:desc",
        "pageSize": str(PAGE_SIZE),
        "format": "json",
        "countTotal": "true",
    }

    page_token: Optional[str] = None
    while True:
        if page_token:
            params["pageToken"] = page_token
        else:
            params.pop("pageToken", None)

        data = request_with_retries(session, BASE_URL, params)
        for st in data.get("studies", []):
            yield st

        page_token = data.get("nextPageToken")
        if not page_token:
            break
        time.sleep(SLEEP_SECONDS)


def _clause_start(text: str, idx: int) -> int:
    last_dot = text.rfind(".", 0, idx)
    last_semi = text.rfind(";", 0, idx)
    last_colon = text.rfind(":", 0, idx)
    start = max(last_dot, last_semi, last_colon)
    return 0 if start == -1 else start + 1


def _negated_near(text: str, idx: int, window: int = 50) -> bool:
    clause_start = _clause_start(text, idx)
    start = max(clause_start, idx - window)
    context = text[start:idx]
    return any(cue in context for cue in NEGATION_CUES)


def _term_positions(text: str, term: str) -> List[int]:
    positions = []
    start = 0
    while True:
        i = text.find(term, start)
        if i == -1:
            break
        positions.append(i)
        start = i + len(term)
    return positions


def _has_unnegated_term(text: str, term: str) -> bool:
    for idx in _term_positions(text, term):
        if not _negated_near(text, idx):
            return True
    return False


def _find_terms(text: str, terms: List[str]) -> List[str]:
    return [t for t in terms if t in text]


def _contains_any(text: str, patterns: List[str]) -> bool:
    return any(p in text for p in patterns)


def _protect_no_benefit_risk_impact(text: str) -> str:
    out = text
    for p in NO_BENEFIT_RISK_IMPACT_PATTERNS:
        out = out.replace(p, "no_benefit_risk_impact")
    return out


def _protect_non_safety_efficacy(text: str) -> str:
    out = text
    for p in NON_SAFETY_PATTERNS:
        out = out.replace(p, "non_safety")
    for p in NON_EFFICACY_PATTERNS:
        out = out.replace(p, "non_efficacy")
    return out


def _explicit_denial_flags(text_raw: str) -> Tuple[bool, bool]:
    clauses = [c.strip() for c in re.split(r"[.;:]", text_raw) if c.strip()]
    denies_safety = False
    denies_efficacy = False

    for clause in clauses:
        if _contains_any(clause, NON_SAFETY_PATTERNS):
            denies_safety = True
        if _contains_any(clause, NON_EFFICACY_PATTERNS):
            denies_efficacy = True

        if _contains_any(clause, NO_BENEFIT_RISK_IMPACT_PATTERNS):
            denies_safety = True
            denies_efficacy = True

        if "safety" in clause or "risk benefit" in clause or "risk/benefit" in clause or "risk-benefit" in clause:
            # Capture both explicit negations ("not due to") and contractions ("wasn't due to").
            if (("no " in clause and ("concern" in clause or "signal" in clause)) or
                ("without" in clause and "concern" in clause) or
                ("not due to" in clause) or ("n't due to" in clause) or
                ("not because of" in clause) or ("n't because of" in clause) or
                ("not prompted by" in clause) or ("n't prompted by" in clause) or
                ("not related to" in clause) or ("n't related to" in clause) or
                ("unrelated to" in clause)):
                denies_safety = True
            if ("unchanged" in clause or "remained unchanged" in clause or "no change" in clause):
                denies_safety = True

        if "efficacy" in clause or "endpoint" in clause:
            if (("no " in clause and ("concern" in clause or "signal" in clause)) or
                ("without" in clause and "concern" in clause) or
                ("not due to" in clause) or ("n't due to" in clause) or
                ("not because of" in clause) or ("n't because of" in clause) or
                ("not prompted by" in clause) or ("n't prompted by" in clause) or
                ("not related to" in clause) or ("n't related to" in clause) or
                ("unrelated to" in clause)):
                denies_efficacy = True

    return denies_safety, denies_efficacy


def _causal_near(text: str, idx: int, window: int = 90) -> bool:
    clause_start = _clause_start(text, idx)
    start = max(clause_start, idx - window)
    end = min(len(text), idx + window)
    context = text[start:end]

    for cue_pat in CAUSAL_CUES:
        m = re.search(cue_pat, context)
        if not m:
            continue
        cue_start_global = start + m.start()
        if _negated_near(text, cue_start_global, window=25):
            continue
        return True
    return False


def _score_dimension(
    text: str,
    terms: List[str],
    denies_dim: bool,
    dim_name: str,
    weights: Dict[str, int],
) -> Tuple[int, List[str]]:
    score = 0
    evidence: List[str] = []

    if denies_dim:
        score -= 3
        evidence.append(f"{dim_name}:explicit_denial")

    for t in terms:
        if t not in text:
            continue
        weight = weights.get(t, 1)
        for idx in _term_positions(text, t):
            if _negated_near(text, idx):
                continue
            score += weight
            evidence.append(f"{dim_name}:term:{t}(w={weight})")
            if _causal_near(text, idx):
                score += 2
                evidence.append(f"{dim_name}:causal_near:{t}")

    if dim_name == "eff":
        if "primary endpoint" in text and ("not met" in text or "failed" in text or "did not meet" in text):
            if not denies_dim:
                score += 3
                evidence.append("eff:endpoint_not_met_phrase")

        if "futility" in text and not denies_dim and _has_unnegated_term(text, "futility"):
            score += 3
            evidence.append("eff:futility_phrase")

    return score, evidence


def classify_why_stopped(why_stopped: Optional[str]) -> Classification:
    txt_raw = normalize_text(why_stopped)
    if not txt_raw:
        return Classification("UNCLEAR", "OTHER/UNKNOWN", "LOW", "")

    denies_safety, denies_efficacy = _explicit_denial_flags(txt_raw)

    txt = _protect_no_benefit_risk_impact(txt_raw)
    txt = _protect_non_safety_efficacy(txt)

    operational_hits = _find_terms(txt, OPERATIONAL_TERMS)
    operational_present = len(operational_hits) > 0

    # Special: operational explicitly stated as "non-safety" while operational reasons present.
    if _contains_any(txt_raw, NON_SAFETY_PATTERNS) and operational_present:
        return Classification(
            "NON_BIOLOGICAL",
            "OPERATIONAL",
            "HIGH",
            "special:non_safety_reason;operational:" + "|".join(operational_hits)
        )

    safety_score, safety_ev = _score_dimension(txt, SAFETY_TERMS, denies_safety, "saf", SAFETY_WEIGHTS)
    efficacy_score, efficacy_ev = _score_dimension(txt, EFFICACY_TERMS, denies_efficacy, "eff", EFFICACY_WEIGHTS)

    # REGULATORY scoring is *gated* by explicit anchors (FDA/EMA/authority/clinical hold/regulatory hold/etc).
    # This prevents conceptual overlap with OPERATIONAL (e.g., recruitment difficulty) unless it is truly regulatory.
    reg_score = 0
    reg_ev: List[str] = []
    if REGULATORY_ANCHOR_PAT.search(txt):
        # Guardrails:
        #   - Do NOT assign REGULATORY if the text explicitly negates a regulatory cause.
        #   - Require a positive causal cue (e.g., "at the request of", "based on FDA feedback", "clinical hold").
        if _is_regulatory_negated(txt) or (not _has_positive_regulatory_cue(txt)):
            reg_score = 0
            reg_ev = []
        else:
            reg_score, reg_ev = _score_dimension(txt, REGULATORY_TERMS, False, "reg", REGULATORY_WEIGHTS)

            # If the text also contains operational/admin language, bias towards OPERATIONAL unless regulatory is strong.
            if operational_present:
                reg_score -= 1  # bias towards OPERATIONAL when both are present

    # Keep your existing "no benefit-risk impact" handling (operational, not biological).
    if _contains_any(txt_raw, NO_BENEFIT_RISK_IMPACT_PATTERNS) and operational_present:
        return Classification(
            "NON_BIOLOGICAL",
            "OPERATIONAL",
            "HIGH",
            "special:no_benefit_risk_impact;operational:" + "|".join(operational_hits)
        )

    # If operational is present, slightly reduce bio scores (same as before).
    if operational_present:
        safety_score -= 1
        efficacy_score -= 1

    best_dim = "SAFETY" if safety_score >= efficacy_score else "EFFICACY/FUTILITY"
    best_score = max(safety_score, efficacy_score)
    best_ev = safety_ev if best_dim == "SAFETY" else efficacy_ev

    # Operational + explicit denials => operational (same as before).
    if operational_present and denies_safety and denies_efficacy:
        return Classification("NON_BIOLOGICAL", "OPERATIONAL", "HIGH", "operational:" + "|".join(operational_hits) + ";denial:both")

    # --- BIOLOGICAL FAILURE (unchanged thresholds) ---
    if best_score >= 6:
        return Classification("BIOLOGICAL_FAILURE", best_dim, "HIGH", f"score={best_score};" + ",".join(best_ev[:14]))

    if best_score >= 2 and not operational_present:
        return Classification("BIOLOGICAL_FAILURE", best_dim, "MEDIUM", f"score={best_score};" + ",".join(best_ev[:14]))

    # --- REGULATORY (strict, non-overlapping) ---
    # Only classify as REGULATORY when there is explicit regulatory evidence AND
    # there is no meaningful safety/efficacy signal.
    #
    # Additionally, when OPERATIONAL terms are present, require a stronger regulatory score to avoid overlaps.
    if best_score < 2 and reg_score > 0:
        if (not operational_present and reg_score >= 4):
            conf = "HIGH" if reg_score >= 6 else "MEDIUM"
            return Classification("NON_BIOLOGICAL", "REGULATORY", conf, f"score={reg_score};" + ",".join(reg_ev[:14]))
        if (operational_present and reg_score >= 6):
            # Strong explicit regulatory signal can override operational.
            return Classification("NON_BIOLOGICAL", "REGULATORY", "HIGH", f"score={reg_score};" + ",".join(reg_ev[:14]))

    # --- OPERATIONAL (unchanged) ---
    if operational_present:
        return Classification("NON_BIOLOGICAL", "OPERATIONAL", "HIGH", "operational:" + "|".join(operational_hits))

    return Classification("UNCLEAR", "OTHER/UNKNOWN", "LOW", f"safety_score={safety_score};efficacy_score={efficacy_score};reg_score={reg_score}")


def _looks_generic_why_stopped(text: str) -> bool:
    t = normalize_text(text)
    if not t:
        return True
    return _contains_any(t, GENERIC_WHY_STOPPED_PATTERNS)


def extract_stop_snippet(text: str, window: int = 360) -> str:
    """Extract a short chunk around the first stop-related cue in description text.

    This avoids feeding full background description into the classifier.
    """
    t = normalize_text(text)
    if not t:
        return ""

    idxs = [t.find(cue) for cue in STOP_SNIPPET_CUES if t.find(cue) != -1]
    if not idxs:
        return ""

    i = min(idxs)
    start = max(0, i - window // 2)
    end = min(len(t), i + window // 2)
    return t[start:end].strip()


def classify_with_description_fallback(
    why_stopped: Optional[str],
    brief_summary: Optional[str],
    detailed_description: Optional[str],
) -> Classification:
    """Two-pass classification:

    1) Run the rule-based classifier on whyStopped.
    2) If UNCLEAR (or whyStopped is generic), attempt to mine a snippet from
       briefSummary/detailedDescription and re-classify on (whyStopped + snippet).

    Output schema remains unchanged; evidence is annotated when fallback is used.
    """
    base = classify_why_stopped(why_stopped)

    # Only attempt fallback when base is UNCLEAR or the provided whyStopped is generic/placeholder.
    if base.label != "UNCLEAR" and not _looks_generic_why_stopped(why_stopped or ""):
        return base

    snippet = extract_stop_snippet(detailed_description or "") or extract_stop_snippet(brief_summary or "")
    if not snippet:
        return base

    combined = (why_stopped or "") + " " + snippet
    alt = classify_why_stopped(combined)

    # Accept only if it improves classification from UNCLEAR -> something else,
    # or improves confidence.
    conf_rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    if alt.label == "UNCLEAR":
        return base

    if base.label == "UNCLEAR" or conf_rank.get(alt.confidence, 0) > conf_rank.get(base.confidence, 0):
        return Classification(
            alt.label,
            alt.reason,
            alt.confidence,
            ("augmented_from_description;" + alt.matched_evidence)[:2000],
        )

    return base


def load_overrides(path: str) -> Dict[str, Classification]:
    overrides: Dict[str, Classification] = {}
    if not os.path.exists(path):
        return overrides

    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            nct = (row.get("nct_id") or "").strip()
            if not nct:
                continue
            label = (row.get("override_label") or "").strip() or "UNCLEAR"
            reason = (row.get("override_reason") or "").strip() or "OTHER/UNKNOWN"
            conf = (row.get("override_confidence") or "").strip() or "LOW"
            notes = (row.get("notes") or "").strip()
            overrides[nct] = Classification(label, reason, conf, f"override:{notes}")
    return overrides


def extract_mesh_terms(protocol: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    cb = protocol.get("conditionBrowseModule") or {}
    meshes = cb.get("meshes") or []
    if isinstance(meshes, list):
        for m in meshes:
            if isinstance(m, dict) and m.get("term"):
                out.append(str(m["term"]))
    return out


def extract_countries(protocol: Dict[str, Any]) -> List[str]:
    """Extract trial site countries from contactsLocationsModule.locations[].locationCountry"""
    out: Set[str] = set()
    cl = protocol.get("contactsLocationsModule") or {}
    locs = cl.get("locations") or []
    if isinstance(locs, list):
        for loc in locs:
            if isinstance(loc, dict):
                c = loc.get("locationCountry")
                if c and isinstance(c, str):
                    out.add(c.strip())
    return sorted(out)


def extract_record(study: Dict[str, Any]) -> Dict[str, Any]:
    protocol = study.get("protocolSection", {}) or {}

    nct_id = get_nested(protocol, ["identificationModule", "nctId"], "")
    brief_title = get_nested(protocol, ["identificationModule", "briefTitle"], "") \
        or get_nested(protocol, ["identificationModule", "officialTitle"], "")

    overall_status = get_nested(protocol, ["statusModule", "overallStatus"], "")
    why_stopped = get_nested(protocol, ["statusModule", "whyStopped"], "")

    # Description fields are often where CT.gov hides the real stop reason
    # when whyStopped is generic (e.g., "see detailed description").
    brief_summary = get_nested(protocol, ["descriptionModule", "briefSummary"], "")
    detailed_description = get_nested(protocol, ["descriptionModule", "detailedDescription"], "")

    conditions = get_nested(protocol, ["conditionsModule", "conditions"], []) or []
    if not isinstance(conditions, list):
        conditions = []

    mesh_terms = extract_mesh_terms(protocol)
    countries = extract_countries(protocol)

    sponsor = get_nested(protocol, ["sponsorCollaboratorsModule", "leadSponsor", "name"], "")
    collaborators = get_nested(protocol, ["sponsorCollaboratorsModule", "collaborators"], []) or []
    collaborator_names: List[str] = []
    if isinstance(collaborators, list):
        for c in collaborators:
            if isinstance(c, dict) and c.get("name"):
                collaborator_names.append(c["name"])

    study_type = get_nested(protocol, ["designModule", "studyType"], "")

    phases = get_nested(protocol, ["designModule", "phases"], []) or []
    if not isinstance(phases, list):
        phases = [phases] if phases else []

    interventions = get_nested(protocol, ["armsInterventionsModule", "interventions"], []) or []
    if not isinstance(interventions, list):
        interventions = []

    intervention_names: List[str] = []
    intervention_types: List[str] = []
    for intr in interventions:
        if not isinstance(intr, dict):
            continue
        name = intr.get("name")
        itype = intr.get("type")
        if name:
            intervention_names.append(str(name))
        if itype:
            intervention_types.append(str(itype))

    start_date = get_nested(protocol, ["statusModule", "startDateStruct", "date"], "")
    completion_date = get_nested(protocol, ["statusModule", "completionDateStruct", "date"], "")
    primary_completion_date = get_nested(protocol, ["statusModule", "primaryCompletionDateStruct", "date"], "")
    last_update = get_nested(protocol, ["statusModule", "lastUpdatePostDateStruct", "date"], "")

    url = f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else ""

    cls = classify_with_description_fallback(why_stopped, brief_summary, detailed_description)
    primary_area, matched_areas = assign_disease_areas(
        [str(c) for c in conditions if c],
        [str(m) for m in mesh_terms if m],
    )

    return {
        "nct_id": nct_id,
        "brief_title": brief_title,
        "overall_status": overall_status,
        "why_stopped": why_stopped,

        "classification_label": cls.label,
        "classification_reason": cls.reason,
        "classification_confidence": cls.confidence,
        "classification_evidence": cls.matched_evidence,

        "disease_area": primary_area,
        "disease_areas_matched": matched_areas,
        "mesh_terms": "; ".join(mesh_terms),

        "countries": "; ".join(countries),

        "study_type": study_type,
        "phases": "; ".join([p for p in phases if p]),
        "lead_sponsor": sponsor,
        "collaborators": "; ".join(collaborator_names),
        "conditions": "; ".join([c for c in conditions if c]),
        "intervention_names": "; ".join([n for n in intervention_names if n]),
        "intervention_types": "; ".join([t for t in intervention_types if t]),
        "start_date": start_date,
        "primary_completion_date": primary_completion_date,
        "completion_date": completion_date,
        "last_update_post_date": last_update,
        "url": url,
    }


def is_drug_or_biologic(record: Dict[str, Any]) -> bool:
    types = normalize_text(record.get("intervention_types"))
    return ("drug" in types) or ("biological" in types)


def is_interventional(record: Dict[str, Any]) -> bool:
    return normalize_text(record.get("study_type")) == "interventional"


def write_csv(path: str, rows: List[Dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not rows:
        with open(path, "w", newline="", encoding="utf-8") as f:
            f.write("")
        return
    fieldnames = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def write_json(path: str, rows: List[Dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def compute_top_areas(rows: List[Dict[str, Any]], top_n: int = 10) -> List[Dict[str, Any]]:
    counts: Dict[str, int] = {}
    for r in rows:
        area = (r.get("disease_area") or "Other").strip() or "Other"
        counts[area] = counts.get(area, 0) + 1
    top = sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:top_n]
    return [{"area": a, "count": c} for a, c in top]


def main() -> None:
    overrides = load_overrides(OVERRIDES_PATH)

    session = requests.Session()
    seen: Set[str] = set()
    all_records: List[Dict[str, Any]] = []

    for study in iter_all_studies(session):
        record = extract_record(study)
        nct = record.get("nct_id") or ""
        if not nct or nct in seen:
            continue
        seen.add(nct)

        if not is_interventional(record):
            continue
        if not is_drug_or_biologic(record):
            continue

        if nct in overrides:
            ov = overrides[nct]
            record["classification_label"] = ov.label
            record["classification_reason"] = ov.reason
            record["classification_confidence"] = ov.confidence
            record["classification_evidence"] = ov.matched_evidence

        all_records.append(record)
        if MAX_STUDIES_TOTAL > 0 and len(all_records) >= MAX_STUDIES_TOTAL:
            break

    all_records.sort(key=lambda r: r.get("last_update_post_date") or "", reverse=True)

    biological_only = [
        r for r in all_records
        if r.get("classification_label") == "BIOLOGICAL_FAILURE"
        and r.get("classification_confidence") in ("HIGH", "MEDIUM")
    ]

    write_csv("data/all_stopped_trials.csv", all_records)
    write_csv("data/biological_failure_trials.csv", biological_only)
    write_json("data/all_stopped_trials.json", all_records)
    write_json("data/biological_failure_trials.json", biological_only)

    top_10 = compute_top_areas(all_records, top_n=10)
    print("Top 10 disease areas:")
    for t in top_10:
        print(f"  {t['area']}: {t['count']}")

    print(f"Total records (all stopped): {len(all_records)}")
    print(f"Biological failures (HIGH/MEDIUM): {len(biological_only)}")


if __name__ == "__main__":
    main()
