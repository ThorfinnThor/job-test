export type Workplace = "remote" | "hybrid" | "onsite" | null;
export type EmploymentType = "full_time" | "part_time" | "contract" | "internship" | "temporary" | null;

export type Job = {
  id: string;

  company: {
    id: string;
    name: string;
    careersUrl: string;
  };

  title: string;
  location: string | null;
  /** All known locations for the posting (deduped, best-effort). */
  locations?: string[];
  workplace: Workplace;
  /** Raw workplace label from Workday (e.g. "Flex", "Hybrid", "Remote"), if present. */
  workplaceRaw?: string | null;
  employmentType: EmploymentType;
  /** Raw time type label from Workday (e.g. "Full time", "Vollzeit"), if present. */
  timeType?: string | null;
  department: string | null;
  jobFamily?: string | null;
  jobCategory?: string | null;
  jobType?: string | null;
  reqId?: string | null;
  team: string | null;

  url: string;
  applyUrl: string | null;

  description: {
    text: string | null;
    html: string | null;
  };

  /** Extracted skill/stack tags based on title + description text. */
  skills?: string[];

  source: {
    kind: "biontech_html" | "workday_api" | "gsk_playwright" | "html" | "playwright" | "unknown";
    raw?: any;
  };

  postedAt: string | null;
  scrapedAt: string;
};

export type JobSummary = {
  id: string;
  company: Job["company"];
  title: string;
  location: string | null;
  url: string;
  applyUrl: string | null;
  postedAt: string | null;
  scrapedAt: string;
  skills: string[];
};

export type JobUpdate = {
  before: JobSummary;
  after: JobSummary;
  fields: string[];
};

export type ChangesFile = {
  generatedAt: string;
  previousScrapedAt: string | null;
  currentScrapedAt: string | null;
  counts: { new: number; updated: number; removed: number };
  new: JobSummary[];
  updated: JobUpdate[];
  removed: JobSummary[];
};

export type JobsMeta = {
  scrapedAt: string;
  total: number;
  sources: Record<string, number>;
  filteredOutNonDeEn?: Record<string, number>;
};
