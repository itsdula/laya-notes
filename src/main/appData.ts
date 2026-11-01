import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppDataState } from "@shared/health.ts";
import { probeWritable } from "./fs/atomic.ts";

export type AppPaths = {
  userData: string;
  models: string;
  logs: string;
  settingsFile: string;
};

export function appPaths(userData: string): AppPaths {
  return {
    userData,
    models: path.join(userData, "models"),
    logs: path.join(userData, "logs"),
    settingsFile: path.join(userData, "settings.json"),
  };
}

export type AppDataCheck = { state: AppDataState; writable: boolean };

const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/**
 * Makes sure the app's private folders exist and can be written. Never throws: a failure lowers the
 * state to `degraded`, and the app keeps running with settings held in memory.
 */
export async function checkAppData(paths: AppPaths, keepModelRevision: string): Promise<AppDataCheck> {
  const notices: string[] = [];
  try {
    for (const directory of [paths.userData, paths.models, paths.logs]) {
      await mkdir(directory, { recursive: true });
    }
  } catch (error) {
    return {
      state: { status: "degraded", reason: `The app's data folder could not be created (${codeOf(error)}).`, notices },
      writable: false,
    };
  }
  if (!(await probeWritable(paths.userData))) {
    return {
      state: { status: "degraded", reason: "The app's data folder cannot be written to. Settings will not be saved.", notices },
      writable: false,
    };
  }
  await removeStaleTemporaryFiles(paths.userData);
  const removed = await removeOtherModelRevisions(paths.models, keepModelRevision);
  if (removed > 0) notices.push("An older copy of the Laya model was removed to free disk space.");
  return { state: { status: "ok", notices }, writable: true };
}

async function removeStaleTemporaryFiles(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > STALE_TEMP_MS) await unlink(file).catch(() => undefined);
  }
}

/** Model folders are named after the pinned revision; any other revision is left over from an update. */
async function removeOtherModelRevisions(modelsDir: string, keep: string): Promise<number> {
  const entries = await readdir(modelsDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep || !/^[0-9a-f]{40}$/.test(entry.name)) continue;
    await rm(path.join(modelsDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown error";
}
