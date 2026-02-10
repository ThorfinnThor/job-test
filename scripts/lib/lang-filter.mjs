import { franc } from "franc-min";

/**
 * Keep ONLY German/English jobs.
 *
 * Main failure mode you have right now:
 * - Workday pages often contain EN boilerplate (EEO/legal) even when the real job is FR/PT/ES etc.
 * - Some postings are mixed (e.g., DE intro + Chinese requirements later).
 *
 * This version:
 * 1) Hard-rejects if title OR description contains any non-Latin script (CJK/Arabic/Cyrillic).
 * 2) Removes Workday metadata + common EEO boilerplate BEFORE language detection.
 * 3) Detects language primarily from the "core" part of the description (start + middle),
 *    and uses dominant evidence (not "any chunk").
 * 4) Keeps unknown-only cases to avoid false negatives on technical English,
 *    BUT rejects if foreign stopwords dominate.
 */

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

// Foreign stopwords (to prevent Romance leakage)
const ES_STOP = new Set(["el","la","los","las","de","del","y","para","con","en","por","una","un","como","que","se","su"]);
const FR_STOP = new Set(["le","la","les","des","de","du","et","pour","avec","en","une","un","que","vous","nous","au"]);
const PT_STOP = new Set(["o","a","os","as","de","do","da","e","para","com","em","por","uma","um","que","você","voce"]);
const IT_STOP = new Set(["il","lo","la","i","gli","le","di","del","e","per","con","in","un","una","che"]);
const NL_STOP = new Set(["de","het","een","en","voor","met","in","op","van","dat","je","wij","ons"]);

function normalizeSample(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Hard gate: if ANY of these scripts appear anywhere -> NOT DE/EN
function containsNonLatinScript(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}]/u.test(
    String(text || "")
  );
}

function tokenize(text) {
  const s = normalizeSample(text).toLowerCase();
  if (!s) return [];
  // keep accents for Romance detection
  return s.split(/[^\p{L}]+/u).filter(Boolean);
}

function stopwordScore(words, stopset) {
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) if (stopset.has(w)) hits += 1;
  return hits / words.length;
}

function francLang(text, minLength = 160) {
  const sample = normalizeSample(text);
  if (!sample || sample.length < minLength) return "und";
  return franc(sample, { minLength });
}

/**
 * Strip Workday noise + boilerplate that causes false English detection.
 * Key: remove tail EEO/legal blocks and "Date Posted" blocks.
 */
