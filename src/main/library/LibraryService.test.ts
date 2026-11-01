import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LibraryState } from "@shared/health.ts";
import { exists } from "../fs/atomic.ts";
import { SettingsStore } from "../settings.ts";
import { expectCode, temporaryDirectory } from "../testing.ts";
import { inspectLocation } from "./location.ts";
import { LibraryService } from "./LibraryService.ts";

let root: string;
let cleanup: () => Promise<void>;
let settings: SettingsStore;
let busy: boolean;
let states: LibraryState[];

function service(): LibraryService {
  return new LibraryService({
    settings,
    rules: [{ path: path.join(root, "userData"), match: "inside", reason: "private" }],
    suggestedPath: path.join(root, "Documents", "Laya Notes"),
    isBusy: () => busy,
    onState: (state) => states.push(state),
    onChanged: () => undefined,
  });
}

beforeEach(async () => {
  ({ path: root, cleanup } = await temporaryDirectory());
  await mkdir(path.join(root, "userData"));
  settings = new SettingsStore(path.join(root, "userData", "settings.json"), true);
  busy = false;
  states = [];
});

afterEach(async () => {
  await cleanup();
});

describe("LibraryService", () => {
  it("starts unset on first launch", async () => {
    const library = service();
    expect(await library.openFromSettings()).toEqual({ status: "unset", suggestedPath: path.join(root, "Documents", "Laya Notes") });
    expect(() => library.store()).toThrow();
  });

  it("creates the default folder and seeds samples when applied", async () => {
    await mkdir(path.join(root, "Documents"));
    const library = service();
    const target = path.join(root, "Documents", "Laya Notes");
    const state = await library.apply(target, "open", true);
    expect(state).toEqual({ status: "ready", path: target });
    expect(settings.get().notesDir).toBe(target);
    expect((await library.store().list()).notes.length).toBeGreaterThan(0);
    library.close();
  });

  it("does not seed a folder that already has notes", async () => {
    const target = path.join(root, "Existing");
    await mkdir(target);
    await writeFile(path.join(target, "Mine.md"), "mine");
    const library = service();
    await library.apply(target, "open", true);
    expect((await library.store().list()).notes.map((note) => note.id)).toEqual(["Mine.md"]);
    library.close();
  });

  it("reports a missing folder without creating it", async () => {
    const target = path.join(root, "Unplugged Drive", "Notes");
    await settings.setNotesDir(target);
    const library = service();
    expect(await library.openFromSettings()).toEqual({ status: "missing", path: target });
    expect(await exists(target)).toBe(false);
    await expectCode(library.recreate(), "LIBRARY_UNAVAILABLE");
    library.close();
  });

  it("recreates a missing folder when its parent exists and the person asks", async () => {
    const target = path.join(root, "Notes");
    await settings.setNotesDir(target);
    const library = service();
    await library.openFromSettings();
    expect(await library.recreate()).toEqual({ status: "ready", path: target });
    library.close();
  });

  it("moves notes into an empty folder and leaves the original", async () => {
    const from = path.join(root, "Old");
    const to = path.join(root, "New");
    await mkdir(from);
    await mkdir(to);
    const library = service();
    await library.apply(from, "open", true);
    await library.store().addNoteTag("Welcome.md", "journal");
    await library.apply(to, "move", false);
    expect(settings.get().notesDir).toBe(to);
    const moved = await library.store().list();
    expect(moved.notes.find((note) => note.id === "Welcome.md")?.tags).toEqual(["journal"]);
    expect(await readdir(from)).toContain("Welcome.md");
    library.close();
  });

  it("refuses to move into a folder that is not empty", async () => {
    const from = path.join(root, "Old");
    const to = path.join(root, "Busy");
    await mkdir(from);
    await mkdir(to);
    await writeFile(path.join(to, "Other.md"), "x");
    const library = service();
    await library.apply(from, "open", false);
    await expectCode(library.apply(to, "move", false), "CONFLICT");
    expect(settings.get().notesDir).toBe(from);
    library.close();
  });

  it("refuses to change folders while tagging", async () => {
    const library = service();
    busy = true;
    await expectCode(library.apply(path.join(root, "Any"), "open", false), "BUSY");
  });

  it("refuses the app's private folder", async () => {
    const library = service();
    await expectCode(library.apply(path.join(root, "userData", "notes"), "open", false), "INVALID");
  });

  it("reopens a folder that comes back", async () => {
    const target = path.join(root, "Comes Back");
    await mkdir(target);
    const library = service();
    await library.apply(target, "open", false);
    await rm(target, { recursive: true });
    expect((await library.open(target)).status).toBe("missing");
    await mkdir(target);
    expect((await library.retry()).status).toBe("ready");
    library.close();
  });
});

describe("inspectLocation", () => {
  it("describes what a folder holds", async () => {
    const target = path.join(root, "Look");
    await mkdir(path.join(target, "Trips", "Deep"), { recursive: true });
    await writeFile(path.join(target, "A.md"), "");
    await writeFile(path.join(target, "Trips", "B.md"), "");
    await writeFile(path.join(target, "photo.jpg"), "");
    expect(await inspectLocation(target, [])).toMatchObject({ status: "ok", kind: "markdown", notes: 2, folders: 1, nestedFolders: 1, otherEntries: 1, writable: true });
    await writeFile(path.join(target, ".laya-tags.json"), "{}");
    expect(await inspectLocation(target, [])).toMatchObject({ kind: "library" });
  });

  it("flags files, missing folders and drive roots", async () => {
    await writeFile(path.join(root, "file.txt"), "");
    expect(await inspectLocation(path.join(root, "file.txt"), [])).toEqual({ status: "notADirectory" });
    expect(await inspectLocation(path.join(root, "nope"), [])).toEqual({ status: "missing" });
    expect((await inspectLocation(path.parse(root).root, [])).status).toBe("forbidden");
  });
});
