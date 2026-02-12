function escapeCsv(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(jobs) {
  const headers = [
    "id",
    "companyId",
    "companyName",
    "title",
    "location",
    "locations",
    "skills",
    "workplace",
    "workplaceRaw",
    "employmentType",
    "timeType",
    "department",
    "jobFamily",
    "jobCategory",
    "jobType",
    "reqId",
    "team",
    "url",
    "applyUrl",
    "postedAt",
    "scrapedAt"
  ];

  const lines = [
    headers.join(","),
    ...jobs.map((j) => {
      const row = {
        id: j.id,
        companyId: j.company.id,
        companyName: j.company.name,
        title: j.title,
        location: j.location,
        locations: Array.isArray(j.locations) ? j.locations.join(" | ") : "",
        skills: Array.isArray(j.skills) ? j.skills.join(" | ") : "",
        workplace: j.workplace,
        workplaceRaw: j.workplaceRaw,
        employmentType: j.employmentType,
        timeType: j.timeType,
        department: j.department,
        jobFamily: j.jobFamily,
        jobCategory: j.jobCategory,
        jobType: j.jobType,
        reqId: j.reqId,
        team: j.team,
        url: j.url,
        applyUrl: j.applyUrl,
        postedAt: j.postedAt,
        scrapedAt: j.scrapedAt
      };
      return headers.map((h) => escapeCsv(row[h])).join(",");
    })
  ];

  return lines.join("\n") + "\n";
}
