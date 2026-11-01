import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../fs/atomic.ts";

export type BundleFile = {
  path: string;
  size: number;
  /** Large files are stored with Git LFS and identified by SHA-256. */
  sha256?: string;
  /** Small files are identified by their Git blob hash. */
  gitSha1?: string;
};

/**
 * The exact model this build uses. Pinning the revision means a launch never asks Hugging Face
 * whether something changed, and tagging behaves the same until the app itself is updated.
 */
export const MODEL_BUNDLE = {
  repo: "receptron/laya-onnx",
  revision: "d42786bdff8a7550316339c5fbf8f46caa83ea1b",
  files: [
    { path: "laya.onnx", size: 3_807_291, sha256: "a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e" },
    { path: "laya.onnx.data", size: 1_685_258_240, sha256: "487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba" },
    { path: "laya_config.json", size: 355, gitSha1: "3a095180e18b08b39dce31e5b592a432abc082f4" },
    { path: "tokenizer/tokenizer.json", size: 3_583_228, gitSha1: "2f4d8583e507b7466d2490e2d6c045647a822698" },
    { path: "tokenizer/tokenizer_config.json", size: 308, gitSha1: "9fd800115c5c92353220aa66addfce67a9135f32" },
  ] satisfies BundleFile[],
};

export type ModelBundle = { repo: string; revision: string; files: BundleFile[] };

export const MARKER_FILE = ".verified.json";

export function bundleTotal(bundle: ModelBundle): number {
  return bundle.files.reduce((sum, file) => sum + file.size, 0);
}

export function bundleDirectory(modelsDir: string, bundle: ModelBundle): string {
  return path.join(modelsDir, bundle.revision);
}

export function partPath(filePath: string): string {
  return `${filePath}.part`;
}

export type BundleCheck = { status: "absent" } | { status: "partial"; bytes: number } | { status: "present" };

type Marker = { revision: string; files: Record<string, { size: number; mtimeMs: number }> };

/**
 * Looks at the files only: no network, no hashing, no model loading. `present` needs every file at its
 * expected size and unchanged since it was last verified.
 */
export async function checkBundle(directory: string, bundle: ModelBundle): Promise<BundleCheck> {
  const marker = await readMarker(directory);
  let bytes = 0;
  let complete = true;
  let anything = false;
  for (const file of bundle.files) {
    const full = path.join(directory, file.path);
    const info = await stat(full).catch(() => null);
    if (info?.isFile() && info.size === file.size) {
      anything = true;
      bytes += file.size;
      const recorded = marker?.files[file.path];
      if (!recorded || recorded.size !== info.size || recorded.mtimeMs !== info.mtimeMs) complete = false;
      continue;
    }
    complete = false;
    if (info) anything = true;
    const part = await stat(partPath(full)).catch(() => null);
    if (part?.isFile()) {
      anything = true;
      bytes += Math.min(part.size, file.size);
    }
  }
  if (complete && marker?.revision === bundle.revision) return { status: "present" };
  return anything ? { status: "partial", bytes } : { status: "absent" };
}

export async function writeMarker(directory: string, bundle: ModelBundle): Promise<void> {
  const marker: Marker = { revision: bundle.revision, files: {} };
  for (const file of bundle.files) {
    const info = await stat(path.join(directory, file.path));
    marker.files[file.path] = { size: info.size, mtimeMs: info.mtimeMs };
  }
  await writeAtomic(path.join(directory, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

async function readMarker(directory: string): Promise<Marker | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, MARKER_FILE), "utf8")) as Marker;
    return parsed && typeof parsed.revision === "string" && parsed.files && typeof parsed.files === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Compares a file's content with the hash published for it. `onRead` receives the bytes hashed so far. */
export async function verifyFile(filePath: string, file: BundleFile, signal?: AbortSignal, onRead?: (bytes: number) => void): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size !== file.size) return false;
  const hash = createHash(file.sha256 ? "sha256" : "sha1");
  if (!file.sha256) hash.update(`blob ${file.size}\0`);
  let read = 0;
  for await (const chunk of createReadStream(filePath, { signal })) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
    onRead?.(read);
  }
  const digest = hash.digest("hex");
  return digest === (file.sha256 ?? file.gitSha1);
}
