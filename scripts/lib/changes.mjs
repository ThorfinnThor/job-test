import crypto from "node:crypto";

function hashText(s) {
  const h = crypto.createHash("sha1");
  h.update(String(s ?? ""));
  return h.digest("hex");
}

function jobSummary(job) {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location ?? null,
    url: job.url,
    applyUrl: job.applyUrl ?? null,
    postedAt: job.postedAt ?? null,
    scrapedAt: job.scrapedAt,
    skills: Array.isArray(job.skills) ? job.skills : []
  };
}

function signature(job) {
  return {
    title: job.title ?? "",
    location: job.location ?? "",
    applyUrl: job.applyUrl ?? "",
    workplace: job.workplace ?? null,
    employmentType: job.employmentType ?? null,
    timeType: job.timeType ?? null,
    postedAt: job.postedAt ?? null,
    descHash: hashText(job.description?.text ?? ""),
    skillsHash: hashText((Array.isArray(job.skills) ? job.skills : []).join("|"))
  };
}

function diffFields(aSig, bSig) {
  const fields = [];
  for (const k of Object.keys(aSig)) {
    if (aSig[k] !== bSig[k]) {
      if (k === "descHash") fields.push("description");
      else if (k === "skillsHash") fields.push("skills");
      else fields.push(k);
    }
  }
  // de-dupe and stable
  return Array.from(new Set(fields)).sort((x, y) => x.localeCompare(y));
}

export function computeChanges({ previousJobs, currentJobs, previousScrapedAt = null, currentScrapedAt = null }) {
  const prevById = new Map((previousJobs || []).map((j) => [j.id, j]));
  const currById = new Map((currentJobs || []).map((j) => [j.id, j]));

  const added = [];
  const removed = [];
  const updated = [];

  for (const [id, curr] of currById.entries()) {
    const prev = prevById.get(id);
    if (!prev) {
      added.push(jobSummary(curr));
      continue;
    }

    const fields = diffFields(signature(prev), signature(curr));
    if (fields.length) {
      updated.push({ before: jobSummary(prev), after: jobSummary(curr), fields });
    }
  }

  for (const [id, prev] of prevById.entries()) {
    if (!currById.has(id)) removed.push(jobSummary(prev));
  }

  // Sort for stable output
  added.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || "") || a.title.localeCompare(b.title));
  removed.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || "") || a.title.localeCompare(b.title));
  updated.sort((a, b) => (b.after.postedAt || "").localeCompare(a.after.postedAt || "") || a.after.title.localeCompare(b.after.title));

  return {
    generatedAt: new Date().toISOString(),
    previousScrapedAt,
    currentScrapedAt,
    counts: { new: added.length, updated: updated.length, removed: removed.length },
    new: added,
    updated,
    removed
  };
}
