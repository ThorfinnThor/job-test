import { cleanText, stripHtml, safeIsoDate, stableId, normalizeWorkplace, normalizeEmploymentType } from "../lib/normalize.mjs";

/**
 * Workday public "cxs" endpoints are the most stable way to scrape Workday.
 *
 * Inputs:
 * - host: e.g. immatics.wd3.myworkdayjobs.com
 * - tenant: e.g. immatics
 * - site: e.g. Immatics_External
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
        "content-type": body ? "application/json" : undefined,
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
      body: {
        appliedFacets: {},
        searchText,
        limit,
        offset
      }
    });
    if (b?.jobPostings) return b;

    // Variant C: some tenants use "query" instead of "searchText"
    const c = await tryFetchJson(listUrl, {
      method: "POST",
      body: {
        appliedFacets: {},
        query: searchText,
        limit,
        offset
      }
    });
    if (c?.jobPostings) return c;

    return null;
  }

  function toStringList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.flatMap((x) => toStringList(x));
    if (typeof v === "string") return [v];
    if (typeof v === "object") {
      // common Workday shapes
      if (typeof v.descriptor === "string") return [v.descriptor];
      if (typeof v.value === "string") return [v.value];
      if (typeof v.name === "string") return [v.name];
      if (typeof v.location === "string") return [v.location];
    }
    return [];
  }

  function parseBulletLocation(bullets) {
    if (!Array.isArray(bullets)) return [];

    const hits = [];
    for (const b of bullets) {
      const s = cleanText(b);
      // English + German variants
      const m = s.match(/^(locations?|standort|arbeitsort)\s*:\s*(.+)$/i);
      if (m?.[2]) hits.push(m[2]);
    }
    return hits;
  }

  function splitLocations(s) {
    const t = cleanText(s);
    if (!t) return [];
    // Workday sometimes uses separators like " | " or " / ".
    const parts = t
      .split(/\s*[|/]\s*/)
      .flatMap((x) => x.split(/\s*;\s*/))
      .map((x) => cleanText(x))
      .filter(Boolean);
    return parts.length ? parts : [t];
  }

  function dedupeKeepOrder(arr) {
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      const k = cleanText(x);
      if (!k) continue;
      const key = k.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(k);
    }
    return out;
  }

  function extractLocations(listItem, detail) {
    const locs = [];

    // 1) List payload (fast)
    if (listItem?.locationsText) locs.push(...splitLocations(listItem.locationsText));
    if (listItem?.location) locs.push(...splitLocations(listItem.location));
    if (listItem?.locations) locs.push(...toStringList(listItem.locations).flatMap(splitLocations));
    if (listItem?.bulletFields) locs.push(...parseBulletLocation(listItem.bulletFields).flatMap(splitLocations));

    // 2) Detail payload (more reliable, includes additionalLocations)
    const info = detail?.jobPostingInfo;
    if (info?.location) locs.push(...splitLocations(info.location));
    if (info?.additionalLocations) locs.push(...toStringList(info.additionalLocations).flatMap(splitLocations));
    if (info?.locationsText) locs.push(...splitLocations(info.locationsText));
    if (info?.jobLocation) locs.push(...toStringList(info.jobLocation).flatMap(splitLocations));

    const finalLocs = dedupeKeepOrder(locs);
    return {
      locations: finalLocs,
      primary: finalLocs.length ? finalLocs[0] : null
    };
  }

  async function fetchDetailForPosting(jp) {
    // Many tenants return JSON at `${base}${externalPath}` when Accept is JSON.
    // Some also accept `/job/<id>`.
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

  function toUtcMidnightIso(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  // Convert a calendar date (Y-M-D) to an ISO timestamp corresponding to 00:00 in Europe/Berlin.
  // This ensures that "Heute" / "Vor X Tagen" resolve to the correct local date in Berlin,
  // including DST changes.
  const BERLIN_TZ = "Europe/Berlin";

  function getTimeZoneOffsetMs(date, timeZone) {
    // Node 20 supports timeZoneName: 'shortOffset' (e.g. "GMT+01:00").
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const tzPart = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "GMT";
    // Examples: "GMT+01:00", "GMT+1", "GMT-05:00"
    const m = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const hh = Number(m[2] ?? 0);
    const mm = Number(m[3] ?? 0);
    return sign * (hh * 60 + mm) * 60 * 1000;
  }

  function berlinYmd(date) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: BERLIN_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = fmt.formatToParts(date);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);
    return { y, m, d };
  }

  function berlinMidnightIsoFromYmd({ y, m, d }) {
    // Start with a UTC guess at 00:00 of that calendar day.
    const utcGuess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const offsetMs = getTimeZoneOffsetMs(utcGuess, BERLIN_TZ);
    const utcMillis = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
    return new Date(utcMillis).toISOString();
  }

  function subtractDaysFromYmd(ymd, days) {
    const d = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0));
    d.setUTCDate(d.getUTCDate() - days);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  function parsePostedOnRelative(text) {
    const s = cleanText(text).toLowerCase();
    if (!s) return null;

    // Prefer native date parsing first (some tenants return ISO / RFC strings)
    const direct = safeIsoDate(text);
    if (direct) return direct;

    // German
    // examples: "Heute ausgeschrieben", "Gestern ausgeschrieben", "Vor 7 Tagen ausgeschrieben",
    //           "Vor mehr als 30 Tagen ausgeschrieben"
    if (s.includes("heute")) return { daysAgo: 0 };
    if (s.includes("gestern")) return { daysAgo: 1 };

    let m = s.match(/vor\s+(?:mehr\s+als\s+)?(\d+)\s+tag(?:en)?/i);
    if (m?.[1]) return { daysAgo: Number(m[1]) };
    m = s.match(/vor\s+(?:mehr\s+als\s+)?(\d+)\s+woche(?:n)?/i);
    if (m?.[1]) return { daysAgo: Number(m[1]) * 7 };
    m = s.match(/vor\s+einem\s+tag/i);
    if (m) return { daysAgo: 1 };

    // German hours/minutes (occasionally used)
    m = s.match(/vor\s+(\d+)\s+stunde(?:n)?/i);
    if (m?.[1]) return { hoursAgo: Number(m[1]) };
    m = s.match(/vor\s+(\d+)\s+minute(?:n)?/i);
    if (m?.[1]) return { minutesAgo: Number(m[1]) };

    // English
    // examples: "Posted Today", "Posted Yesterday", "Posted 7 Days Ago"
    if (s.includes("posted today")) return { daysAgo: 0 };
    if (s.includes("posted yesterday")) return { daysAgo: 1 };
    m = s.match(/posted\s+(\d+)\s+day(?:s)?\s+ago/i);
    if (m?.[1]) return { daysAgo: Number(m[1]) };
    m = s.match(/posted\s+(\d+)\s+week(?:s)?\s+ago/i);
    if (m?.[1]) return { daysAgo: Number(m[1]) * 7 };

    // English hours/minutes (occasionally used)
    m = s.match(/posted\s+(\d+)\s+hour(?:s)?\s+ago/i);
    if (m?.[1]) return { hoursAgo: Number(m[1]) };
    m = s.match(/posted\s+(\d+)\s+minute(?:s)?\s+ago/i);
    if (m?.[1]) return { minutesAgo: Number(m[1]) };

    return null;
  }

  function postedAtFromAny(listItem, info) {
    let raw =
      info?.postedOn ??
      info?.postedDate ??
      info?.datePosted ??
      listItem?.postedOn ??
      listItem?.postedDate ??
      listItem?.datePosted ??
      null;

    // Some tenants only expose "posted" as a bullet field string (DE/EN).
    if (!raw && Array.isArray(listItem?.bulletFields)) {
      for (const b of listItem.bulletFields) {
        const s = cleanText(b);
        if (!s) continue;
        // examples: "Heute ausgeschrieben", "Vor 7 Tagen ausgeschrieben", "Posted 7 Days Ago"
        if (/ausgeschrieben/i.test(s) || /^posted\b/i.test(s)) {
          raw = s;
          break;
        }
        // examples: "Posted: Today" / "Ausschreibung: Heute"
        const m = s.match(/^(posted|ausschreibung|ver[öo]ffentlicht)\s*:\s*(.+)$/i);
        if (m?.[2]) {
          raw = m[2];
          break;
        }
      }
    }

    if (!raw) return { postedAt: null, postedOnRaw: null };

    const rel = parsePostedOnRelative(raw);
    if (!rel) return { postedAt: null, postedOnRaw: cleanText(raw) };

    if (typeof rel === "string") return { postedAt: rel, postedOnRaw: cleanText(raw) };

    if (typeof rel === "object") {
      // Relative days/weeks: interpret relative to the Berlin calendar date and convert to Berlin midnight.
      if (typeof rel.daysAgo === "number") {
        const ref = new Date(scrapedAt);
        const todayBerlin = berlinYmd(ref);
        const targetBerlin = subtractDaysFromYmd(todayBerlin, rel.daysAgo);
        return { postedAt: berlinMidnightIsoFromYmd(targetBerlin), postedOnRaw: cleanText(raw) };
      }

      // Relative hours/minutes: subtract from the scrape timestamp (instant), keep actual time.
      if (typeof rel.hoursAgo === "number") {
        const d = new Date(scrapedAt);
        d.setHours(d.getHours() - rel.hoursAgo);
        return { postedAt: d.toISOString(), postedOnRaw: cleanText(raw) };
      }
      if (typeof rel.minutesAgo === "number") {
        const d = new Date(scrapedAt);
        d.setMinutes(d.getMinutes() - rel.minutesAgo);
        return { postedAt: d.toISOString(), postedOnRaw: cleanText(raw) };
      }
    }

    return { postedAt: null, postedOnRaw: cleanText(raw) };
  }

  function firstNonEmpty(...vals) {
    for (const v of vals) {
      const t = cleanText(v);
      if (t) return t;
    }
    return null;
  }

  function extractWorkplaceRaw(listItem, info, locationsJoined, descriptionText) {
    const candidates = [];
    candidates.push(info?.remoteType, info?.workplaceType, info?.workLocationType, info?.workType, info?.workplace);
    candidates.push(listItem?.remoteType, listItem?.workplaceType, listItem?.workLocationType, listItem?.workType);

    // bullet fields sometimes contain "Work Location: Flex" / "Workplace: Hybrid" etc.
    if (Array.isArray(listItem?.bulletFields)) {
      for (const b of listItem.bulletFields) {
        const s = cleanText(b);
        const m = s.match(/^(work\s*location|workplace|arbeitsort|arbeitsmodell|remote\s*type)\s*:\s*(.+)$/i);
        if (m?.[2]) candidates.push(m[2]);
      }
    }

    const raw = firstNonEmpty(...candidates);
    if (raw) return raw;

    // last resort: infer from visible text
    const inferred = normalizeWorkplace(`${locationsJoined || ""} ${descriptionText || ""}`);
    return inferred ? inferred : null;
  }

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
      const info = detail?.jobPostingInfo;

      // Location: prefer detail, but always fall back to list payload.
      const { locations, primary } = extractLocations(jp, detail);
      const location = locations.length ? locations.join(" | ") : primary || null;

      // Description: Workday stores rich HTML in jobDescription.
      const descriptionText = info?.jobDescription ? stripHtml(info.jobDescription) : null;

      // A more stable ID if the req id is present; otherwise hash URL.
      const reqId = cleanText(jp?.jobReqId ?? info?.jobReqId ?? info?.jobRequisitionId ?? "");
      const id = reqId ? `workday:${reqId}` : stableId("workday", postingUrl);

      // Posted date: Workday often returns a localized relative string (e.g. "Heute ausgeschrieben").
      const { postedAt, postedOnRaw } = postedAtFromAny(jp, info);

      // Employment/time type signals can appear in different fields.
      const timeTypeRaw = firstNonEmpty(info?.timeType, jp?.timeType, info?.timeTypeText, jp?.timeTypeText);
      const categoryRaw = firstNonEmpty(jp?.categoriesText, info?.categoriesText);
      const employmentType = normalizeEmploymentType(timeTypeRaw || categoryRaw);

      const jobFamily = firstNonEmpty(info?.jobFamily, jp?.jobFamily, info?.jobFamilyGroup, jp?.jobFamilyGroup);
      const jobCategory = firstNonEmpty(info?.jobCategory, jp?.jobCategory, info?.category, jp?.categoryText, jp?.category);
      const jobType = firstNonEmpty(info?.jobType, jp?.jobType, info?.workerType, jp?.workerType);

      const department = cleanText(jobFamily ?? jobCategory ?? "");

      const workplaceRaw = extractWorkplaceRaw(jp, info, location, descriptionText);
      const workplace = normalizeWorkplace(workplaceRaw || location || "");

      jobs.push({
        id,
        company,
        title,
        location,
        locations,
        workplace,
        employmentType,
        department: department || null,
        jobFamily: jobFamily || null,
        jobCategory: jobCategory || null,
        jobType: jobType || null,
        timeType: timeTypeRaw || null,
        workplaceRaw: workplaceRaw || null,
        reqId: reqId || null,
        team: null,
        url: postingUrl,
        applyUrl: info?.externalUrl ?? postingUrl,
        description: { text: descriptionText, html: null },
        source: {
          kind: "workday_api",
          raw: {
            externalPath: jp?.externalPath ?? null,
            jobReqId: reqId || null,
            locations,
            postedOnRaw
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
