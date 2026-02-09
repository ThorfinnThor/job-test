import { franc } from "franc-min";

// Small stopword sets (fallback when franc is 'und')
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
      (code >= 0x0041 && code <= 0x007a) || // basic Latin
      (code >= 0x00c0 && code <= 0x024f) || // Latin Extended
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

function francLang(text, minLength) {
  const sample = normalizeSample(text);
  if (!sample || sample.length < minLength) return "und";
  return franc(sample, { minLength });
}

// Conservative boilerplate stripping (prevents “German intro + Spanish body” from passing).
function stripCommonBoilerplate(text) {
  let s = String(text || "");
  const patterns = [
    /Bei\s+Johnson\s*&\s*Johnson\s+glauben\s+wir[\s\S]{0,1500}(?=\n\n|\n\s*\n)/i,
    /At\s+Johnson\s*&\s*Johnson\s+we\s+believe[\s\S]{0,1500}(?=\n\n|\n\s*\n)/i
  ];
  for (const p of patterns) s = s.replace(p, "");
  return s;
}

function chunkSamples(text) {
  const s0 = normalizeSample(text);
  if (!s0) return [];

  const s = normalizeSample(stripCommonBoilerplate(s0));
  if (!s) return [];

  const n = s.length;
  const take = (start, len = 700) => s.slice(Math.max(0, start), Math.min(n, start + len));

  // Short description: one chunk
  if (n <= 900) return [s];

  return [
    take(0),
    take(Math.floor(n / 2) - 350),
    s.slice(Math.max(0, n - 700))
  ].map(normalizeSample).filter(Boolean);
}

function classifyChunk(text) {
  const s = normalizeSample(text);
  if (!s) return "unknown";

  // hard reject for non-Latin scripts
  if (containsNonLatinScript(s)) return "foreign";
  if (nonLatinRatio(s) > 0.15) return "foreign";

  const lang = francLang(s, 120);

  if (lang === "deu" || lang === "eng") return "de_en";

  if (lang === "und") {
    // fall back to stopwords
    const en = stopwordScore(s, EN_STOP);
    const de = stopwordScore(s, DE_STOP);
    if (en >= 0.02 || de >= 0.02) return "de_en";
    return "unknown";
  }

  // Anything else (fra/spa/por/nld/pol/ita/etc.) counts as foreign
  return "foreign";
}

function isTitleGermanOrEnglish(title) {
  const t = normalizeSample(title);
  if (!t) return true;

  if (containsNonLatinScript(t)) return false;
  if (nonLatinRatio(t) > 0.10) return false;

  // For meaningful titles, require DE/EN.
  // (This drops French/Spanish/Portuguese titles that previously slipped through as "und".)
  if (t.length >= 10) {
    const c = classifyChunk(t);
    return c === "de_en";
  }

  // Very short titles like "QA" / "R&D" are ambiguous -> keep
  return true;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";

    // 1) Title gate (strict)
    if (!isTitleGermanOrEnglish(title)) {
      removed.push(job);
      continue;
    }

    // 2) Description gate (strict)
    // If ANY sampled chunk is clearly foreign -> remove.
    const samples = chunkSamples(desc);
    if (samples.length === 0) {
      // No description -> keep (avoid dropping valid postings)
      kept.push(job);
      continue;
    }

    let deEn = 0;
    let foreign = 0;
    let unknown = 0;

    for (const s of samples) {
      const cls = classifyChunk(s);
      if (cls === "de_en") deEn += 1;
      else if (cls === "foreign") foreign += 1;
      else unknown += 1;
    }

    // Strict rule aligned with your requirement:
    // - if any chunk is clearly foreign -> drop
    // - also require at least one DE/EN chunk for non-trivial descriptions
    if (foreign > 0) {
      removed.push(job);
      continue;
    }

    const combinedLen = normalizeSample(desc).length;
    if (combinedLen >= 200 && deEn === 0) {
      removed.push(job);
      continue;
    }

    kept.push(job);
  }

  return { kept, removed };
}
