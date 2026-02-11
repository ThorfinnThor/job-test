import {
  cleanText,
  stripHtml,
  safeIsoDate,
  stableId,
  normalizeWorkplace,
  normalizeEmploymentType
} from "../lib/normalize.mjs";

/**
 * Workday public CXS (JSON) scraper.
 *
 * Extracts reliably (tenant-dependent, best-effort):
 * - title, url/applyUrl, description.text (HTML stripped + entity-decoded)
 * - reqId, timeType (raw), employmentType (normalized)
 * - workplaceRaw + workplace (normalized; uses fields + heuristics)
 * - locations[] + primary location
 * - postedAt (ISO) parsed from:
 *   - ISO-like dates (if available), or
 *   - DE/EN relative strings ("Heute", "Vor 7 Tagen", "Posted 7 Days Ago", etc.)
 *     anchored to Europe/Berlin calendar boundaries.
 */
export async function scrapeWorkday({
  company,
  host,
  tenant,
  site,
  searchText = "",
  max = Infinity,
  fetchDetails = true,
  pageSize = 20,
  detailConcurrency = 6
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

  // ---------------- HTML entity decoding ----------------
  // (No extra dependency; decodes the common entities and numeric references.)
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
      .replace(/\u00A0/g, " ");
  }

  // ---------------- Concurrency helpers ----------------
  // Simple concurrency-limited async map (no external deps).
  async function pMap(items, concurrency, mapper) {
    const arr = Array.isArray(items) ? items : [];
    const n = arr.length;
    if (!n) return [];
    const limit = Math.max(1, Math.min(Number(concurrency) || 1, n));
    const out = new Array(n);
    let i = 0;

    await Promise.all(
      Array.from({ length: limit }, async () => {
        while (true) {
          const idx = i++;
          if (idx >= n) break;
          out[idx] = await mapper(arr[idx], idx);
        }
      })
    );

    return out;
  }

  // ---------------- Timezone helpers (Europe/Berlin) ----------------
  const TZ = "Europe/Berlin";

  function getTzOffsetMinutes(date, timeZone) {
    // Uses Intl shortOffset; works in Node 20 on GitHub Actions.
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
    // Use noon UTC to avoid DST edge cases.
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function berlinMidnightUtcIso(ymd) {
    // Create the instant corresponding to 00:00 Europe/Berlin for that Berlin date.
    const approxUtc = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0));
    const offsetMin = getTzOffsetMinutes(approxUtc, TZ);
    const utcMillis = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0) - offsetMin * 60_000;
    return new Date(utcMillis).toISOString();
  }

  function parsePostedAt(postedRaw) {
    const raw = cleanText(postedRaw);
    if (!raw) return null;

    // If it is already ISO-ish, keep it.
    const iso = safeIsoDate(raw);
    if (iso) return iso;

    const now = new Date(scrapedAt);
    const todayBerlin = berlinYMDFromDate(now);
    const s = raw.toLowerCase();

    // German
    if (/\bheute\b/.test(s)) return berlinMidnightUtcIso(todayBerlin);
    if (/\bgestern\b/.test(s)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -1));

    let m = s.match(/vor\s+mehr\s+als\s+(\d+)\s+tag/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -n));
    }

    m = s.match(/vor\s+(\d+)\s+tag/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -n));
    }

    m = s.match(/vor\s+(\d+)\s+woche/);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -(n * 7)));
    }

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

    // English
    if (/\bposted\s+today\b/.test(s)) return berlinMidnightUtcIso(todayBerlin);
    if (/\bposted\s+yesterday\b/.test(s)) return berlinMidnightUtcIso(addDaysToYMD(todayBerlin, -1));

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

    return null;
  }

  // ---------------- Location extraction ----------------
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

    // bullet fields fallback
    if (listItem?.bulletFields) {
      const kv = parseBulletFields(listItem.bulletFields);
      const locVal = kv["location"] || kv["locations"] || kv["standort"] || kv["arbeitsort"];
      if (locVal) locs.push(...splitLocations(locVal));
    }

    // detail payload
    const info = detail?.jobPostingInfo;
    if (info?.location) locs.push(...splitLocations(info.location));
    if (info?.additionalLocations)
      locs.push(...toStringList(info.additionalLocations).flatMap(splitLocations));
    if (info?.locationsText) locs.push(...splitLocations(info.locationsText));
    if (info?.jobLocation) locs.push(...toStringList(info.jobLocation).flatMap(splitLocations));

    const finalLocs = dedupeKeepOrder(locs);
    return { locations: finalLocs, primary: finalLocs.length ? finalLocs[0] : null };
  }

  // ---------------- Detail fetch ----------------
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

  // ---------------- Workplace signals ----------------
  function firstNonEmpty(...vals) {
    for (const v of vals) {
      const t = cleanText(v);
      if (t) return t;
    }
    return null;
  }

  function guessWorkplaceRaw(info, listItem, locations, descriptionText) {
    const candidates = [
      info?.workplaceType,
      info?.workLocationType,
      info?.remoteType,
      info?.workType,
      listItem?.workplaceType,
      listItem?.workLocationType,
      listItem?.remoteType
    ]
      .map((x) => cleanText(x))
      .filter(Boolean);

    if (candidates.length) return candidates[0];

    // bullet fields sometimes contain it
    if (Array.isArray(listItem?.bulletFields)) {
      for (const b of listItem.bulletFields) {
        const s = cleanText(b);
        const m = s.match(/^(work\s*location|workplace|arbeitsmodell|remote\s*type)\s*:\s*(.+)$/i);
        if (m?.[2]) return cleanText(m[2]);
      }
    }

    // heuristic
    const locStr = (locations || []).join(" | ").toLowerCase();
    const desc = String(descriptionText || "").toLowerCase();
    if (/\bremote\b/.test(locStr) || /\bremote\b/.test(desc)) return "Remote";
    if (/\bhybrid\b/.test(locStr) || /\bhybrid\b/.test(desc)) return "Hybrid";
    if (/\bon-?site\b/.test(locStr) || /\bon-?site\b/.test(desc)) return "Onsite";
    if (/\bhome\s*office\b/.test(locStr) || /\bhome\s*office\b/.test(desc)) return "Remote";
    if (/\bvor\s*ort\b/.test(desc) || /\bvor\s*ort\b/.test(locStr)) return "Onsite";
    return null;
  }

  // ---------------- Scrape ----------------
  const jobs = [];
  const seen = new Set();

  let offset = 0;
  let total = null;
  const limit = pageSize;

  while (jobs.length < max && offset < (total ?? Infinity)) {
    const page = await getPage(offset, limit);
    if (!page || !Array.isArray(page.jobPostings) || page.jobPostings.length === 0) break;

    // Some tenants expose a total count; use it to stop cleanly when present.
    total ??=
      page.total ??
      page.totalCount ??
      page.totalJobCount ??
      page.totalJobs ??
      page.totalResults ??
      null;

    const unique = [];
    for (const jp of page.jobPostings) {
      const postingUrl = jp?.externalPath ? `${base}${jp.externalPath}` : jp?.url || null;
      if (!postingUrl) continue;
      if (seen.has(postingUrl)) continue;
      seen.add(postingUrl);
      unique.push({ jp, postingUrl });
    }

    const details = fetchDetails
      ? await pMap(unique, detailConcurrency, ({ jp }) => fetchDetailForPosting(jp))
      : null;

    for (let idx = 0; idx < unique.length; idx++) {
      if (jobs.length >= max) break;

      const { jp, postingUrl } = unique[idx];
      const title = cleanText(jp.title) || "Unknown title";

      const detail = fetchDetails ? details[idx] : null;
      const info = detail?.jobPostingInfo || null;

      // Locations
      const { locations, primary } = extractLocations(jp, detail);
      const location = primary || null;

      // Description (HTML -> text + entity decode)
      const rawHtml = info?.jobDescription || null;
      const descriptionText = rawHtml ? decodeHtmlEntities(stripHtml(rawHtml)) : null;

      // Req ID / stable ID
      const reqId = cleanText(jp?.jobReqId ?? info?.jobReqId ?? info?.jobRequisitionId ?? "");
      const id = reqId ? `workday:${reqId}` : stableId("workday", postingUrl);

      // Posted date (detail first, then list, then bullet fields)
      let postedOnRaw =
        info?.postedOn ??
        jp?.postedOn ??
        jp?.postedDate ??
        info?.postedDate ??
        null;

      if (!postedOnRaw && jp?.bulletFields) {
        const kv = parseBulletFields(jp.bulletFields);
        postedOnRaw =
          kv["posted"] ||
          kv["posted on"] ||
          kv["veröffentlicht"] ||
          kv["ausgeschrieben"] ||
          null;
      }

      const postedAt = safeIsoDate(postedOnRaw) || parsePostedAt(postedOnRaw) || null;

      // Time type / employment type
      const timeType = firstNonEmpty(
        info?.timeType,
        jp?.timeType,
        info?.timeTypeText,
        jp?.timeTypeText
      );
      const categoriesText = firstNonEmpty(jp?.categoriesText, info?.categoriesText);
      const employmentType = normalizeEmploymentType(timeType || categoriesText);

      // Job family/category/type (often missing in public CXS; keep best-effort)
      const jobFamily = firstNonEmpty(
        info?.jobFamily,
        jp?.jobFamily,
        info?.jobFamilyGroup,
        jp?.jobFamilyGroup
      );
      const jobCategory = firstNonEmpty(
        info?.jobCategory,
        jp?.jobCategory,
        info?.category,
        jp?.categoryText,
        jp?.category
      );
      const jobType = firstNonEmpty(info?.jobType, jp?.jobType, info?.workerType, jp?.workerType);

      // Workplace signals
      const workplaceRaw = guessWorkplaceRaw(info, jp, locations, descriptionText);
      const workplace = normalizeWorkplace(workplaceRaw || location || descriptionText || null);

      jobs.push({
        id,
        company,
        title,
        location,
        // keep all locations for filtering/detail views
        locations: locations.length ? locations : undefined,

        workplace,
        employmentType,

        reqId: reqId || null,
        timeType: timeType || null,
        workplaceRaw: workplaceRaw || null,
        jobFamily: jobFamily || null,
        jobCategory: jobCategory || null,
        jobType: jobType || null,

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

  return Number.isFinite(max) ? jobs.slice(0, max) : jobs;
}
