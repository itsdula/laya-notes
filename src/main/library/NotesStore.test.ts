import { chmod, mkdir, readFile, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectCode, temporaryDirectory } from "../testing.ts";
import { NotesStore } from "./NotesStore.ts";
import { SAMPLES } from "./samples.ts";
import { TAG_INDEX_FILE } from "./TagIndex.ts";

let directory: string;
let cleanup: () => Promise<void>;
let store: NotesStore;

beforeEach(async () => {
  ({ path: directory, cleanup } = await temporaryDirectory());
  store = new NotesStore(directory);
});

afterEach(async () => {
  await chmod(directory, 0o755).catch(() => undefined);
  await cleanup();
});

describe("NotesStore", () => {
  it("seeds the example notes and tags once", async () => {
    await store.seed(SAMPLES);
    const listing = await store.list();
    expect(listing.notes.map((note) => note.id)).toContain("Welcome.md");
    expect(listing.notes.map((note) => note.id)).toContain("Trips/Tokyo Weekend.md");
    expect(listing.tags.map((tag) => tag.name)).toContain("cooking");

    await store.deleteTag("cooking");
    await store.seed(SAMPLES);
    expect((await store.list()).tags.map((tag) => tag.name)).not.toContain("cooking");
  });

  it("creates, saves, renames, moves and deletes a note", async () => {
    const folder = await store.createFolder("Garden");
    const created = await store.create(folder.name);
    expect(created.id).toBe("Garden/Untitled.md");

    const saved = await store.save(created.id, "Tomato notes", created.modified);
    expect((await store.read(saved.id)).text).toBe("Tomato notes");

    const renamed = await store.rename(saved.id, "Tomatoes");
    expect(renamed.id).toBe("Garden/Tomatoes.md");

    const tagged = await store.addNoteTag(renamed.id, "Garden Plans");
    expect(tagged.tags).toEqual(["garden-plans"]);

    const moved = await store.move(renamed.id, "");
    expect(moved.id).toBe("Tomatoes.md");
    expect(moved.tags).toEqual(["garden-plans"]);

    await store.delete(moved.id);
    expect((await store.list()).notes).toHaveLength(0);
  });

  it("refuses to overwrite a note changed outside the app", async () => {
    const note = await store.create("");
    await writeFile(path.join(directory, note.id), "edited in another app");
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(directory, note.id), later, later);
    await expectCode(store.save(note.id, "mine", note.modified), "CONFLICT");
    const forced = await store.save(note.id, "mine", note.modified, true);
    expect((await store.read(forced.id)).text).toBe("mine");
  });

  it("writes a deleted note again only when forced", async () => {
    const note = await store.create("");
    await store.delete(note.id);
    await expectCode(store.save(note.id, "text", note.modified), "NOT_FOUND");
    await store.save(note.id, "text", note.modified, true);
    expect((await store.read(note.id)).text).toBe("text");
  });

  it("renames when only the letter case changes", async () => {
    const note = await store.create("");
    const lower = await store.rename(note.id, "welcome");
    const upper = await store.rename(lower.id, "Welcome");
    expect(upper.id).toBe("Welcome.md");
    expect(await readdir(directory)).toContain("Welcome.md");
    expect((await store.list()).notes).toHaveLength(1);
  });

  it("gives a second note with the same title a number", async () => {
    await store.rename((await store.create("")).id, "Ideas");
    const second = await store.rename((await store.create("")).id, "Ideas");
    expect(second.id).toBe("Ideas 2.md");
  });

  it("keeps tags when a note disappears from the folder", async () => {
    const note = await store.addNoteTag((await store.create("")).id, "travel");
    await rename(path.join(directory, note.id), path.join(directory, "Renamed in Finder.md"));
    const listing = await store.list();
    expect(listing.missingTagged).toBe(1);
    const index = JSON.parse(await readFile(path.join(directory, TAG_INDEX_FILE), "utf8"));
    expect(index.notes["Untitled.md"]).toEqual(["travel"]);

    expect(await store.cleanupMissingTags()).toBe(1);
    expect((await store.list()).missingTagged).toBe(0);
  });

  it("sets a damaged tag file aside and keeps working", async () => {
    await store.create("");
    await writeFile(path.join(directory, TAG_INDEX_FILE), "{ not json");
    const listing = await store.list();
    expect(listing.notes).toHaveLength(1);
    expect(listing.tags).toEqual([]);
    expect(listing.notices[0]).toContain("set aside");
    expect((await readdir(directory)).some((name) => name.startsWith(`${TAG_INDEX_FILE}.bad-`))).toBe(true);
    expect((await store.list()).notices).toEqual([]);
  });

  it("renames a folder and moves its tags along", async () => {
    await store.seed(SAMPLES);
    await store.addNoteTag("Trips/Tokyo Weekend.md", "travel");
    await store.renameFolder("Trips", "Journeys");
    const note = (await store.list()).notes.find((item) => item.id === "Journeys/Tokyo Weekend.md");
    expect(note?.tags).toEqual(["travel"]);
  });

  it("renames and deletes tags across notes", async () => {
    const note = await store.addNoteTag((await store.create("")).id, "trip");
    await store.updateTag("trip", "Travel", "Is this about travel?");
    expect((await store.read(note.id)).tags).toEqual(["travel"]);
    await store.deleteTag("travel");
    expect((await store.read(note.id)).tags).toEqual([]);
  });

  it("refuses paths outside the notes folder", async () => {
    await expectCode(store.save("../package.json", "nope", null), "NOT_FOUND");
    await expectCode(store.read("Trips/../../secret.md"), "NOT_FOUND");
    await expectCode(store.create("../elsewhere"), "NOT_FOUND");
  });

  it("does not show nested folders, but counts them", async () => {
    await mkdir(path.join(directory, "Trips", "2024"), { recursive: true });
    await writeFile(path.join(directory, "Trips", "2024", "Deep.md"), "deep");
    const listing = await store.list();
    expect(listing.nestedFolders).toBe(1);
    expect(listing.notes).toHaveLength(0);
  });

  it("refuses every change when read-only", async () => {
    await store.create("");
    const readOnly = new NotesStore(directory, { readOnly: true });
    expect((await readOnly.list()).readOnly).toBe(true);
    await expectCode(readOnly.create(""), "READ_ONLY");
    await expectCode(readOnly.save("Untitled.md", "x", null), "READ_ONLY");
  });

  it("does not rewrite a file whose text is unchanged", async () => {
    const note = await store.save((await store.create("")).id, "same", null);
    const before = (await stat(path.join(directory, note.id))).mtimeMs;
    const again = await store.save(note.id, "same", note.modified);
    expect(again.modified).toBe(before);
  });
});
