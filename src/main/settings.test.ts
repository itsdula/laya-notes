import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appPaths, checkAppData } from "./appData.ts";
import { SettingsStore } from "./settings.ts";
import { temporaryDirectory } from "./testing.ts";

let directory: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ path: directory, cleanup } = await temporaryDirectory());
});

afterEach(async () => {
  await cleanup();
});

describe("SettingsStore", () => {
  it("uses defaults when the file is missing", async () => {
    const store = new SettingsStore(path.join(directory, "settings.json"), true);
    expect(await store.load()).toEqual({ notices: [] });
    expect(store.get().notesDir).toBeNull();
  });

  it("sets a corrupt file aside and resets", async () => {
    const file = path.join(directory, "settings.json");
    await writeFile(file, "{{{");
    const store = new SettingsStore(file, true);
    const { notices } = await store.load();
    expect(notices[0]).toContain("damaged");
    expect((await readdir(directory)).some((name) => name.startsWith("settings.json.bad-"))).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });

  it("keeps valid fields from a partly damaged file", async () => {
    const file = path.join(directory, "settings.json");
    await writeFile(file, JSON.stringify({ version: 1, notesDir: "/notes", theme: { mode: "neon" } }));
    const store = new SettingsStore(file, true);
    const { notices } = await store.load();
    expect(store.get().notesDir).toBe("/notes");
    expect(store.get().theme.mode).toBe("system");
    expect(notices[0]).toContain("theme");
  });

  it("remembers recent folders, newest first", async () => {
    const store = new SettingsStore(path.join(directory, "settings.json"), true);
    await store.setNotesDir("/a");
    await store.setNotesDir("/b");
    await store.setNotesDir("/a");
    expect(store.get().recentNotesDirs).toEqual(["/a", "/b"]);
  });

  it("keeps changes in memory when it cannot persist", async () => {
    const file = path.join(directory, "settings.json");
    const store = new SettingsStore(file, false);
    await store.update({ confetti: false });
    expect(store.get().confetti).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("checkAppData", () => {
  it("creates the app folders and removes old model revisions", async () => {
    const paths = appPaths(path.join(directory, "userData"));
    const keep = "a".repeat(40);
    const old = "b".repeat(40);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(paths.models, old), { recursive: true });
    await mkdir(path.join(paths.models, keep), { recursive: true });
    const result = await checkAppData(paths, keep);
    expect(result.writable).toBe(true);
    expect(result.state.status).toBe("ok");
    expect(await readdir(paths.models)).toEqual([keep]);
    expect(result.state.notices).toHaveLength(1);
  });

  it("degrades instead of throwing when the folder cannot be created", async () => {
    const blocker = path.join(directory, "blocker");
    await writeFile(blocker, "");
    const result = await checkAppData(appPaths(path.join(blocker, "userData")), "a".repeat(40));
    expect(result.writable).toBe(false);
    expect(result.state.status).toBe("degraded");
  });
});
