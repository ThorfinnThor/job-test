import {
  cleanText,
  stripHtml,
  safeIsoDate,
  stableId,
  normalizeWorkplace,
  normalizeEmploymentType
} from "../lib/normalize.mjs";

/**
 * Workday public "cxs" endpoints (JSON) scraper.
 * Extracts:
 * - title, url/applyUrl, description.text
 * - reqId, timeType, employmentType, workplace/workplaceRaw
 * - locations[] + location string
 * - postedAt parsed from ISO or DE/EN relative strings (Europe/Berlin calendar correct)
 */
export async function scrapeWorkday({
  company,
  host,
  tenant,
  site,
  searchText = "",
  max = 250,
  fetchDetails = true
}) {
  const scrapedAt = new Date().toISOString();

  const base = `https://${host}/wday/cxs/${tenant}/${site}`;
  const listUrl = `${base}/jobs`;

  async function fetchJson(url, { method = "GET", body = null } = {}) {
    const { fetch } = await import("undici");
    const res = await fetch(url, {
      method,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        ...(body ? { "content-type": "application/json" } : {}),
        "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}`);
    return await res.json();
  }

  async function tryFetchJson(url, opts) {
    try {
      return await fetchJson(url, opts);
    } catch {
      return null;
    }
  }

  async function getPage(offset, limit) {
    // Variant A: GET with query params
    const urlA = `${listUrl}?offset=${offset}&limit=${limit}&searchText=${encodeURIComponent(searchText)}`;
    const a = await tryFetchJson(urlA);
    if (a?.jobPostings) return a;

    // Variant B: POST with JSON body
    const b = await tryFetchJson(listUrl, {
      method: "POST",
      body: { appliedFacets: {}, searchText, limit, offset }
    });
    if (b?.jobPostings) return b;

    // Variant C: some tenants use "query"
    const c = await tryFetchJson(listUrl, {
      method: "POST",
      body: { appliedFacets: {}, query: searchText, limit, offset }
    });
    if (c?.jobPostings) return c;

    return null;
  }

  // ---- HTML entity decoding (no extra deps) ----
  function decodeHtmlEntities(str) {
    const s = String(str || "");
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
      hellip: "…"
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
      .replace(/\u00A0/g, " ");
  }

  // ---- Timezone helpers (Europe/Berlin) ----
  const TZ = "Europe/Berlin";

  function getTzOffsetMinutes(date, timeZone) {
    // Node 20 supports shortOffset in most environments.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
    const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const hh = parseInt(m[2], 10) || 0;
    const mm = parseInt(m[3] || "0", 10) || 0;
    return sign * (hh * 60 + mm);
  }

  function berlinYMDFromDate(date) {
    // returns {y,m,d} in Berlin calendar.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const s = fmt.format(date); // YYYY-MM-DD
    const [yy, mm, dd] = s.split("-").map((x) => parseInt(x, 10));
    return { y: yy, m: mm, d: dd };
  }

  function addDaysToYMD({ y, m, d }, deltaDays) {
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC avoids DST edge cases
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function berlinMidnightUtcIso(ymd) {
    // Create the instant that corresponds to 00:00 in Berlin for that Berlin date.
    const approxUtc = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0));
    const offsetMin = getTzOffsetMinutes(approxUtc, TZ);
    const utcMillis = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0) - offsetMin * 60_000;
    return new Date(utcMillis).toISOString();
  }

  function parsePostedAt(postedRaw, scrapedAtIso) {
    const raw = cleanText(postedRaw);
    if (!raw) return null;

    // If it is already a real ISO-ish date, keep it.
    const iso = safeIsoDate(raw);
    if (iso) return iso;

    const now = new Date(scrapedAtIso);
    const todayBerlin = berlinYMDFromDate(now);

    const s = raw.toLowerCase();

    // ---- German patterns ----
    if (/\bheute\b/.test(s)) {
      return berlinMidnightUtcIso(todayBerlin);
    }
    if (/\bgestern\b/.test(s)) {
      return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -1));
    }

    // "Vor mehr als 30 Tagen ausgeschrieben"
    let m = s.match(/vor\s+mehr\s+als\s+(\d+)\s+tag/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -n));
    }

    // "Vor 7 Tagen ausgeschrieben"
    m = s.match(/vor\s+(\d+)\s+tag/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -n));
    }

    // "Vor 2 Wochen ausgeschrieben"
    m = s.match(/vor\s+(\d+)\s+woche/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -(n * 7)));
    }

    // "Vor 3 Stunden ausgeschrieben" / "Vor 15 Minuten ausgeschrieben"
    m = s.match(/vor\s+(\d+)\s+stunde/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return new Date(now.getTime() - n * 3600_000).toISOString();
    }
    m = s.match(/vor\s+(\d+)\s+minute/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return new Date(now.getTime() - n * 60_000).toISOString();
    }

    // ---- English patterns ----
    if (/\bposted\s+today\b/.test(s) || /\btoday\b/.test(s) && /\bposted\b/.test(s)) {
      return berlinMidnightUtcIso(todayBerlin);
    }
    if (/\bposted\s+yesterday\b/.test(s)) {
      return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -1));
    }

    m = s.match(/posted\s+(\d+)\s+day[s]?\s+ago/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -n));
    }

    m = s.match(/posted\s+(\d+)\s+week[s]?\s+ago/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -(n * 7)));
    }

    // If we can't parse it, keep null (do not guess).
    return null;
  }

  function toStringList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.flatMap((x) => toStringList(x));
    if (typeof v === "string") return [v];
    if (typeof v === "object") {
      if (typeof v.descriptor === "string") return [v.descriptor];
      if (typeof v.value === "string") return [v.value];
      if (typeof v.name === "string") return [v.name];
      if (typeof v.location === "string") return [v.location];
    }
    return [];
  }

  function parseBulletFields(bullets) {
    // Extract key/value lines from bulletFields.
    // Examples:
    // - "Location: Munich"
    // - "Standort: München"
    // - "Posted: Vor 7 Tagen ausgeschrieben"
    if (!Array.isArray(bullets)) return {};
    const out = {};
    for (const b of bullets) {
      const s = cleanText(b);
      const m = s.match(/^([^:]+)\s*:\s*(.+)$/);
      if (!m) continue;
      const key = cleanText(m[1]).toLowerCase();
      const val = cleanText(m[2]);
      if (!key || !val) continue;
      out[key] = val;
    }
    return out;
  }

  function splitLocations(s) {
    const t = cleanText(s);
    if (!t) return [];
    const parts = t
      .split(/\s*[|/]\s*/)
      .flatMap((x) => x.split(/\s*;\s*/))
      .map((x) => cleanText(x))
      .filter(Boolean);
    return parts.length ? parts : [t];
  }

  function isFakeLocationToken(token) {
    const t = cleanText(token);
    if (!t) return true;
    // Common Workday UI labels:
    // "3 Standorte" / "2 Locations" / "Multiple Locations"
    if (/^\d+\s+(standorte|locations?)$/i.test(t)) return true;
    if (/^multiple\s+locations$/i.test(t)) return true;
    if (/^alle\s+standorte$/i.test(t)) return true;
    return false;
  }

  function dedupeKeepOrder(arr) {
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      const k = cleanText(x);
      if (!k) continue;
      if (isFakeLocationToken(k)) continue;
      const key = k.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(k);
    }
    return out;
  }

  function extractLocations(listItem, detail) {
    const locs = [];

    // list payload
    if (listItem?.locationsText) locs.push(...splitLocations(listItem.locationsText));
    if (listItem?.location) locs.push(...splitLocations(listItem.location));
    if (listItem?.locations) locs.push(...toStringList(listItem.locations).flatMap(splitLocations));

    // bulletFields fallback
    if (listItem?.bulletFields) {
      const kv = parseBulletFields(listItem.bulletFields);
      const locVal = kv["location"] || kv["locations"] || kv["standort"] || kv["arbeitsort"];
      if (locVal) locs.push(...splitLocations(locVal));
    }

    // detail payload
    const info = detail?.jobPostingInfo;
    if (info?.location) locs.push(...splitLocations(info.location));
    if (info?.additionalLocations) locs.push(...toStringList(info.additionalLocations).flatMap(splitLocations));
    if (info?.locationsText) locs.push(...splitLocations(info.locationsText));
    if (info?.jobLocation) locs.push(...toStringList(info.jobLocation).flatMap(splitLocations));

    const finalLocs = dedupeKeepOrder(locs);
    return { locations: finalLocs, primary: finalLocs.length ? finalLocs[0] : null };
  }

  async function fetchDetailForPosting(jp) {
    const candidates = [];
    if (jp?.externalPath) candidates.push(`${base}${jp.externalPath}`);
    if (jp?.jobPostingId) candidates.push(`${base}/job/${jp.jobPostingId}`);
    if (jp?.jobReqId) candidates.push(`${base}/job/${jp.jobReqId}`);
    if (jp?.id) candidates.push(`${base}/job/${jp.id}`);

    for (const u of candidates) {
      const dj = await tryFetchJson(u);
      if (dj?.jobPostingInfo) return dj;
    }
    return null;
  }

  function guessWorkplaceRaw(info, listItem, locations, descriptionText) {
    // Tenant-dependent. Try common fields first.
    const candidates = [
      info?.workplaceType,
      info?.workLocationType,
      info?.remoteType,
      listItem?.workplaceType,
      listItem?.workLocationType,
      listItem?.remoteType
    ]
      .map((x) => cleanText(x))
      .filter(Boolean);

    if (candidates.length) return candidates[0];

    // Heuristics from locations/description
    const locStr = (locations || []).join(" | ").toLowerCase();
    const desc = String(descriptionText || "").toLowerCase();

    if (/\bremote\b/.test(locStr) || /\bremote\b/.test(desc)) return "Remote";
    if (/\bhybrid\b/.test(locStr) || /\bhybrid\b/.test(desc)) return "Hybrid";
    if (/\bon-?site\b/.test(locStr) || /\bon-?site\b/.test(desc)) return "Onsite";

    // German hints
    if (/\bhome\s*office\b/.test(locStr) || /\bhome\s*office\b/.test(desc)) return "Remote";
    if (/\bhybrid\b/.test(desc) || /\bhybrid\b/.test(locStr)) return "Hybrid";
    if (/\bvor\s*ort\b/.test(desc) || /\bvor\s*ort\b/.test(locStr)) return "Onsite";

    return null;
  }

  // ---- scrape ----
  const jobs = [];
  const seen = new Set();

  let offset = 0;
  const limit = 20;

  while (jobs.length < max) {
    const page = await getPage(offset, limit);
    if (!page || !Array.isArray(page.jobPostings) || page.jobPostings.length === 0) break;

    for (const jp of page.jobPostings) {
      const postingUrl = jp?.externalPath ? `${base}${jp.externalPath}` : jp?.url || null;
      if (!postingUrl) continue;
      if (seen.has(postingUrl)) continue;
      seen.add(postingUrl);

      const title = cleanText(jp.title) || "Unknown title";

      const detail = fetchDetails ? await fetchDetailForPosting(jp) : null;
      const info = detail?.jobPostingInfo || null;

      // Locations
      const { locations, primary } = extractLocations(jp, detail);
      const location = locations.length ? locations.join(" | ") : primary || null;

      // Description
      const rawHtml = info?.jobDescription || null;
      const descriptionText = rawHtml ? decodeHtmlEntities(stripHtml(rawHtml)) : null;

      // Req ID / stable ID
      const reqId = cleanText(jp?.jobReqId ?? info?.jobReqId ?? info?.jobRequisitionId ?? "");
      const id = reqId ? `workday:${reqId}` : stableId("workday", postingUrl);

      // Posted date: may be ISO or relative localized string.
      // Pull from detail first, then list, then bulletFields.
      let postedOnRaw =
        info?.postedOn ??
        jp?.postedOn ??
        jp?.postedDate ??
        null;

      // Some tenants only show "Posted:" in bulletFields.
      if (!postedOnRaw && jp?.bulletFields) {
        const kv = parseBulletFields(jp.bulletFields);
        postedOnRaw =
          kv["posted"] ||
          kv["posted on"] ||
          kv["veröffentlicht"] ||
          kv["ausgeschrieben"] ||
          null;
      }

      const postedAt =
        safeIsoDate(postedOnRaw) ||
        parsePostedAt(postedOnRaw, scrapedAt) ||
        null;

      // Time type / employment type
      const timeType = cleanText(info?.timeType ?? jp?.timeType ?? "");
      const categoriesText = cleanText(jp?.categoriesText ?? info?.categoriesText ?? "");
      const employmentType = normalizeEmploymentType(timeType || categoriesText);

      // Job family/category/type (tenant-dependent; often missing in CXS)
      const jobFamily = cleanText(info?.jobFamily ?? jp?.jobFamily ?? "");
      const jobCategory = cleanText(info?.jobCategory ?? jp?.jobCategory ?? "");
      const jobType = cleanText(info?.jobType ?? jp?.jobType ?? "");

      // Workplace signals
      const workplaceRaw = guessWorkplaceRaw(info, jp, locations, descriptionText);
      const workplace = normalizeWorkplace(workplaceRaw || location || descriptionText || null);

      jobs.push({
        id,
        company,
        title,
        // location string for UI
        location,
        // normalized workplace category for filters/UI
        workplace,
        employmentType,
        // keep raw fields for transparency/debugging
        reqId: reqId || null,
        timeType: timeType || null,
        workplaceRaw: workplaceRaw || null,
        jobFamily: jobFamily || null,
        jobCategory: jobCategory || null,
        jobType: jobType || null,
        // optional "department" legacy slot (keep null if not sure)
        department: null,
        team: null,
        url: postingUrl,
        applyUrl: info?.externalUrl ?? postingUrl,
        description: { text: descriptionText, html: null },
        source: {
          kind: "workday_api",
          raw: {
            externalPath: jp?.externalPath ?? null,
            jobReqId: reqId || null,
            postedOnRaw: postedOnRaw ? cleanText(postedOnRaw) : null,
            locations
          }
        },
        postedAt,
        scrapedAt
      });
    }

    offset += page.jobPostings.length;
    if (page.jobPostings.length < limit) break;
  }

  return jobs;
}
