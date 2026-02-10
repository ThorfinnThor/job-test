import { franc } from "franc-min";

/**
 * Keep ONLY German/English jobs.
 *
 * Requirements:
 * - Drop jobs where TITLE is not German/English (even if description is EN).
 * - Drop jobs containing ANY non-Latin scripts (CJK/Arabic/Cyrillic) anywhere in title/description.
 *
 * Workday quirks:
 * - English EEO/legal boilerplate can appear even for non-EN jobs -> must be stripped.
 * - "Date Posted / Req ID / Time Type ..." blocks are not useful for language detection.
 *
 * Strategy:
 * 1) Hard reject non-Latin scripts in title or full description.
 * 2) Title gate: require DE/EN for meaningful titles (allow short acronyms).
 * 3) Description gate: compute dominant language on *core description* (after stripping boilerplate).
 *    - If franc says non-DE/EN -> reject.
 *    - If franc is 'und' -> use stopword dominance; reject if Romance stopwords dominate.
 */

// ------------------ Stopwords ------------------
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

// Common foreign stopwords to catch Romance/Germanic leakage when franc returns 'und'
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

// Hard gate for non-DE/EN scripts
function containsNonLatinScript(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}]/u.test(
    String(text || "")
  );
}

function tokenize(text) {
  const s = normalizeSample(text).toLowerCase();
  if (!s) return [];
  return s.split(/[^\p{L}]+/u).filter(Boolean);
}

function stopwordScore(words, stopset) {
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) if (stopset.has(w)) hits += 1;
  return hits / words.length;
}

function francLang(text, minLength) {
  const s = normalizeSample(text);
  if (!s || s.length < minLength) return "und";
  return franc(s, { minLength });
}

// ------------------ Boilerplate stripping ------------------
// Remove Workday metadata and tail boilerplate that can bias towards English.
function stripWorkdayNoise(raw) {
  let s = String(raw || "");

  // Cut off at common footer markers (removes most of the Workday footer/metadata area)
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

  // Remove inline meta labels that often appear inside the page
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

  // Remove common EN EEO/legal boilerplate blocks (often appended)
  const eeoPatterns = [
    /equal\s+opportunity\s+employer[\s\S]{0,5000}$/i,
    /all\s+qualified\s+applicants[\s\S]{0,5000}$/i,
    /we\s+are\s+an\s+equal\s+opportunity[\s\S]{0,5000}$/i,
    /eeo\s+is\s+the\s+law[\s\S]{0,5000}$/i,
    /e-?verify[\s\S]{0,5000}$/i,
    /reasonable\s+accommodations?[\s\S]{0,5000}$/i
  ];
  for (const p of eeoPatterns) s = s.replace(p, " ");

  // J&J-style culture intro (can be EN/DE even when job is foreign)
  const jjIntro = [
    /Bei\s+Johnson\s*&\s*Johnson\s+glauben\s+wir[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i,
    /At\s+Johnson\s*&\s*Johnson\s+we\s+believe[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i
  ];
  for (const p of jjIntro) s = s.replace(p, " ");

  return normalizeSample(s);
}

// ------------------ Title check ------------------
function titleIsGermanOrEnglish(title) {
  const t = normalizeSample(title);
  if (!t) return true;

  // Hard reject non-Latin scripts
  if (containsNonLatinScript(t)) return false;

  // Allow short acronyms / codes ("QA", "R&D", "HR", "IT")
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 6) return true;

  // For meaningful titles, require DE/EN via stopwords or franc.
  const words = tokenize(t);
  const en = stopwordScore(words, EN_STOP);
  const de = stopwordScore(words, DE_STOP);

  if (en >= 0.02 || de >= 0.02) return true;

  const lang = francLang(t, 12); // titles are short; use low minLength
  return lang === "eng" || lang === "deu";
}

// ------------------ Description check ------------------
function descriptionLooksGermanOrEnglish(descText) {
  const cleaned = stripWorkdayNoise(descText);

  // If nothing to analyze, keep (avoid dropping sparse postings)
  if (!cleaned) return true;

  // Determine dominant language from core content (start of text).
  // Using a larger sample helps franc detect e.g. Slovenian reliably.
  const core = cleaned.slice(0, 5000);

  // If franc confidently says non-DE/EN, reject.
  const lang = francLang(core, 220);
  if (lang !== "und" && lang !== "eng" && lang !== "deu") return false;

  // If franc is 'und', use stopword dominance tests.
  const words = tokenize(core);
  if (words.length < 40) {
    // too little signal; keep (reduces false negatives)
    return true;
  }

  const en = stopwordScore(words, EN_STOP);
  const de = stopwordScore(words, DE_STOP);
  const deEnMax = Math.max(en, de);

  const es = stopwordScore(words, ES_STOP);
  const fr = stopwordScore(words, FR_STOP);
  const pt = stopwordScore(words, PT_STOP);
  const it = stopwordScore(words, IT_STOP);
  const nl = stopwordScore(words, NL_STOP);
  const foreignMax = Math.max(es, fr, pt, it, nl);

  // Strong foreign dominance -> reject
  if (foreignMax >= 0.02 && foreignMax > deEnMax + 0.006) return false;

  // If we have any reasonable EN/DE stopword signal -> keep
  if (deEnMax >= 0.014) return true;

  // Otherwise keep (unknown technical English etc.)
  return true;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";

    // 1) Hard reject any non-Latin script anywhere in title or full description
    // (Fixes cases where CJK/Cyrillic appears later than a prefix scan.)
    if (containsNonLatinScript(title) || containsNonLatinScript(desc)) {
      removed.push(job);
      continue;
    }

    // 2) Title must be DE/EN (per your rule)
    if (!titleIsGermanOrEnglish(title)) {
      removed.push(job);
      continue;
    }

    // 3) Description must be dominantly DE/EN
    if (!descriptionLooksGermanOrEnglish(desc)) {
      removed.push(job);
      continue;
    }

    kept.push(job);
  }

  return { kept, removed };
}
