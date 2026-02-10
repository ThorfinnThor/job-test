import { franc } from "franc-min";

// Small stopword sets (fallback signals)
// (We keep these small on purpose; they're used as a gentle hint, not a strict classifier.)
const EN_STOP = new Set([
  "the","and","for","with","to","of","in","on","at","from","your","you","we","our","a","an",
  "as","is","are","be","will","this","that","role","responsibilities","requirements","team",
  "experience","skills","work","job","position"
]);

const DE_STOP = new Set([
  "und","der","die","das","für","mit","zu","von","im","in","auf","am","aus","wir","unser",
  "unsere","sie","ihr","eine","ein","ist","sind","werden","diese","dieser","stelle","aufgaben",
  "anforderungen","team","erfahrung","kenntnisse"
]);

function normalizeSample(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNonLatinScript(text) {
  // Hard gate for obvious non-DE/EN scripts.
  // If this triggers, we drop immediately (your requirement: keep only DE/EN).
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

// Conservative boilerplate removal (optional, helps J&J-style intros)
// Kept small to avoid accidentally deleting real content.
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

  // One chunk for short descriptions
  if (n <= 900) return [s];

  // 3 chunks for robustness: start/mid/end
  return [
    take(0),
    take(Math.floor(n / 2) - 350),
    s.slice(Math.max(0, n - 700))
  ].map(normalizeSample).filter(Boolean);
}

/**
 * classifyChunk: relaxed classification.
 *
 * - "de_en": clear evidence of German/English (franc==deu/eng OR stopword signal)
 * - "foreign": clear evidence it's neither German nor English (franc says something else
 *              AND stopwords are weak AND chunk is sufficiently long)
 * - "unknown": inconclusive (keep by default to avoid false negatives)
 */
function classifyChunk(text) {
  const s = normalizeSample(text);
  if (!s) return "unknown";

  // Hard reject non-Latin scripts
  if (containsNonLatinScript(s)) return "foreign";
  if (nonLatinRatio(s) > 0.18) return "foreign";

  const en = stopwordScore(s, EN_STOP);
  const de = stopwordScore(s, DE_STOP);

  // If we see any reasonable EN/DE signal, treat as DE/EN
  if (en >= 0.015 || de >= 0.015) return "de_en";

  // Use franc as an additional hint (no confidence, so we keep it soft)
  const lang = francLang(s, 120);
  if (lang === "deu" || lang === "eng") return "de_en";

  // If franc detects a specific non-DE/EN language, only mark as foreign
  // when the text is long enough and stopword signal is weak.
  if (lang !== "und") {
    if (s.length >= 240 && en < 0.01 && de < 0.01) return "foreign";
    return "unknown";
  }

  return "unknown";
}

/**
 * Title gate: VERY relaxed.
 * We only drop titles that clearly violate DE/EN requirement (non-Latin script).
 * This avoids accidentally dropping English titles due to misclassification.
 */
function titleAllowed(title) {
  const t = normalizeSample(title);
  if (!t) return true;
  if (containsNonLatinScript(t)) return false;
  if (nonLatinRatio(t) > 0.10) return false;
  return true;
}

export function filterJobsGermanEnglish(jobs) {
  const kept = [];
  const removed = [];

  for (const job of jobs) {
    const title = job?.title || "";
    const desc = job?.description?.text || "";
    const descNorm = normalizeSample(desc);

    // 1) Hard reject non-Latin / clearly not DE/EN title
    if (!titleAllowed(title)) {
      removed.push(job);
      continue;
    }

    // 2) If no description, keep (avoid false negatives)
    if (!descNorm) {
      kept.push(job);
      continue;
    }

    // 3) Chunk classification (relaxed)
    const chunks = chunkSamples(descNorm);
    if (chunks.length === 0) {
      kept.push(job);
      continue;
    }

    let deEn = 0;
    let foreign = 0;
    let unknown = 0;

    for (const c of chunks) {
      const cls = classifyChunk(c);
      if (cls === "de_en") deEn += 1;
      else if (cls === "foreign") foreign += 1;
      else unknown += 1;
    }

    // Keep if we saw any DE/EN chunk
    if (deEn > 0) {
      kept.push(job);
      continue;
    }

    // Reject only with strong evidence:
    // - 2+ chunks foreign (out of 3), or
    // - single-chunk description that's long and foreign
    if (foreign >= 2) {
      removed.push(job);
      continue;
    }
    if (chunks.length === 1 && foreign === 1 && descNorm.length >= 300) {
      removed.push(job);
      continue;
    }

    // Otherwise keep (unknown or mixed but not clearly foreign)
    kept.push(job);
  }

  return { kept, removed };
}
