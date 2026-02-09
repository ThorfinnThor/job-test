export function cleanText(s) {
  return String(s ?? "")
    // remove common invisible chars that break search/highlighting
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // normalize NBSP
    .replace(/\u00a0/g, " ")
    // collapse whitespace
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

// Decode common HTML entities + numeric entities without adding deps.
export function decodeHtmlEntities(str) {
  const s = String(str ?? "");
  if (!s.includes("&")) return s;

  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”"
  };

  return s
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g1) => {
      if (!g1) return m;
      if (g1[0] === "#") {
        const hex = g1[1]?.toLowerCase() === "x";
        const n = parseInt(g1.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isFinite(n)) return m;
        try {
          return String.fromCodePoint(n);
        } catch {
          return m;
        }
      }
      const key = g1.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : m;
    })
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function stripHtml(html) {
  const noTags = String(html ?? "").replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntities(noTags);
  return cleanText(decoded);
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
  if (s.includes("befrist") || s.includes("zeitvertrag")) return "temporary";
  if (s.includes("praktik") || s.includes("werkstudent") || s.includes("trainee")) return "internship";
  if (s.includes("freiberuf") || s.includes("berater") || s.includes("vertrag")) return "contract";

  return null;
}

/**
 * Normalizes workplace into one of:
 * - "remote"
 * - "hybrid"
 * - "onsite"
 *
 * We intentionally keep the taxonomy small for easy filtering in the UI.
 */
export function normalizeWorkplace(v) {
  const s0 = cleanText(v).toLowerCase();
  if (!s0) return null;

  // --- Workday / German-specific labels seen in your data ---
  // "Vollständig Ferngesteuert" -> remote
  if (s0.includes("vollständig ferngesteuert") || s0.includes("vollstaendig ferngesteuert")) return "remote";

  // "Feldbasiert" / "feldbasiert" -> onsite (field-based work is not remote)
  if (s0.includes("feldbasiert")) return "onsite";

  // Catch-all: "vollständig im ..." often indicates fully on-site (office/site/etc.)
  // Your dataset had "Vollständig Im Hotel" as a workplaceRaw label — treat as onsite
  // rather than dropping it.
  if (s0.startsWith("vollständig im") || s0.startsWith("vollstaendig im")) return "onsite";

  // --- Generic English patterns ---
  if (
    s0.includes("remote") ||
    s0.includes("work from home") ||
    s0.includes("wfh")
  ) return "remote";

  if (s0.includes("hybrid") || s0.includes("flex")) return "hybrid";

  if (s0.includes("on-site") || s0.includes("onsite")) return "onsite";

  // --- Generic German patterns ---
  if (
    s0.includes("home office") ||
    s0.includes("mobiles arbeiten") ||
    s0.includes("telearbeit") ||
    s0.includes("fernarbeit")
  ) return "remote";

  if (s0.includes("hybrid") || s0.includes("flex") || s0.includes("kombin")) return "hybrid";

  if (
    s0.includes("vor ort") ||
    s0.includes("büro") ||
    s0.includes("buero") ||
    s0.includes("standort") ||
    s0.includes("office") ||
    s0.includes("site")
  ) return "onsite";

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
