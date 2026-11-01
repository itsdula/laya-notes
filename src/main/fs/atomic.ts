import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Windows refuses a rename while antivirus or a sync client briefly holds the file open. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE.has(code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

/** Temporary files start with a dot so listings, Finder and Explorer skip them. */
export function temporaryPath(filePath: string): string {
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
}

/** Writes beside the target, then renames, so a crash never leaves a half-written file. */
export async function writeAtomic(filePath: string, data: string): Promise<void> {
  const temporary = temporaryPath(filePath);
  try {
    await writeFile(temporary, data, "utf8");
    await renameWithRetry(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function moveAtomic(from: string, to: string): Promise<void> {
  await renameWithRetry(from, to);
}

export type JsonRead = { kind: "missing" } | { kind: "ok"; value: unknown } | { kind: "corrupt"; reason: string } | { kind: "unreadable"; reason: string };

export async function readJsonSafe(filePath: string): Promise<JsonRead> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: code ?? "unknown error" };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { kind: "corrupt", reason: error instanceof Error ? error.message : "invalid JSON" };
  }
}

/** Renames a damaged file aside instead of deleting it. Returns the new path. */
export async function quarantine(filePath: string, now = new Date()): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const destination = `${filePath}.bad-${stamp}`;
  await renameWithRetry(filePath, destination);
  return destination;
}

/**
 * Checks write access by writing a file. `fs.access` is not enough: it ignores Windows ACLs and can
 * report success on read-only network and sync drives.
 */
export async function probeWritable(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.laya-write-test-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(probe, "", { flag: "wx" });
    await unlink(probe);
    return true;
  } catch {
    await unlink(probe).catch(() => undefined);
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}

export async function exists(target: string): Promise<boolean> {
  return access(target, constants.F_OK).then(
    () => true,
    () => false,
  );
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
