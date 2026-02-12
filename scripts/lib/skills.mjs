import { readFile } from "node:fs/promises";
import path from "node:path";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRegexLike(s) {
  return /[\\.^$|?*+()\[\]]/.test(s);
}

async function loadSpec() {
  const p = path.join(process.cwd(), "lib", "skills.json");
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw);
}

let _compiled = null;

async function getCompiled() {
  if (_compiled) return _compiled;
  const spec = await loadSpec();
  const compiled = spec.skills.map((s) => {
    const patterns = (s.patterns || []).map((pat) => {
      const p = String(pat);
      if (isRegexLike(p)) return new RegExp(p, "i");
      const escaped = escapeRegExp(p);
      // Add word boundaries for simple word tokens; keep as-is for multi-word.
      if (/\s/.test(p)) return new RegExp(escaped, "i");
      if (p.length <= 2) return new RegExp(escaped, "i");
      return new RegExp(`\\b${escaped}\\b`, "i");
    });
    return {
      id: s.id,
      label: s.label,
      group: s.group,
      patterns
    };
  });
  _compiled = compiled;
  return compiled;
}

export async function extractSkillIdsFromText(text) {
  const t = String(text ?? "");
  if (!t) return [];

  const compiled = await getCompiled();
  const found = [];
  for (const s of compiled) {
    if (s.patterns.some((re) => re.test(t))) found.push(s.id);
  }
  return found;
}

export async function attachSkills(job) {
  const title = String(job?.title ?? "");
  const desc = String(job?.description?.text ?? "");
  const text = `${title}\n${desc}`;
  const ids = await extractSkillIdsFromText(text);
  // stable ordering
  ids.sort((a, b) => a.localeCompare(b));
  return { ...job, skills: ids };
}
