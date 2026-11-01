import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultInstructions, normalizeTag, sanitizeFolder, sanitizeTitle } from "@shared/names.ts";
import { LayaError } from "@shared/result.ts";
import type { Folder, LibraryListing, Note, NoteSummary, Tag } from "@shared/types.ts";
import { exists, isInside, moveAtomic, temporaryPath, writeAtomic } from "../fs/atomic.ts";
import { isMarkdown } from "./location.ts";
import { TagIndex, type TagIndexData } from "./TagIndex.ts";

export type SampleSet = { files: Record<string, string>; customTags: Tag[] };

export type NotesStoreOptions = {
  readOnly?: boolean;
  /** How files and folders are deleted. The app passes the OS trash; tests delete for real. */
  remove?: (target: string) => Promise<void>;
};

const NOTE_GONE = "That note is no longer available.";
const FOLDER_GONE = "That folder is no longer available.";
const TAG_GONE = "That tag is no longer available.";

/**
 * The notes folder: one Markdown file per note, one level of folders, and tags in `.laya-tags.json`.
 * Operations run one at a time, so two requests never interleave their reads and writes.
 */
export class NotesStore {
  readonly directory: string;
  readonly readOnly: boolean;
  private readonly index: TagIndex;
  private readonly remove: (target: string) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private notices: string[] = [];

  constructor(directory: string, options: NotesStoreOptions = {}) {
    this.directory = path.resolve(directory);
    this.readOnly = options.readOnly ?? false;
    this.index = new TagIndex(this.directory);
    this.remove = options.remove ?? ((target) => rm(target, { recursive: true, force: true }));
  }

  list(): Promise<LibraryListing> {
    return this.run(async () => {
      const index = await this.loadIndex();
      const folders: Folder[] = [{ name: "" }];
      const notes: NoteSummary[] = [];
      let nestedFolders = 0;
      for (const entry of await this.readEntries(this.directory)) {
        if (entry.isDirectory) {
          folders.push({ name: entry.name });
          for (const child of await this.readEntries(path.join(this.directory, entry.name))) {
            if (child.isDirectory) nestedFolders += 1;
            else if (isMarkdown(child.name)) {
              const summary = await this.summaryOf(`${entry.name}/${child.name}`, index).catch(() => null);
              if (summary) notes.push(summary);
            }
          }
        } else if (isMarkdown(entry.name)) {
          const summary = await this.summaryOf(entry.name, index).catch(() => null);
          if (summary) notes.push(summary);
        }
      }
      folders.sort((a, b) => (!a.name ? -1 : !b.name ? 1 : compareNames(a.name, b.name)));
      notes.sort((a, b) => compareNames(a.title, b.title));
      const ids = new Set(notes.map((note) => note.id));
      const notices = this.notices;
      this.notices = [];
      return {
        path: this.directory,
        rootTitle: path.basename(this.directory),
        readOnly: this.readOnly,
        folders,
        notes,
        tags: catalogOf(index),
        missingTagged: Object.keys(index.notes).filter((id) => !ids.has(id)).length,
        nestedFolders,
        notices,
      };
    });
  }

  read(id: string): Promise<Note> {
    return this.run(async () => {
      const index = await this.loadIndex();
      const summary = await this.summaryOf(id, index);
      const text = await readFile(this.resolveNote(id), "utf8");
      return { ...summary, text };
    });
  }

  create(folder: string): Promise<NoteSummary> {
    return this.write(async () => {
      const directory = await this.requireFolder(folder);
      const destination = await this.uniqueFile(directory, "Untitled", ".md");
      await writeFile(destination, "", { encoding: "utf8", flag: "wx" });
      return this.summaryOf(this.idFor(destination), await this.loadIndex());
    });
  }

