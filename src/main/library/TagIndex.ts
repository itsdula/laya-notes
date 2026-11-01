import path from "node:path";
import { normalizeTag } from "@shared/names.ts";
import type { Tag } from "@shared/types.ts";
import { quarantine, readJsonSafe, writeAtomic } from "../fs/atomic.ts";

export const TAG_INDEX_FILE = ".laya-tags.json";

export type TagIndexData = {
  /** Note id (relative path) to its tag names. */
  notes: Record<string, string[]>;
  customTags: Tag[];
};

export type TagIndexLoad = { data: TagIndexData; notice: string | null };

export function emptyIndex(): TagIndexData {
  return { notes: {}, customTags: [] };
}

/**
 * Reads and writes `.laya-tags.json`. A missing file is an empty index. A damaged file is set aside
 * and replaced by an empty index, so one bad file never blocks the whole library.
 */
export class TagIndex {
  constructor(private readonly directory: string) {}

  get file(): string {
    return path.join(this.directory, TAG_INDEX_FILE);
  }

  async load(): Promise<TagIndexLoad> {
    const read = await readJsonSafe(this.file);
    if (read.kind === "missing") return { data: emptyIndex(), notice: null };
    if (read.kind === "unreadable") {
      return { data: emptyIndex(), notice: `The tag file could not be read (${read.reason}). Tags are hidden until it can be.` };
    }
    if (read.kind === "corrupt") {
      const backup = await quarantine(this.file).catch(() => null);
      return {
        data: emptyIndex(),
        notice: backup
          ? `The tag file was damaged and has been set aside as ${path.basename(backup)}. Tags start empty.`
          : "The tag file is damaged. Tags start empty.",
      };
    }
    return { data: parseIndex(read.value), notice: null };
  }

  async save(data: TagIndexData): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Keeps every well-formed entry and drops the rest. */
export function parseIndex(value: unknown): TagIndexData {
  const data = emptyIndex();
  if (!value || typeof value !== "object" || Array.isArray(value)) return data;
  const record = value as { notes?: unknown; customTags?: unknown };
  if (record.notes && typeof record.notes === "object" && !Array.isArray(record.notes)) {
    for (const [key, tags] of Object.entries(record.notes)) {
      if (!Array.isArray(tags)) continue;
      const clean = [...new Set(tags.flatMap((tag) => (typeof tag === "string" ? (normalizeTag(tag) ?? []) : [])))].sort();
      if (clean.length > 0) data.notes[key] = clean;
    }
  }
  if (Array.isArray(record.customTags)) {
    const seen = new Set<string>();
    for (const tag of record.customTags) {
      if (!tag || typeof tag !== "object") continue;
      const name = normalizeTag(String((tag as { name?: unknown }).name ?? ""));
      const instructions = (tag as { instructions?: unknown }).instructions;
      if (!name || seen.has(name) || typeof instructions !== "string") continue;
      seen.add(name);
      data.customTags.push({ name, instructions });
    }
  }
  return data;
}
