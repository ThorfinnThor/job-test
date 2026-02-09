import { franc } from "franc-min";

// Very small German/English stopword sets (fallback when language detection is inconclusive).
const EN_STOP = new Set(["the","and","for","with","to","of","in","on","at","from","your","you","we","our","a","an","as","is","are","be","will","this","that","role","responsibilities","requirements"]);
const DE_STOP = new Set(["und","der","die","das","für","mit","zu","von","im","in","auf","am","aus","wir","unser","unsere","sie","ihr","eine","ein","ist","sind","werden","diese","dieser","stelle","aufgaben","anforderungen"]);

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
    const code = ch.codePointAt(0);
    // Count only letters-ish characters (skip digits/punctuation/whitespace)
    if (!(/[A-Za-z\u00C0-\u024F]/.test(ch)) && !(/\p{L}/u.test(ch))) continue;
    letters += 1;

    // Treat Latin + Latin-extended as "Latin"; everything else counts as non-Latin
    const isLatin =
      (code >= 0x0041 && code <= 0x007a) || // basic Latin letters
      (code >= 0x00c0 && code <= 0x024f) || // Latin-1 + Latin Extended
      (code >= 0x1e00 && code <= 0x1eff); // Latin Extended Additional

    if (!isLatin) nonLatin += 1;
  }

  return letters === 0 ? 0 : nonLatin / letters;
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
  if (!sample) return true; // nothing to judge => keep

  // If the text is clearly in a non-Latin script, drop it.
  // (This catches Chinese, Japanese, Arabic, Cyrillic, etc.)
  if (nonLatinRatio(sample) > 0.15) return false;

  // Primary detector: franc (ISO-639-3)
  // IMPORTANT: do NOT whitelist to [deu, eng]. If we do, franc will *always* pick one
  // of them even for French/Spanish/etc, and we'll accidentally keep non-DE/EN jobs.
  // If franc returns 'und' we fall back to stopwords.
  const minLength = 60;
  const lang = franc(sample, { minLength });

  if (lang === "deu" || lang === "eng") return true;

  // If undetermined, do a stopword fallback.
  // Thresholds are intentionally low; we just want to catch obvious cases.
  if (lang === "und") {
    const en = stopwordScore(sample, EN_STOP);
    const de = stopwordScore(sample, DE_STOP);
    if (en >= 0.02 || de >= 0.02) return true;

    // Short/ambiguous: keep to avoid false negatives.
    if (sample.length < 120) return true;
  }

  // Long Latin text, not detected as DE/EN => drop.
  return false;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";
    const combined = `${title}\n\n${desc}`.trim();

    if (isGermanOrEnglish(combined)) kept.push(job);
    else removed.push(job);
  }

  return { kept, removed };
}
