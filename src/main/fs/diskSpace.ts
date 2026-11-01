import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

/** Free bytes on the volume holding `target`, or null when the OS will not say. */
export async function freeBytes(target: string): Promise<number | null> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const info = await statfs(current);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Total size of the files under `directory`; 0 when it does not exist. */
export async function directorySize(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}