  /**
   * Writes the editor's text. Refuses with CONFLICT when the file changed on disk since `baseModified`,
   * unless `force` is set. With `force`, a note deleted outside the app is written again.
   */
  save(id: string, text: string, baseModified: number | null, force = false): Promise<NoteSummary> {
    return this.write(async () => {
      const filePath = this.resolveNote(id);
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        if (!force) throw new LayaError("NOT_FOUND", "This note was deleted or renamed outside Laya Notes.");
        await this.requireFolder(this.folderOf(id));
      } else {
        if (!force && baseModified !== null && info.mtimeMs !== baseModified) {
          throw new LayaError("CONFLICT", "This note was changed outside Laya Notes since you opened it.");
        }
        const current = await readFile(filePath, "utf8");
        if (current === text) return this.summaryOf(id, await this.loadIndex());
      }
      await writeAtomic(filePath, text);
      return this.summaryOf(id, await this.loadIndex());
    });
  }

  rename(id: string, title: string): Promise<NoteSummary> {
    return this.write(async () => {
      const filePath = await this.requireNote(id);
      const extension = path.extname(filePath);
      const wanted = path.join(path.dirname(filePath), `${sanitizeTitle(title)}${extension}`);
      if (wanted === filePath) return this.summaryOf(id, await this.loadIndex());
      let destination: string;
      if (await sameFile(wanted, filePath)) {
        // Only the letter case changed, on a disk that ignores case.
        const temporary = temporaryPath(filePath);
        await moveAtomic(filePath, temporary);
        await moveAtomic(temporary, wanted);
        destination = wanted;
      } else {
        destination = await this.uniqueFile(path.dirname(filePath), sanitizeTitle(title), extension);
        await moveAtomic(filePath, destination);
      }
      const nextId = this.idFor(destination);
      await this.rekey(id, nextId);
      return this.summaryOf(nextId, await this.loadIndex());
    });
  }

  move(id: string, folder: string): Promise<NoteSummary> {
    return this.write(async () => {
      const filePath = await this.requireNote(id);
      if (this.folderOf(id) === folder) return this.summaryOf(id, await this.loadIndex());
      const directory = await this.requireFolder(folder);
      const extension = path.extname(filePath);
      const destination = await this.uniqueFile(directory, path.basename(filePath, extension), extension);
      await moveAtomic(filePath, destination);
      const nextId = this.idFor(destination);
      await this.rekey(id, nextId);
      return this.summaryOf(nextId, await this.loadIndex());
    });
  }

  delete(id: string): Promise<void> {
    return this.write(async () => {
      await this.remove(await this.requireNote(id));
      const index = await this.loadIndex();
      if (index.notes[id]) {
        delete index.notes[id];
        await this.index.save(index);
      }
    });
  }

  createFolder(raw: string): Promise<Folder> {
    return this.write(async () => {
      if (!raw.trim()) throw new LayaError("INVALID", "Enter a folder name.");
      const destination = await this.uniqueFile(this.directory, sanitizeFolder(raw), "");
      await mkdir(destination);
      return { name: path.basename(destination) };
    });
  }

  renameFolder(name: string, raw: string): Promise<Folder> {
    return this.write(async () => {
      if (!name) throw new LayaError("INVALID", "The notes folder itself cannot be renamed here.");
      if (!raw.trim()) throw new LayaError("INVALID", "Enter a folder name.");
      const current = await this.requireFolder(name);
      const cleaned = sanitizeFolder(raw);
      if (cleaned === name) return { name };
      const destination = path.join(this.directory, cleaned);
      this.assertInside(destination);
      if (await sameFile(destination, current)) {
        const temporary = temporaryPath(current);
        await moveAtomic(current, temporary);
        await moveAtomic(temporary, destination);
      } else {
        if (await exists(destination)) throw new LayaError("CONFLICT", "That folder name is already in use.");
        await moveAtomic(current, destination);
      }
      const index = await this.loadIndex();
      const prefix = `${name}/`;
      let changed = false;
      for (const key of Object.keys(index.notes)) {
        if (!key.startsWith(prefix)) continue;
        const tags = index.notes[key];
        delete index.notes[key];
        if (tags) index.notes[`${cleaned}/${key.slice(prefix.length)}`] = tags;
        changed = true;
      }
      if (changed) await this.index.save(index);
      return { name: cleaned };
    });
  }

  deleteFolder(name: string): Promise<void> {
    return this.write(async () => {
      if (!name) throw new LayaError("INVALID", "The notes folder itself cannot be deleted here.");
      await this.remove(await this.requireFolder(name));
      const index = await this.loadIndex();
      const prefix = `${name}/`;
      const keys = Object.keys(index.notes).filter((key) => key.startsWith(prefix));
      for (const key of keys) delete index.notes[key];
      if (keys.length > 0) await this.index.save(index);
    });
  }

  addNoteTag(id: string, raw: string): Promise<NoteSummary> {
    return this.write(async () => {
      const name = normalizeTag(raw);
      if (!name) throw new LayaError("INVALID", "Use letters or numbers in the tag name.");
      await this.requireNote(id);
      const index = await this.loadIndex();
      await this.writeTags(index, id, [...(index.notes[id] ?? []), name]);
      return this.summaryOf(id, index);
    });
  }

  removeNoteTag(id: string, tag: string): Promise<NoteSummary> {
    return this.write(async () => {
      await this.requireNote(id);
      const index = await this.loadIndex();
      await this.writeTags(
        index,
        id,
        (index.notes[id] ?? []).filter((item) => item !== tag),
      );
      return this.summaryOf(id, index);
    });
  }

  setNoteTags(id: string, tags: string[]): Promise<NoteSummary> {
    return this.write(async () => {
      await this.requireNote(id);
      const index = await this.loadIndex();
      await this.writeTags(
        index,
        id,
        tags.flatMap((tag) => normalizeTag(tag) ?? []),
      );
      return this.summaryOf(id, index);
    });
  }

  createTag(rawName: string, instructions: string): Promise<Tag> {
    return this.write(async () => {
      const name = normalizeTag(rawName);
      if (!name) throw new LayaError("INVALID", "Use letters or numbers in the tag name.");
      const index = await this.loadIndex();
      if (catalogOf(index).some((tag) => tag.name === name)) throw new LayaError("CONFLICT", "That tag name is already in use.");
      const tag = { name, instructions: instructions.trim() || defaultInstructions(name) };
      index.customTags.push(tag);
      await this.index.save(index);
      return tag;
    });
  }

  updateTag(name: string, nextName: string | undefined, instructions: string | undefined): Promise<Tag> {
    return this.write(async () => {
      const index = await this.loadIndex();
      materializeCatalog(index);
      const current = index.customTags.find((tag) => tag.name === name);
      if (!current) throw new LayaError("NOT_FOUND", TAG_GONE);
      if (nextName !== undefined) {
        const normalized = normalizeTag(nextName);
        if (!normalized) throw new LayaError("INVALID", "Use letters or numbers in the tag name.");
        if (normalized !== name) {
          if (index.customTags.some((tag) => tag.name === normalized)) throw new LayaError("CONFLICT", "That tag name is already in use.");
          current.name = normalized;
          for (const [key, tags] of Object.entries(index.notes)) {
            index.notes[key] = [...new Set(tags.map((tag) => (tag === name ? normalized : tag)))].sort();
          }
        }
      }
      if (instructions !== undefined && instructions.trim()) current.instructions = instructions.trim();
      await this.index.save(index);
      return { ...current };
    });
  }

  deleteTag(name: string): Promise<void> {
    return this.write(async () => {
      const index = await this.loadIndex();
      materializeCatalog(index);
      const next = index.customTags.filter((tag) => tag.name !== name);
      if (next.length === index.customTags.length) throw new LayaError("NOT_FOUND", TAG_GONE);
      index.customTags = next;
      for (const key of Object.keys(index.notes)) {
        const tags = index.notes[key]?.filter((tag) => tag !== name) ?? [];
        if (tags.length === 0) delete index.notes[key];
        else index.notes[key] = tags;
      }
      await this.index.save(index);
    });
  }

  /** Removes tag entries for notes that are not in the folder. Only runs when the person asks. */
  cleanupMissingTags(): Promise<number> {
    return this.write(async () => {
      const index = await this.loadIndex();
      let removed = 0;
      for (const key of Object.keys(index.notes)) {
        const present = await stat(this.resolveNote(key))
          .then((info) => info.isFile())
          .catch(() => false);
        if (present) continue;
        delete index.notes[key];
        removed += 1;
      }
      if (removed > 0) await this.index.save(index);
      return removed;
    });
  }

  tagTargets(ids?: string[]): Promise<{ notes: { id: string; title: string }[]; catalog: Tag[] }> {
    return this.list().then((listing) => {
      const wanted = ids ? new Set(ids) : null;
      return {
        notes: listing.notes.filter((note) => !wanted || wanted.has(note.id)).map((note) => ({ id: note.id, title: note.title })),
        catalog: listing.tags,
      };
    });
  }

  /** Adds the example notes that are missing, and the example tags when there are no tags yet. */
  seed(samples: SampleSet): Promise<void> {
    return this.write(async () => {
      for (const [relative, text] of Object.entries(samples.files)) {
        const destination = path.join(this.directory, ...relative.split("/"));
        this.assertInside(destination);
        if (await exists(destination)) continue;
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, text, { encoding: "utf8", flag: "wx" }).catch(() => undefined);
      }
      const index = await this.loadIndex();
      if (index.customTags.length === 0) {
        index.customTags = samples.customTags.map((tag) => ({ ...tag }));
        await this.index.save(index);
      }
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch((error: unknown) => {
      throw translateError(error);
    });
  }

  private write<T>(task: () => Promise<T>): Promise<T> {
    if (this.readOnly) return Promise.reject(new LayaError("READ_ONLY", "The notes folder is read-only, so changes cannot be saved."));
    return this.run(task);
  }

  private async loadIndex(): Promise<TagIndexData> {
    const { data, notice } = await this.index.load();
    if (notice && !this.notices.includes(notice)) this.notices.push(notice);
    return data;
  }

  private async writeTags(index: TagIndexData, id: string, tags: string[]): Promise<void> {
    const unique = [...new Set(tags)].sort();
    if (unique.length === 0) delete index.notes[id];
    else index.notes[id] = unique;
    materializeCatalog(index);
    await this.index.save(index);
  }

  private async rekey(from: string, to: string): Promise<void> {
    if (from === to) return;
    const index = await this.loadIndex();
    const tags = index.notes[from];
    if (!tags) return;
    delete index.notes[from];
    index.notes[to] = tags;
    await this.index.save(index);
  }

  private async summaryOf(id: string, index: TagIndexData): Promise<NoteSummary> {
    const filePath = this.resolveNote(id);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new LayaError("NOT_FOUND", NOTE_GONE);
    return {
      id,
      title: path.basename(filePath, path.extname(filePath)),
      folder: this.folderOf(id),
      tags: index.notes[id] ?? [],
      modified: info.mtimeMs,
      size: info.size,
    };
  }

  private folderOf(id: string): string {
    const slash = id.lastIndexOf("/");
    return slash === -1 ? "" : id.slice(0, slash);
  }

  private resolveNote(id: string): string {
    if (!isMarkdown(id) || id.includes("\\") || id.includes("\0")) throw new LayaError("NOT_FOUND", NOTE_GONE);
    const parts = id.split("/");
    if (parts.length > 2 || parts.some((part) => !part || part.startsWith("."))) throw new LayaError("NOT_FOUND", NOTE_GONE);
    const filePath = path.join(this.directory, ...parts);
    this.assertInside(filePath);
    return filePath;
  }

  private async requireNote(id: string): Promise<string> {
    const filePath = this.resolveNote(id);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new LayaError("NOT_FOUND", NOTE_GONE);
    return filePath;
  }

  private async requireFolder(folder: string): Promise<string> {
    if (!folder) return this.directory;
    if (folder.includes("/") || folder.includes("\\") || folder.includes("\0") || folder.startsWith(".")) {
      throw new LayaError("NOT_FOUND", FOLDER_GONE);
    }
    const directory = path.join(this.directory, folder);
    this.assertInside(directory);
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) throw new LayaError("NOT_FOUND", FOLDER_GONE);
    return directory;
  }

  private assertInside(target: string): void {
    if (!isInside(this.directory, target)) throw new LayaError("INVALID", "That path is outside the notes folder.");
  }

  private idFor(filePath: string): string {
    return path.relative(this.directory, filePath).split(path.sep).join("/");
  }

  /** `Untitled.md`, then `Untitled 2.md`, and so on. */
  private async uniqueFile(directory: string, base: string, extension: string): Promise<string> {
    for (let count = 1; count <= 10_000; count += 1) {
      const candidate = path.join(directory, `${count === 1 ? base : `${base} ${count}`}${extension}`);
      this.assertInside(candidate);
      if (!(await exists(candidate))) return candidate;
    }
    return path.join(directory, `${randomUUID()}${extension}`);
  }

  private async readEntries(directory: string): Promise<{ name: string; isDirectory: boolean }[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/** Tags used on notes but missing from the catalog get a default question. */
function catalogOf(index: TagIndexData): Tag[] {
  const catalog = new Map(index.customTags.map((tag) => [tag.name, tag]));
  for (const tags of Object.values(index.notes)) {
    for (const name of tags) if (!catalog.has(name)) catalog.set(name, { name, instructions: defaultInstructions(name) });
  }
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function materializeCatalog(index: TagIndexData): void {
  index.customTags = catalogOf(index);
}

/** True when both paths name the same file, e.g. `welcome.md` and `Welcome.md` on a case-insensitive disk. */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a, { bigint: true }).catch(() => null), stat(b, { bigint: true }).catch(() => null)]);
  return !!first && !!second && first.dev === second.dev && first.ino === second.ino;
}

function translateError(error: unknown): unknown {
  if (error instanceof LayaError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new LayaError("NOT_FOUND", "A file or folder Laya Notes expected is missing.");
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new LayaError("READ_ONLY", "Laya Notes does not have permission to change that file.");
  if (code === "ENOSPC") return new LayaError("NO_SPACE", "The disk is full.");
  if (code === "EEXIST") return new LayaError("CONFLICT", "A file with that name already exists.");
  return error;
}
