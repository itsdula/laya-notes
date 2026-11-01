import { cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { LayaError } from "@shared/result.ts";

/**
 * Copies the whole notes folder into an empty folder and checks every file arrived at the same size.
 * The source is never changed. On failure, whatever was copied into the target is removed again.
 */
export async function copyLibrary(from: string, to: string): Promise<{ files: number }> {
  const skip = (source: string) => {
    const base = path.basename(source);
    return !(base.startsWith(".") && base.endsWith(".tmp"));
  };
  try {
    for (const entry of await readdir(from)) {
      const source = path.join(from, entry);
      if (!skip(source)) continue;
      await cp(source, path.join(to, entry), { recursive: true, errorOnExist: true, force: false, filter: skip, preserveTimestamps: true });
    }
    const expected = await listFiles(from, skip);
    const actual = await listFiles(to, skip);
    for (const [relative, size] of expected) {
      if (actual.get(relative) !== size) throw new LayaError("INTERNAL", `${relative} did not copy correctly.`);
    }
    return { files: expected.size };
  } catch (error) {
    for (const entry of await readdir(to).catch(() => [] as string[])) {
      await rm(path.join(to, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof LayaError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") throw new LayaError("NO_SPACE", "There is not enough space in the new folder.");
    throw new LayaError("INTERNAL", `The notes could not be copied (${code ?? "unknown error"}). Nothing was changed.`);
  }
}

async function listFiles(root: string, keep: (file: string) => boolean): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (!keep(full) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.set(path.relative(root, full).split(path.sep).join("/"), (await stat(full)).size);
    }
  };
  await walk(root);
  return files;
}
