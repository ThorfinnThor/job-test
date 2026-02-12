import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toPubDate(iso) {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString();
}

function excerpt(text, maxLen = 280) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + "…";
}

function baseUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` ||
    "https://example.vercel.app"
  );
}

function jobItemXml(job) {
  const title = `${job.company?.name ?? ""} — ${job.title}`.trim();
  const link = job.url;
  const guid = job.id;
  const pubDate = toPubDate(job.postedAt || job.scrapedAt);
  const desc = excerpt(job.description?.text, 320);
  const loc = job.location ? `Location: ${job.location}` : "";
  const skills = Array.isArray(job.skills) && job.skills.length ? `Stack: ${job.skills.join(", ")}` : "";
  const extra = [loc, skills].filter(Boolean).join(" | ");

  return `\n    <item>\n      <title>${esc(title)}</title>\n      <link>${esc(link)}</link>\n      <guid isPermaLink="false">${esc(guid)}</guid>\n      <pubDate>${esc(pubDate)}</pubDate>\n      <description>${esc([desc, extra].filter(Boolean).join("\n\n"))}</description>\n    </item>`;
}

function rssXml({ title, description, link, items }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${esc(title)}</title>\n    <description>${esc(description)}</description>\n    <link>${esc(link)}</link>\n    <language>en</language>\n    <lastBuildDate>${esc(new Date().toUTCString())}</lastBuildDate>\n    ${items.join("\n")}\n  </channel>\n</rss>\n`;
}

export async function writeRssFeeds(jobs) {
  // Backwards-compatible: allow callers to pass { jobs, meta }.
  if (!Array.isArray(jobs) && jobs && Array.isArray(jobs.jobs)) {
    jobs = jobs.jobs;
  }

  // Be defensive: RSS is a nice-to-have. Don't crash the whole scrape.
  if (!Array.isArray(jobs)) {
    console.warn("[rss] writeRssFeeds: expected an array of jobs, got:", typeof jobs);
    return;
  }

  const base = baseUrl();
  const sorted = [...jobs].sort((a, b) => (b.postedAt || b.scrapedAt).localeCompare(a.postedAt || a.scrapedAt));

  const globalItems = sorted.slice(0, 200).map(jobItemXml);
  const global = rssXml({
    title: "Job Scout — All jobs",
    description: "Latest scraped jobs.",
    link: `${base}/jobs`,
    items: globalItems
  });

  await writeFile(path.join(process.cwd(), "public", "rss.xml"), global);

  const byCompany = new Map();
  for (const j of sorted) {
    const id = j.company?.id;
    if (!id) continue;
    if (!byCompany.has(id)) byCompany.set(id, []);
    byCompany.get(id).push(j);
  }

  const dir = path.join(process.cwd(), "public", "rss", "company");
  await mkdir(dir, { recursive: true });

  for (const [companyId, items] of byCompany.entries()) {
    const companyName = items[0]?.company?.name ?? companyId;
    const xml = rssXml({
      title: `Job Scout — ${companyName}`,
      description: `Latest scraped jobs for ${companyName}.`,
      link: `${base}/jobs?company=${encodeURIComponent(companyId)}`,
      items: items.slice(0, 200).map(jobItemXml)
    });
    await writeFile(path.join(dir, `${companyId}.xml`), xml);
  }
}