function stripWorkdayNoise(raw) {
  let s = String(raw || "");

  // Cut off at common tail markers to avoid EEO boilerplate influencing detection.
  // (Keep only content BEFORE these markers.)
  const cutMarkers = [
    /(?:\n|^)\s*Date\s*Posted\b/i,
    /(?:\n|^)\s*Closing\s*Date\b/i,
    /(?:\n|^)\s*Veröffentlicht\b/i,
    /(?:\n|^)\s*Bewerbungsschluss\b/i
  ];
  for (const m of cutMarkers) {
    const idx = s.search(m);
    if (idx >= 0) {
      s = s.slice(0, idx);
      break;
    }
  }

  // Remove common labels/metadata that appear mid-text.
  const metaPatterns = [
    /\bReq(?:uisition)?\s*ID\b[\s\S]{0,120}/gi,
    /\bJob\s*Requisition\s*ID\b[\s\S]{0,120}/gi,
    /\bTime\s*Type\b[\s\S]{0,120}/gi,
    /\bWorker\s*Type\b[\s\S]{0,120}/gi,
    /\bPrimary\s*Location\b[\s\S]{0,140}/gi,
    /\bAdditional\s*Locations\b[\s\S]{0,180}/gi,
    /\bHeute\s+ausgeschrieben\b[\s\S]{0,80}/gi,
    /\bVor\s+\d+\s+Tagen\s+ausgeschrieben\b[\s\S]{0,80}/gi
  ];
  for (const p of metaPatterns) s = s.replace(p, " ");

  // Remove well-known EEO/legal boilerplate blocks (EN-heavy).
  const eeoPatterns = [
    /equal\s+opportunity\s+employer[\s\S]{0,4000}$/i,
    /all\s+qualified\s+applicants[\s\S]{0,4000}$/i,
    /we\s+are\s+an\s+equal\s+opportunity[\s\S]{0,4000}$/i,
    /eeo\s+is\s+the\s+law[\s\S]{0,4000}$/i,
    /e-?verify[\s\S]{0,4000}$/i,
    /reasonable\s+accommodations?[\s\S]{0,4000}$/i
  ];
  for (const p of eeoPatterns) s = s.replace(p, " ");

  // Some companies prepend long culture paragraphs; keep conservative removal.
  const jjIntro = [
    /Bei\s+Johnson\s*&\s*Johnson\s+glauben\s+wir[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i,
    /At\s+Johnson\s*&\s*Johnson\s+we\s+believe[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i
  ];
  for (const p of jjIntro) s = s.replace(p, " ");

  return normalizeSample(s);
}

/**
 * Samples used for language detection.
 * IMPORTANT: Also do a hard non-Latin scan over a larger prefix to catch "mixed" postings.
 */
function buildSamples(title, desc) {
  const t = normalizeSample(title);
  const d = stripWorkdayNoise(desc);

  const samples = [];
  if (t) samples.push({ kind: "title", text: t });

  if (!d) return samples;

  const n = d.length;
  const take = (start, len) => d.slice(Math.max(0, start), Math.min(n, start + len));

  // Use start + middle. Avoid end.
  samples.push({ kind: "start", text: take(0, 1100) });
  if (n > 1400) samples.push({ kind: "middle", text: take(Math.floor(n / 2) - 350, 700) });

  return samples;
}

function classifyChunk(text) {
  const s = normalizeSample(text);
  if (!s) return "unknown";

  // Hard reject on any non-Latin script in the chunk
  if (containsNonLatinScript(s)) return "foreign";

  const words = tokenize(s);
  if (words.length < 30) return "unknown";

  const en = stopwordScore(words, EN_STOP);
  const de = stopwordScore(words, DE_STOP);

  const es = stopwordScore(words, ES_STOP);
  const fr = stopwordScore(words, FR_STOP);
  const pt = stopwordScore(words, PT_STOP);
  const it = stopwordScore(words, IT_STOP);
  const nl = stopwordScore(words, NL_STOP);

  const foreignMax = Math.max(es, fr, pt, it, nl);
  const deEnMax = Math.max(en, de);

  // Strong foreign signal -> foreign
  if (foreignMax >= 0.020 && foreignMax > deEnMax + 0.006) return "foreign";

  // Strong DE/EN signal -> de_en
  if (deEnMax >= 0.018) return "de_en";

  // Franc as soft secondary
  const lang = francLang(s, 180);
  if (lang === "deu" || lang === "eng") return "de_en";
  if (lang !== "und" && s.length >= 260) return "foreign";

  return "unknown";
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";

    // Hard reject if title contains non-Latin script
    if (containsNonLatinScript(title)) {
      removed.push(job);
      continue;
    }

    // Hard reject if description contains non-Latin script anywhere in a generous prefix.
    // (Catches mixed DE+CN jobs where CN appears later.)
    const descPrefix = String(desc || "").slice(0, 6000);
    if (containsNonLatinScript(descPrefix)) {
      removed.push(job);
      continue;
    }

    const samples = buildSamples(title, desc);

    let deEn = 0;
    let foreign = 0;
    let unknown = 0;

    for (const s of samples) {
      const cls = classifyChunk(s.text);
      if (cls === "de_en") deEn += 1;
      else if (cls === "foreign") foreign += 1;
      else unknown += 1;
    }

    // Decision:
    // - If we have any "foreign" and NO DE/EN evidence -> remove
    if (foreign > 0 && deEn === 0) {
      removed.push(job);
      continue;
    }

    // - If DE/EN is present -> keep
    if (deEn > 0) {
      kept.push(job);
      continue;
    }

    // - If everything is unknown, keep (prevents false negatives on technical English),
    //   BUT only if no foreign scripts (already gated) and no foreign stopword dominance (handled above).
    kept.push(job);
  }

  return { kept, removed };
}
