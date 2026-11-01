import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ModelInfo, ModelState } from "@shared/health.ts";
import { LayaError } from "@shared/result.ts";
import type { Tag } from "@shared/types.ts";
import type { FromWorker, WorkerHandle } from "../../model-worker/protocol.ts";
import { directorySize, freeBytes } from "../fs/diskSpace.ts";
import { log } from "../log.ts";
import { bundleDirectory, bundleTotal, checkBundle, type ModelBundle } from "./bundle.ts";
import { DownloadCancelled, downloadBundle, type DownloadOptions } from "./download.ts";

export type ModelServiceOptions = {
  modelsDir: string;
  bundle: ModelBundle;
  startWorker: () => WorkerHandle;
  onChange: (info: ModelInfo) => void;
  reuseFrom?: string[];
  download?: typeof downloadBundle;
  fetchImpl?: DownloadOptions["fetchImpl"];
};

/** Two crashes in a row usually mean the machine cannot run the model; stop retrying until restart. */
const MAX_CONSECUTIVE_CRASHES = 2;
const SPACE_MARGIN = 1.1;

/**
 * The one source of truth for the model's state:
 * absent → downloading → present → loading → ready, with partial, verifying and error on the side.
 */
export class ModelService {
  private state: ModelState;
  private free: number | null = null;
  private used = 0;
  private onDisk = false;
  private worker: WorkerHandle | null = null;
  private loading: Promise<void> | null = null;
  private download: AbortController | null = null;
  private crashes = 0;
  private readonly pending = new Map<string, { resolve: (value: Record<string, number>) => void; reject: (error: Error) => void }>();
  private loadWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly options: ModelServiceOptions) {
    this.state = { status: "absent", totalBytes: bundleTotal(options.bundle) };
  }

  get directory(): string {
    return bundleDirectory(this.options.modelsDir, this.options.bundle);
  }

  info(): ModelInfo {
    return {
      state: this.state,
      directory: this.directory,
      revision: this.options.bundle.revision,
      totalBytes: bundleTotal(this.options.bundle),
      diskBytes: this.used,
      freeBytes: this.free,
    };
  }

  /** Reads the model's state from disk. Cheap: file sizes only. */
  async check(): Promise<ModelInfo> {
    this.free = await freeBytes(this.options.modelsDir);
    this.used = await directorySize(this.directory);
    if (["downloading", "verifying", "loading", "ready"].includes(this.state.status)) return this.publish();
    const result = await checkBundle(this.directory, this.options.bundle);
    this.onDisk = result.status === "present";
    if (this.state.status === "error" && !this.state.retryable) return this.publish();
    const total = bundleTotal(this.options.bundle);
    if (result.status === "present") this.state = { status: "present" };
    else if (result.status === "partial") this.state = { status: "partial", bytes: result.bytes, totalBytes: total };
    else this.state = { status: "absent", totalBytes: total };
    return this.publish();
  }

  /** True once every model file is on disk and verified. */
  get filesPresent(): boolean {
    return this.onDisk;
  }

  async startDownload(): Promise<void> {
    if (this.download || this.state.status === "downloading" || this.state.status === "verifying") return;
    if (this.onDisk) return;
    const total = bundleTotal(this.options.bundle);
    const have = this.state.status === "partial" ? this.state.bytes : 0;
    this.free = await freeBytes(this.options.modelsDir);
    if (this.free !== null && this.free < (total - have) * SPACE_MARGIN) {
      throw new LayaError("NO_SPACE", `Laya needs about ${formatGb((total - have) * SPACE_MARGIN)} of free space; this disk has ${formatGb(this.free)}.`);
    }
    const controller = new AbortController();
    this.download = controller;
    this.setState({ status: "downloading", file: "", bytes: have, totalBytes: total });
    void (this.options.download ?? downloadBundle)(this.directory, this.options.bundle, {
      signal: controller.signal,
      reuseFrom: this.options.reuseFrom,
      fetchImpl: this.options.fetchImpl,
      onProgress: ({ file, bytes, totalBytes }) => this.setState({ status: "downloading", file, bytes, totalBytes }),
      onVerify: ({ file, bytes, totalBytes }) => this.setState({ status: "verifying", file, bytes, totalBytes }),
    })
      .then(async () => {
        log.info("model downloaded");
        this.onDisk = true;
        this.state = { status: "present" };
        await this.check();
      })
      .catch(async (error: unknown) => {
        if (error instanceof DownloadCancelled) {
          log.info("model download cancelled");
        } else {
          log.warn("model download failed", error);
        }
        await this.check();
        if (!(error instanceof DownloadCancelled)) {
          this.setState({ status: "error", reason: error instanceof Error ? error.message : "The download failed.", retryable: true });
        }
      })
      .finally(() => {
        this.download = null;
      });
  }

  cancelDownload(): void {
    this.download?.abort();
  }

  /** Loads the model in the worker if it is not loaded yet. */
  ensureLoaded(): Promise<void> {
    if (this.state.status === "ready" && this.worker) return Promise.resolve();
    if (this.loading) return this.loading;
    if (this.state.status === "error" && !this.state.retryable) return Promise.reject(new LayaError("MODEL_UNAVAILABLE", this.state.reason));
    if (!this.onDisk) {
      return Promise.reject(new LayaError("MODEL_UNAVAILABLE", "Download Laya before asking it to tag notes."));
    }
    this.setState({ status: "loading" });
    this.loading = new Promise<void>((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      const worker = this.spawn();
      worker.send({ type: "load", modelDir: this.directory });
    }).finally(() => {
      this.loading = null;
      this.loadWaiter = null;
    });
    return this.loading;
  }

  async score(note: { title: string; text: string }, tags: Tag[]): Promise<Record<string, number>> {
    await this.ensureLoaded();
    const worker = this.worker;
    if (!worker) throw new LayaError("MODEL_UNAVAILABLE", "Laya stopped unexpectedly.");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.send({ type: "score", requestId, note, tags });
    });
  }

  async deleteModel(): Promise<void> {
    this.cancelDownload();
    this.unload();
    await rm(this.directory, { recursive: true, force: true });
    this.onDisk = false;
    this.crashes = 0;
    this.state = { status: "absent", totalBytes: bundleTotal(this.options.bundle) };
    await this.check();
  }

  unload(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.send({ type: "unload" });
      worker.kill();
    }
    if (this.state.status === "ready" || this.state.status === "loading") this.setState({ status: "present" });
  }

  dispose(): void {
    this.cancelDownload();
    this.unload();
  }

  private spawn(): WorkerHandle {
    const worker = this.options.startWorker();
    this.worker = worker;
    worker.onMessage((message) => this.onWorkerMessage(worker, message));
    worker.onExit((code) => this.onWorkerExit(worker, code));
    return worker;
  }

  private onWorkerMessage(worker: WorkerHandle, message: FromWorker): void {
    if (worker !== this.worker) return;
    switch (message.type) {
      case "loaded":
        this.crashes = 0;
        this.setState({ status: "ready" });
        this.loadWaiter?.resolve();
        break;
      case "loadFailed":
        log.error("model failed to load", message.message);
        this.worker = null;
        worker.kill();
        this.setState({ status: "error", reason: `Laya could not load: ${message.message}`, retryable: true });
        this.loadWaiter?.reject(new LayaError("MODEL_UNAVAILABLE", `Laya could not load: ${message.message}`));
        break;
      case "scored":
        this.pending.get(message.requestId)?.resolve(message.probabilities);
        this.pending.delete(message.requestId);
        break;
      case "scoreFailed":
        this.pending.get(message.requestId)?.reject(new LayaError("MODEL_UNAVAILABLE", message.message));
        this.pending.delete(message.requestId);
        break;
    }
  }

  private onWorkerExit(worker: WorkerHandle, code: number): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.crashes += 1;
    log.error("model worker exited", { code, crashes: this.crashes });
    const error = new LayaError("MODEL_UNAVAILABLE", "Laya stopped unexpectedly.");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.loadWaiter?.reject(error);
    const retryable = this.crashes < MAX_CONSECUTIVE_CRASHES;
    this.setState({
      status: "error",
      reason: retryable
        ? "Laya stopped unexpectedly. It will start again the next time you tag a note."
        : "Laya stopped unexpectedly twice. This computer may not have enough memory to run it. Restart the app to try again.",
      retryable,
    });
  }

  private setState(state: ModelState): void {
    this.state = state;
    this.publish();
  }

  private publish(): ModelInfo {
    const info = this.info();
    this.options.onChange(info);
    return info;
  }
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
