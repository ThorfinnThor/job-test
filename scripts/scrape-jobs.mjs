import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sites } from "./sites.mjs";
import { toCsv } from "./lib/csv.mjs";
import { cleanText } from "./lib/normalize.mjs";
import { createLimiter } from "./lib/limit.mjs";
import { filterJobsGermanEnglish } from "./lib/lang-filter.mjs";
import { attachSkills } from "./lib/skills.mjs";
import { computeChanges } from "./lib/changes.mjs";
import { writeRssFeeds } from "./lib/rss.mjs";

import { scrapeBiontech } from "./adapters/biontech.mjs";
import { scrapeWorkday } from "./adapters/workday.mjs";
import { scrapeGskPlaywright } from "./adapters/gsk-playwright.mjs";

function isJobValid(job) {
  return Boolean(cleanText(job.title) && job.url && job.company?.id);
}

function uniqById(items) {
  return Array.from(new Map(items.map((x) => [x.id, x])).values());
}

async function scrapeOneSite(site) {
  const ctx = { company: site.company };

  if (site.kind === "biontech_html") {
    return await scrapeBiontech(ctx);
  }

  if (site.kind === "workday") {
    const wd = site.workday;
    return await scrapeWorkday({ company: site.company, host: wd.host, tenant: wd.tenant, site: wd.site });
  }

  if (site.kind === "gsk_playwright") {
    return await scrapeGskPlaywright({ company: site.company, startUrl: site.company.careersUrl });
  }

  throw new Error(`Unknown site.kind: ${site.kind}`);
}

async function main() {
  // Load previously committed dataset (if present) for change tracking.
  const PUBLIC_DIR = path.join(process.cwd(), "public");
  let previousJobs = [];
  let previousMeta = null;
  try {
    previousJobs = JSON.parse(await readFile(path.join(PUBLIC_DIR, "jobs.json"), "utf8"));
  } catch {
    previousJobs = [];
  }
  try {
    previousMeta = JSON.parse(await readFile(path.join(PUBLIC_DIR, "jobs-meta.json"), "utf8"));
  } catch {
    previousMeta = null;
  }

  const all = [];
  const sourceCounts = {};
  const filteredOutNonDeEn = {};

  const limit = createLimiter(2); // be polite; Playwright is heavy

  for (const site of sites) {
    console.log(`Scraping: ${site.company.name} (${site.kind})`);
    try {
      const jobs = await limit(async () => await scrapeOneSite(site));
      const good = jobs.filter(isJobValid);

      const { kept, removed } = filterJobsGermanEnglish(good);
      console.log(`  -> ${kept.length} jobs (filtered out ${removed.length} non-DE/EN)`);

      sourceCounts[site.company.id] = kept.length;
      filteredOutNonDeEn[site.company.id] = removed.length;

      all.push(...kept);
    } catch (e) {
      console.error(`  !! failed: ${e.message}`);
      sourceCounts[site.company.id] = 0;
      filteredOutNonDeEn[site.company.id] = 0;
    }
  }

  // Attach skills (stack) to each job for later filtering and RSS.
  const withSkills = await Promise.all(uniqById(all).map((j) => attachSkills(j)));

  const jobs = withSkills.sort((a, b) => {
    return a.company.name.localeCompare(b.company.name) || a.title.localeCompare(b.title);
  });

  const meta = {
    scrapedAt: new Date().toISOString(),
    total: jobs.length,
    sources: sourceCounts,
    filteredOutNonDeEn
  };

  await writeFile("public/jobs.json", JSON.stringify(jobs, null, 2));
  await writeFile("public/jobs.csv", toCsv(jobs));
  await writeFile("public/jobs-meta.json", JSON.stringify(meta, null, 2));

  // Change tracking (new/updated/removed)
  const changes = computeChanges({
    previousJobs,
    currentJobs: jobs,
    previousScrapedAt: previousMeta?.scrapedAt ?? null,
    currentScrapedAt: meta.scrapedAt
  });
  await writeFile("public/changes.json", JSON.stringify(changes, null, 2));

  // RSS feeds
  await writeRssFeeds(jobs);

  console.log(`Done. Wrote ${jobs.length} total jobs.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
