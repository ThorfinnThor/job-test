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
      const reqId = cleanText(jp?.jobReqId ?? info?.jobReqId ?? "");
      const id = reqId ? `workday:${reqId}` : stableId("workday", postingUrl);

      // Posted date: list payload sometimes contains postedOn/postedDate; detail often contains postedOn.
      const postedAt = safeIsoDate(info?.postedOn ?? jp?.postedOn ?? jp?.postedDate ?? null);

      // Employment/time type signals can appear in different fields.
      const timeTypeRaw = cleanText(info?.timeType ?? jp?.timeType ?? "");
      const categoryRaw = cleanText(jp?.categoriesText ?? "");
      const employmentType = normalizeEmploymentType(timeTypeRaw || categoryRaw);

      const department = cleanText(
        info?.jobFamily ??
          jp?.jobFamily ??
          info?.jobCategory ??
          jp?.category ??
          jp?.categoryText ??
          ""
      );

      jobs.push({
        id,
        company,
        title,
        location,
        workplace: normalizeWorkplace(location),
        employmentType,
        department: department || null,
        team: null,
        url: postingUrl,
        applyUrl: info?.externalUrl ?? postingUrl,
        description: { text: descriptionText, html: null },
        source: {
          kind: "workday_api",
          raw: {
            externalPath: jp?.externalPath ?? null,
            jobReqId: reqId || null,
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
