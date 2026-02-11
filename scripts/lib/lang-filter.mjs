import { franc } from "franc-min";

/**
 * Keep ONLY German/English jobs.
 *
 * Rules:
 * 1) Hard reject if title OR full description contains any non-Latin scripts (CJK/Arabic/Cyrillic).
 * 2) Title must be DE/EN (per your requirement), but avoid false negatives:
 *    - Accept Latin-only titles unless there is strong evidence they're not DE/EN.
 *    - Use common job-title keywords as positive signals (manager, engineer, m/w/d, etc.).
 * 3) Description must be dominantly DE/EN, measured on core content (boilerplate stripped),
 *    and not fooled by English EEO/legal tails.
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

// Foreign stopwords to catch Romance/Germanic leakage when franc returns 'und'
const ES_STOP = new Set(["el","la","los","las","de","del","y","para","con","en","por","una","un","como","que","se","su"]);
const FR_STOP = new Set(["le","la","les","des","de","du","et","pour","avec","en","une","un","que","vous","nous","au"]);
const PT_STOP = new Set(["o","a","os","as","de","do","da","e","para","com","em","por","uma","um","que","você","voce"]);
const IT_STOP = new Set(["il","lo","la","i","gli","le","di","del","e","per","con","in","un","una","che"]);
const NL_STOP = new Set(["de","het","een","en","voor","met","in","op","van","dat","je","wij","ons"]);

// Positive title keywords (EN/DE job vocabulary) — helps avoid false negatives on stopword-less titles.
const TITLE_KEYWORDS = [
  // English
  "manager","engineer","specialist","associate","director","lead","senior","principal","intern",
  "internship","trainee","student","analyst","developer","scientist","coordinator","consultant",
  "clinical","quality","qa","qc","regulatory","operations","supply","procurement","finance","marketing",
  "sales","account","data","security","software","product","project","program","support","administrator",
  // German
  "m/w/d","w/m/d","d/f/m","leiter","leitung","ingenieur","entwickler","spezialist","sachbearbeiter",
  "wissenschaftler","praktikum","praktikant","werkstudent","vollzeit","teilzeit","befristet",
  "mitarbeiter","berater","projekt","produktion","qualität","qualitaet","klinisch","forschung"
];

// ------------------ Helpers ------------------
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

function hasTitleKeyword(title) {
  const t = normalizeSample(title).toLowerCase();
  if (!t) return false;
  return TITLE_KEYWORDS.some((k) => t.includes(k));
}

// ------------------ Boilerplate stripping ------------------
function stripWorkdayNoise(raw) {
  let s = String(raw || "");

  // Cut off at common footer markers
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

  const eeoPatterns = [
    /equal\s+opportunity\s+employer[\s\S]{0,6000}$/i,
    /all\s+qualified\s+applicants[\s\S]{0,6000}$/i,
    /we\s+are\s+an\s+equal\s+opportunity[\s\S]{0,6000}$/i,
    /eeo\s+is\s+the\s+law[\s\S]{0,6000}$/i,
    /e-?verify[\s\S]{0,6000}$/i,
    /reasonable\s+accommodations?[\s\S]{0,6000}$/i
  ];
  for (const p of eeoPatterns) s = s.replace(p, " ");

  const jjIntro = [
    /Bei\s+Johnson\s*&\s*Johnson\s+glauben\s+wir[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i,
    /At\s+Johnson\s*&\s*Johnson\s+we\s+believe[\s\S]{0,1500}(?=\n\n|\n\s*\n|$)/i
  ];
  for (const p of jjIntro) s = s.replace(p, " ");

  return normalizeSample(s);
}

// ------------------ Title gate (improved) ------------------
function titleIsGermanOrEnglish(title) {
  const t = normalizeSample(title);
  if (!t) return true;

  // Hard reject non-Latin scripts
  if (containsNonLatinScript(t)) return false;

  // Allow acronyms / very short titles (QA, R&D, IT)
  const letterCount = (t.match(/\p{L}/gu) || []).length;
  if (letterCount < 6) return true;

  // If it contains common job-title keywords, treat as DE/EN
  if (hasTitleKeyword(t)) return true;

  const words = tokenize(t);
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
  if (foreignMax >= 0.02 && foreignMax > deEnMax + 0.008) return false;

  // Any reasonable EN/DE stopword signal -> accept
  if (deEnMax >= 0.012) return true;

  // Franc on titles can be noisy; only reject if it confidently returns a *specific* foreign lang
  // and the title is long enough (more reliable signal).
  const lang = francLang(t, 18);
  if (lang !== "und" && lang !== "eng" && lang !== "deu") {
    // If the title is long and we have no positive signals, treat as foreign.
    if (t.length >= 28) return false;
    // Shorter: too risky to reject -> keep
    return true;
  }

  // Default: accept (Latin-only, not strongly foreign)
  return true;
}

// ------------------ Description gate ------------------
function descriptionLooksGermanOrEnglish(descText) {
  const cleaned = stripWorkdayNoise(descText);

  if (!cleaned) return true;

  // Analyze core content; not tail.
  const core = cleaned.slice(0, 6000);

  // If franc confidently says non-DE/EN, reject
  const lang = francLang(core, 240);
  if (lang !== "und" && lang !== "eng" && lang !== "deu") return false;

  // If franc is 'und', use stopword dominance
  const words = tokenize(core);
  if (words.length < 40) return true;

  const en = stopwordScore(words, EN_STOP);
  const de = stopwordScore(words, DE_STOP);
  const deEnMax = Math.max(en, de);

  const es = stopwordScore(words, ES_STOP);
  const fr = stopwordScore(words, FR_STOP);
  const pt = stopwordScore(words, PT_STOP);
  const it = stopwordScore(words, IT_STOP);
  const nl = stopwordScore(words, NL_STOP);
  const foreignMax = Math.max(es, fr, pt, it, nl);

  if (foreignMax >= 0.02 && foreignMax > deEnMax + 0.006) return false;

  // weak signals default to keep (avoid false negatives on technical English)
  return true;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";

    // 1) Hard reject any non-Latin scripts anywhere in title OR full description
    if (containsNonLatinScript(title) || containsNonLatinScript(desc)) {
      removed.push(job);
      continue;
    }

    // 2) Title must be DE/EN (improved gate to avoid false negatives)
    if (!titleIsGermanOrEnglish(title)) {
      removed.push(job);
      continue;
    }

    // 3) Description must be dominantly DE/EN (core content)
    if (!descriptionLooksGermanOrEnglish(desc)) {
      removed.push(job);
      continue;
    }

    kept.push(job);
  }

  return { kept, removed };
}
