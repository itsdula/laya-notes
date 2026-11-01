import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LocationSummary } from "@shared/types.ts";
import { isInside, probeWritable } from "../fs/atomic.ts";
import { TAG_INDEX_FILE } from "./TagIndex.ts";

export type ForbiddenRule = { path: string; reason: string; match: "exact" | "inside" };

const SCAN_LIMIT = 2000;

/** Looks at a folder before it is used as the notes folder. Never creates or changes anything. */
export async function inspectLocation(directory: string, rules: ForbiddenRule[]): Promise<LocationSummary> {
  if (!path.isAbsolute(directory)) return { status: "forbidden", reason: "Choose a folder by its full path." };
  const resolved = path.resolve(directory);
  if (path.parse(resolved).root === resolved) {
    return { status: "forbidden", reason: "The top of a drive cannot be the notes folder. Choose or create a folder inside it." };
  }
  for (const rule of rules) {
    const hit = rule.match === "exact" ? path.resolve(rule.path) === resolved : isInside(rule.path, resolved);
    if (hit) return { status: "forbidden", reason: rule.reason };
  }

  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { status: "missing" } : { status: "unreadable" };
  }
  if (!info.isDirectory()) return { status: "notADirectory" };

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    return { status: "unreadable" };
  }

  let notes = 0;
  let folders = 0;
  let nestedFolders = 0;
  let otherEntries = 0;
  let hasIndex = false;
  for (const entry of entries.slice(0, SCAN_LIMIT)) {
    if (entry.name === TAG_INDEX_FILE) hasIndex = true;
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      folders += 1;
      const children = await readdir(path.join(resolved, entry.name), { withFileTypes: true }).catch(() => []);
      for (const child of children.slice(0, SCAN_LIMIT)) {
        if (child.name.startsWith(".") || child.isSymbolicLink()) continue;
        if (child.isDirectory()) nestedFolders += 1;
        else if (isMarkdown(child.name)) notes += 1;
      }
    } else if (isMarkdown(entry.name)) {
      notes += 1;
    } else {
      otherEntries += 1;
    }
  }

  const kind = hasIndex ? "library" : notes > 0 ? "markdown" : otherEntries > 0 || folders > 0 ? "other" : "empty";
  return {
    status: "ok",
    writable: await probeWritable(resolved),
    kind,
    notes,
    folders,
    nestedFolders,
    otherEntries,
  };
}

export function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}
