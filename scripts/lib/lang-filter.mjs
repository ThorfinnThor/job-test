import { franc } from "franc-min";

// Small stopword sets (fallback when language detection is inconclusive)
const EN_STOP = new Set([
  "the","and","for","with","to","of","in","on","at","from","your","you","we","our","a","an",
  "as","is","are","be","will","this","that","role","responsibilities","requirements"
]);
const DE_STOP = new Set([
  "und","der","die","das","für","mit","zu","von","im","in","auf","am","aus","wir","unser",
  "unsere","sie","ihr","eine","ein","ist","sind","werden","diese","dieser","stelle","aufgaben","anforderungen"
]);

function normalizeSample(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nonLatinRatio(text) {
  const s = normalizeSample(text);
  if (!s) return 0;

  let nonLatin = 0;
  let letters = 0;

  for (const ch of s) {
    // Count only letters-ish characters
    if (!(/\p{L}/u.test(ch))) continue;
    letters += 1;

    // Treat Latin + Latin-extended as "Latin"; everything else counts as non-Latin
    const code = ch.codePointAt(0);
    const isLatin =
      (code >= 0x0041 && code <= 0x007a) || // basic Latin letters
      (code >= 0x00c0 && code <= 0x024f) || // Latin-1 + Latin Extended
      (code >= 0x1e00 && code <= 0x1eff);   // Latin Extended Additional

    if (!isLatin) nonLatin += 1;
  }

  return letters === 0 ? 0 : nonLatin / letters;
}

function containsCJKOrArabicOrCyrillic(text) {
  // Very robust “title gate” for obvious non-DE/EN titles.
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

export function isGermanOrEnglish(text) {
  const sample = normalizeSample(text);
  if (!sample) return true;

  // If the text is clearly in a non-Latin script, drop it
  if (containsCJKOrArabicOrCyrillic(sample)) return false;
  if (nonLatinRatio(sample) > 0.15) return false;

  // Primary detector: franc (ISO-639-3)
  const minLength = 60;
  const lang = franc(sample, { minLength, whitelist: ["deu", "eng"] });

  if (lang === "deu" || lang === "eng") return true;

  // Fallback for "undetermined"
  const en = stopwordScore(sample, EN_STOP);
  const de = stopwordScore(sample, DE_STOP);
  if (en >= 0.02 || de >= 0.02) return true;

  // Long Latin text with no EN/DE signal -> treat as non-en/de
  if (sample.length >= 120) return false;

  // Short/ambiguous -> keep to avoid false negatives
  return true;
}

function isTitleGermanOrEnglish(title) {
  const t = normalizeSample(title);
  if (!t) return true; // don’t drop because of missing title; upstream should validate title anyway

  // Strong gate: obvious non-Latin scripts in title
  if (containsCJKOrArabicOrCyrillic(t)) return false;

  // Ratio gate: if title is mostly non-Latin letters, drop
  if (nonLatinRatio(t) > 0.10) return false;

  // For longer titles, use franc; for short titles franc often returns "und"
  if (t.length >= 20) {
    const lang = franc(t, { minLength: 10, whitelist: ["deu", "eng"] });
    if (lang === "deu" || lang === "eng") return true;
  }

  // Stopword fallback (helps for short EN/DE titles)
  const en = stopwordScore(t, EN_STOP);
  const de = stopwordScore(t, DE_STOP);
  if (en >= 0.02 || de >= 0.02) return true;

  // If it’s Latin-ish and short, keep (avoid false negatives on titles like "QA Engineer")
  return true;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";
    const combined = `${title}\n\n${desc}`.trim();

    // NEW: title must pass, independently of description
    if (!isTitleGermanOrEnglish(title)) {
      removed.push(job);
      continue;
    }

    if (isGermanOrEnglish(combined)) kept.push(job);
    else removed.push(job);
  }

  return { kept, removed };
}
