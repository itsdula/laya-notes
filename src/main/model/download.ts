import { constants, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LayaError } from "@shared/result.ts";
import { bundleTotal, partPath, verifyFile, writeMarker, type BundleFile, type ModelBundle } from "./bundle.ts";

export type DownloadProgress = { file: string; bytes: number; totalBytes: number };

export type DownloadOptions = {
  signal: AbortSignal;
  /** Bytes of the whole bundle that are in place. */
  onProgress: (progress: DownloadProgress) => void;
  /** Bytes of one file checked against its hash so far. */
  onVerify: (progress: DownloadProgress) => void;
  /** Other folders that may already hold some of these files, e.g. the cache of an earlier version. */
  reuseFrom?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const PROGRESS_INTERVAL_MS = 250;

/**
 * Puts every bundle file into `directory`, verified against its published hash. Files already there,
 * or reusable from another folder, are not downloaded again. An interrupted download keeps its
 * `.part` file and continues from there next time.
 */
export async function downloadBundle(directory: string, bundle: ModelBundle, options: DownloadOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://huggingface.co";
  const totalBytes = bundleTotal(bundle);
  let done = 0;
  let lastReport = 0;
  const throttled = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return false;
    lastReport = now;
    return true;
  };
  const report = (file: string, bytes: number, force = false) => {
    if (throttled(force)) options.onProgress({ file, bytes, totalBytes });
  };
  const verify = (candidate: string, file: BundleFile) => {
    options.onVerify({ file: file.path, bytes: 0, totalBytes: file.size });
    throttled(true);
    return verifyFile(candidate, file, options.signal, (bytes) => {
      if (throttled(false)) options.onVerify({ file: file.path, bytes, totalBytes: file.size });
    });
  };

  for (const file of bundle.files) {
    throwIfAborted(options.signal);
    const destination = path.join(directory, file.path);
    await mkdir(path.dirname(destination), { recursive: true });

    if (await existsWithSize(destination, file.size)) {
      if (await verify(destination, file)) {
        done += file.size;
        report(file.path, done, true);
        continue;
      }
      await unlink(destination);
    }

    if (await reuse(file, destination, options.reuseFrom ?? [], verify)) {
      done += file.size;
      report(file.path, done, true);
      continue;
    }

    await fetchToPart(file, destination, `${baseUrl}/${bundle.repo}/resolve/${bundle.revision}/${file.path}`, fetchImpl, options.signal, (received) =>
      report(file.path, done + received),
    );
    const part = partPath(destination);
    if (!(await verify(part, file))) {
      await unlink(part).catch(() => undefined);
      throw new LayaError("INTERNAL", `${file.path} arrived damaged and was discarded. Try the download again.`);
    }
    await rename(part, destination);
    done += file.size;
    report(file.path, done, true);
  }
  await writeMarker(directory, bundle);
}

async function reuse(
  file: BundleFile,
  destination: string,
  folders: string[],
  verify: (candidate: string, file: BundleFile) => Promise<boolean>,
): Promise<boolean> {
  for (const folder of folders) {
    const candidate = path.join(folder, file.path);
    if (!(await existsWithSize(candidate, file.size))) continue;
    if (!(await verify(candidate, file))) continue;
    const part = partPath(destination);
    try {
      // A copy-on-write clone where the file system supports it, a normal copy otherwise.
      await copyFile(candidate, part, constants.COPYFILE_FICLONE);
      await rename(part, destination);
      return true;
    } catch {
      await unlink(part).catch(() => undefined);
    }
  }
  return false;
}

async function fetchToPart(
  file: BundleFile,
  destination: string,
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  onReceived: (bytes: number) => void,
): Promise<void> {
  const part = partPath(destination);
  let start = (await stat(part).catch(() => null))?.size ?? 0;
  if (start > file.size) {
    await unlink(part);
    start = 0;
  }
  if (start === file.size) return;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {}, redirect: "follow", signal });
  } catch (error) {
    throwIfAborted(signal);
    throw new LayaError("OFFLINE", `Could not reach Hugging Face to download Laya. Check the internet connection and try again. (${messageOf(error)})`);
  }
  if (response.status === 416 && start > 0) {
    await unlink(part);
    return fetchToPart(file, destination, url, fetchImpl, signal, onReceived);
  }
  if (!response.ok || !response.body) {
    throw new LayaError("INTERNAL", `Hugging Face answered ${response.status} ${response.statusText} for ${file.path}.`);
  }
  const resumed = response.status === 206 && start > 0;
  let received = resumed ? start : 0;
  onReceived(received);
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      onReceived(received);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, createWriteStream(part, { flags: resumed ? "a" : "w" }), {
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    throw new LayaError("OFFLINE", `The download stopped before ${file.path} finished. It will continue from here next time. (${messageOf(error)})`);
  }
}

async function existsWithSize(filePath: string, size: number): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  return !!info?.isFile() && info.size === size;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DownloadCancelled();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DownloadCancelled extends Error {
  constructor() {
    super("The download was cancelled.");
    this.name = "DownloadCancelled";
  }
}
