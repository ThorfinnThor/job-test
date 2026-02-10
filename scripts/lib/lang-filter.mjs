import { franc } from "franc-min";

/**
 * Goal: Keep ONLY German/English jobs.
 * Practical constraints: Workday pages often contain English EEO/legal boilerplate at the end,
 * even when the actual job content is French/Portuguese/etc.
 *
 * Strategy:
 * - Hard reject non-Latin scripts (CJK/Arabic/Cyrillic) early.
 * - Strip Workday metadata + common EEO boilerplate BEFORE language detection.
 * - Classify using title + START + MIDDLE chunks (avoid END chunk).
 * - Decide by dominant evidence (majority), not "any chunk".
 */

// ---------- Stopword hints (tiny sets; used only when franc returns 'und') ----------
const EN_STOP = new Set([
  "the","and","for","with","to","of","in","on","at","from","your","you","we","our","a","an",
  "as","is","are","be","will","this","that","role","responsibilities","requirements","team",
  "experience","skills","work","job","position","candidate","apply"
]);

const DE_STOP = new Set([
  "und","der","die","das","für","mit","zu","von","im","in","auf","am","aus","wir","unser",
  "unsere","sie","ihr","eine","ein","ist","sind","werden","diese","dieser","stelle","aufgaben",
  "anforderungen","team","erfahrung","kenntnisse","bewerbung","bewerben"
]);

// Foreign-language stopwords (to reduce "und" leakage for Romance/Germanic langs)
const ES_STOP = new Set(["el","la","los","las","de","del","y","para","con","en","por","una","un","como","que","se"]);
const FR_STOP = new Set(["le","la","les","des","de","du","et","pour","avec","en","une","un","que","vous","nous"]);
const PT_STOP = new Set(["o","a","os","as","de","do","da","e","para","com","em","por","uma","um","que","você"]);
const IT_STOP = new Set(["il","lo","la","i","gli","le","di","del","e","per","con","in","un","una","che"]);
const NL_STOP = new Set(["de","het","een","en","voor","met","in","op","van","dat","je","wij","ons"]);

function normalizeSample(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNonLatinScript(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}]/u.test(
    String(text || "")
  );
}

function stopwordScore(text, stopset) {
  const s = normalizeSample(text).toLowerCase();
  if (!s) return 0;
  const words = s.split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return 0;
  let hits = 0;
  for (const w of words) if (stopset.has(w)) hits += 1;
  return hits / words.length;
}

function francLang(text, minLength = 120) {
  const sample = normalizeSample(text);
  if (!sample || sample.length < minLength) return "und";
  return franc(sample, { minLength });
}

