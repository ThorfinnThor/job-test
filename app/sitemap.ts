import { getJobs } from "@/lib/jobs";
import type { MetadataRoute } from "next";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://example.vercel.app";
  const jobs = await getJobs();
  const now = new Date().toISOString();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "daily", priority: 0.3 },
    { url: `${base}/jobs`, lastModified: now, changeFrequency: "daily", priority: 1.0 },
    { url: `${base}/changes`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/rss.xml`, lastModified: now, changeFrequency: "daily", priority: 0.2 },
    ...Array.from(new Set(jobs.map((j) => j.company?.id).filter(Boolean))).map((companyId) => ({
      url: `${base}/rss/company/${encodeURIComponent(companyId)}.xml`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.1
    })),
    ...jobs.map((j) => ({
      url: `${base}/jobs/${encodeURIComponent(j.id)}`,
      lastModified: j.scrapedAt ?? now,
      changeFrequency: "daily" as const,
      priority: 0.7
    }))
  ];
}
