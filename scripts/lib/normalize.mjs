export function cleanText(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function absoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function stripHtml(html) {
  return cleanText(String(html ?? "").replace(/<[^>]*>/g, " "));
}

export function stableId(prefix, uniqueString) {
  return `${prefix}:${Buffer.from(uniqueString).toString("base64url")}`;
}

export function normalizeEmploymentType(v) {
  const s = cleanText(v).toLowerCase();
  if (!s) return null;
  // English
  if (s.includes("full")) return "full_time";
  if (s.includes("part")) return "part_time";
  if (s.includes("contract") || s.includes("freelance") || s.includes("consult")) return "contract";
  if (s.includes("intern") || s.includes("student") || s.includes("graduate")) return "internship";
  if (s.includes("temp") || s.includes("fixed-term") || s.includes("fixed term")) return "temporary";

  // German
  if (s.includes("vollzeit") || s.includes("fulltime")) return "full_time";
  if (s.includes("teilzeit") || s.includes("parttime")) return "part_time";
  if (s.includes("befrist") || s.includes("zeitvertrag") || s.includes("fixed term")) return "temporary";
  if (s.includes("praktik") || s.includes("werkstudent") || s.includes("student") || s.includes("trainee"))
    return "internship";
  if (s.includes("freiberuf") || s.includes("berater") || s.includes("vertrag")) return "contract";
  return null;
}

export function normalizeWorkplace(v) {
  const s = cleanText(v).toLowerCase();
  if (!s) return null;
  // remote
  if (
    s.includes("remote") ||
    s.includes("work from home") ||
    s.includes("wfh") ||
    s.includes("home office") ||
    s.includes("mobiles arbeiten") ||
    s.includes("telearbeit")
  )
    return "remote";

  // hybrid / flex
  if (s.includes("hybrid") || s.includes("flex") || s.includes("kombin")) return "hybrid";

  // onsite
  if (
    s.includes("on-site") ||
    s.includes("onsite") ||
    s.includes("vor ort") ||
    s.includes("office") ||
    s.includes("site")
  )
    return "onsite";
  return null;
}

export function safeIsoDate(v) {
  try {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}