// ---------- Remove Workday noise + EEO boilerplate ----------
function stripWorkdayNoise(raw) {
  let s = String(raw || "");

  // Remove common Workday meta lines/blocks that are not real job content.
  // Keep this fairly broad; it's mostly labels and footer-ish content.
  const metaPatterns = [
    /\bDate\s*Posted\b[\s\S]{0,200}/gi,
    /\bPosted\s*(?:Today|Yesterday|\d+\s+Days?\s+Ago)\b[\s\S]{0,120}/gi,
    /\bReq(?:uisition)?\s*ID\b[\s\S]{0,120}/gi,
    /\bJob\s*Requisition\s*ID\b[\s\S]{0,120}/gi,
    /\bTime\s*Type\b[\s\S]{0,120}/gi,
    /\bWorker\s*Type\b[\s\S]{0,120}/gi,
    /\bPrimary\s*Location\b[\s\S]{0,120}/gi,
    /\bAdditional\s*Locations\b[\s\S]{0,160}/gi,
    /\bArbeitszeit\b[\s\S]{0,120}/gi,
    /\bStandort\b[\s\S]{0,120}/gi,
    /\bVeröffentlicht\b[\s\S]{0,160}/gi,
    /\bHeute\s+ausgeschrieben\b[\s\S]{0,120}/gi,
    /\bVor\s+\d+\s+Tagen\s+ausgeschrieben\b[\s\S]{0,120}/gi
  ];
  for (const p of metaPatterns) s = s.replace(p, " ");

  // Remove common EEO/legal boilerplate chunks (English-heavy).
  // These are often appended and can cause false "English" detection.
  const eeoPatterns = [
    /equal\s+opportunity\s+employer[\s\S]{0,2500}$/i,
    /all\s+qualified\s+applicants[\s\S]{0,2500}$/i,
    /we\s+are\s+an\s+equal\s+opportunity[\s\S]{0,2500}$/i,
    /eeo\s+is\s+the\s+law[\s\S]{0,2500}$/i,
    /e-?verify[\s\S]{0,2500}$/i,
    /reasonable\s+accommodations?[\s\S]{0,2500}$/i,
    /diversity[\s\S]{0,2500}$/i
  ];
  for (const p of eeoPatterns) s = s.replace(p, " ");

  // J&J-style intro boilerplate (can also mislead—keep conservative)
  const jjIntro = [
    /Bei\s+Johnson\s*&\s*Johnson\s+glauben\s+wir[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i,
    /At\s+Johnson\s*&\s*Johnson\s+we\s+believe[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i
  ];
  for (const p of jjIntro) s = s.replace(p, " ");

  return normalizeSample(s);
}

// ---------- Sampling (avoid END chunk) ----------
function buildSamples(title, desc) {
  const t = normalizeSample(title);
  const d = stripWorkdayNoise(desc);

  const samples = [];
  if (t) samples.push({ kind: "title", text: t });

  if (!d) return samples;

  // Prefer START + MIDDLE; avoid END (often boilerplate)
  const n = d.length;
  const take = (start, len) => d.slice(Math.max(0, start), Math.min(n, start + len));

  if (n <= 900) {
    samples.push({ kind: "start", text: d });
    return samples;
  }

  samples.push({ kind: "start", text: take(0, 900) });
  samples.push({ kind: "middle", text: take(Math.floor(n / 2) - 350, 700) });

  return samples;
}

/**
 * classify: returns one of:
 * - "de_en"    : strong German/English evidence
 * - "foreign"  : strong non-German/non-English evidence
 * - "unknown"  : insufficient evidence (we prefer keeping unknown unless foreign is dominant)
 */
function classify(text) {
  const s = normalizeSample(text);
  if (!s) return "unknown";

  // Hard reject for non-latin scripts
  if (containsNonLatinScript(s)) return "foreign";

  // Stopword signals (soft)
  const en = stopwordScore(s, EN_STOP);
  const de = stopwordScore(s, DE_STOP);

  const es = stopwordScore(s, ES_STOP);
  const fr = stopwordScore(s, FR_STOP);
  const pt = stopwordScore(s, PT_STOP);
  const it = stopwordScore(s, IT_STOP);
  const nl = stopwordScore(s, NL_STOP);

  // If clear EN/DE stopwords -> DE/EN
  if (en >= 0.018 || de >= 0.018) return "de_en";

  // If clear foreign stopwords and stronger than EN/DE -> foreign
  const foreignMax = Math.max(es, fr, pt, it, nl);
  if (foreignMax >= 0.020 && foreignMax > Math.max(en, de) + 0.004) return "foreign";

  // Franc (soft, but if it confidently says non-DE/EN on a long chunk, treat as foreign)
  const lang = francLang(s, 140);
  if (lang === "deu" || lang === "eng") return "de_en";
  if (lang !== "und") {
    // Only call it foreign when we have enough text to trust it
    if (s.length >= 220) return "foreign";
    return "unknown";
  }

  return "unknown";
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";

    // Fast reject if title has non-latin scripts
    if (containsNonLatinScript(title)) {
      removed.push(job);
      continue;
    }

    const samples = buildSamples(title, desc);

    let deEn = 0;
    let foreign = 0;
    let unknown = 0;

    for (const s of samples) {
      const cls = classify(s.text);
      if (cls === "de_en") deEn += 1;
      else if (cls === "foreign") foreign += 1;
      else unknown += 1;
    }

    // Decision rules:
    // - Reject if foreign is dominant (>= deEn + 1) OR if we have clear foreign with no deEn.
    // - Keep if deEn is dominant OR if everything is unknown (avoid false negatives on technical English).
    if (foreign > 0 && deEn === 0) {
      removed.push(job);
      continue;
    }

    if (foreign >= deEn + 1) {
      removed.push(job);
      continue;
    }

    // Otherwise keep (deEn present, or unknown-only)
    kept.push(job);
  }

  return { kept, removed };
}
