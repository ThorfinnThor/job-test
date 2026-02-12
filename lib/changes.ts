import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChangesFile } from "./types";

const PUBLIC_DIR = path.join(process.cwd(), "public");

export async function getChanges(): Promise<ChangesFile | null> {
  try {
    const p = path.join(PUBLIC_DIR, "changes.json");
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as ChangesFile;
  } catch {
    return null;
  }
}
