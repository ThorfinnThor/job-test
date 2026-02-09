import { franc } from "franc-min";

// Small stopword sets (used only as fallback when franc is 'und')
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

function containsNonLatinScript(text) {
  // Hard gate for obvious non-DE/EN scripts
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}]/u.test(
    String(text || "")
  );
}

function nonLatinRatio(text) {
  const s = normalizeSample(text);
  if (!s) return 0;

  let nonLatin = 0;
  let letters = 0;

  for (const ch of s) {
    if (!(/\p{L}/u.test(ch))) continue;
    letters += 1;

    const code = ch.codePointAt(0);
    const isLatin =
      (code >= 0x0041 && code <= 0x007a) || // basic Latin letters
      (code >= 0x00c0 && code <= 0x024f) || // Latin-1 + Latin Extended
      (code >= 0x1e00 && code <= 0x1eff);   // Latin Extended Additional

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

function francLang(text, minLength = 80) {
  const sample = normalizeSample(text);
  if (!sample || sample.length < minLength) return "und";
  return franc(sample, { minLength });
}

function isLikelyDeOrEn(text) {
  const sample = normalizeSample(text);
  if (!sample) return true;

  if (containsNonLatinScript(sample)) return false;
  if (nonLatinRatio(sample) > 0.15) return false;

  const lang = francLang(sample, 80);
  if (lang === "deu" || lang === "eng") return true;

  if (lang === "und") {
    const en = stopwordScore(sample, EN_STOP);
    const de = stopwordScore(sample, DE_STOP);
    // low thresholds; just catch obvious DE/EN
    if (en >= 0.02 || de >= 0.02) return true;
    // short ambiguous -> keep (reduce false negatives)
    return sample.length < 140;
  }

  // clearly something else (spa, fra, por, ita, etc.)
  return false;
}

function stripCommonBoilerplate(text) {
  // Remove common Johnson & Johnson boilerplate blocks that can "poison" language detection.
  // Keep this conservative: remove only when the phrases clearly appear.
  let s = String(text || "");
  const patterns = [
    /Bei\s+Johnson\s*&\s*Johnson\s+glauben\s+wir[\s\S]{0,1200}(?=\n\n|\n\s*\n)/i,
    /At\s+Johnson\s*&\s*Johnson\s+we\s+believe[\s\S]{0,1200}(?=\n\n|\n\s*\n)/i
  ];
  for (const p of patterns) {
    s = s.replace(p, "");
  }
  return s;
}

function chunkSamples(text) {
  const s0 = normalizeSample(text);
  if (!s0) return [];

  const s = stripCommonBoilerplate(s0);

  const out = [];
  const n = s.length;

  const take = (start) => s.slice(start, Math.min(start + 600, n));

  if (n <= 700) {
    out.push(s);
    return out;
  }

  out.push(take(0));                       // start
  out.push(take(Math.floor(n / 2) - 300)); // middle
  out.push(s.slice(Math.max(0, n - 600))); // end
  return out.map((x) => normalizeSample(x)).filter(Boolean);
}

function isTitleGermanOrEnglish(title) {
  const t = normalizeSample(title);
  if (!t) return true;

  // Hard reject: Chinese/Japanese/Arabic/Cyrillic etc.
  if (containsNonLatinScript(t)) return false;

  // Ratio gate for mixed titles
  if (nonLatinRatio(t) > 0.10) return false;

  // For longer titles, require franc to say DE/EN (or be und + stopwords)
  if (t.length >= 18) return isLikelyDeOrEn(t);

  // Short Latin titles like "QA Engineer" should pass.
  return true;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";

    // 1) Title must be DE/EN (prevents Chinese titles leaking through)
    if (!isTitleGermanOrEnglish(title)) {
      removed.push(job);
      continue;
    }

    // 2) Description sampling: if it contains strong non-DE/EN chunks, drop it.
    // This is robust against "German boilerplate + Spanish body" cases.
    const samples = chunkSamples(desc);
    if (!samples.length) {
      kept.push(job);
      continue;
    }

    let nonDeEnStrong = 0;
    let deEnStrong = 0;

    for (const s of samples) {
      const lang = francLang(s, 80);
      if (lang === "deu" || lang === "eng") {
        deEnStrong += 1;
      } else if (lang !== "und") {
        nonDeEnStrong += 1;
      } else {
        // und: try stopwords
        const en = stopwordScore(s, EN_STOP);
        const de = stopwordScore(s, DE_STOP);
        if (en >= 0.02 || de >= 0.02) deEnStrong += 1;
      }
    }

    // If any chunk is clearly non-DE/EN AND we don't also see DE/EN strongly, drop.
    if (deEnStrong === 0 && nonDeEnStrong > 0) {
      removed.push(job);
      continue;
    }
    // If multiple chunks are clearly foreign, drop.
    if (nonDeEnStrong >= 2) {
      removed.push(job);
      continue;
    }

    kept.push(job);
  }

  return { kept, removed };
}
