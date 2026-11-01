import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "@shared/health.ts";
import type { FromWorker, ToWorker, WorkerHandle } from "../../model-worker/protocol.ts";
import { expectCode, temporaryDirectory } from "../testing.ts";
import { checkBundle, partPath, type ModelBundle } from "./bundle.ts";
import { DownloadCancelled, downloadBundle } from "./download.ts";
import { ModelService } from "./ModelService.ts";

const big = Buffer.alloc(200_000, 7);
const small = Buffer.from('{"labels":2}');

const bundle: ModelBundle = {
  repo: "test/model",
  revision: "c".repeat(40),
  files: [
    { path: "weights.bin", size: big.length, sha256: createHash("sha256").update(big).digest("hex") },
    { path: "nested/config.json", size: small.length, gitSha1: createHash("sha1").update(`blob ${small.length}\0`).update(small).digest("hex") },
  ],
};

let directory: string;
let cleanup: () => Promise<void>;
let server: Server;
let baseUrl: string;
let requests: { url: string; range: string | undefined }[];
let failAfter: number | null;

beforeEach(async () => {
  ({ path: directory, cleanup } = await temporaryDirectory());
  requests = [];
  failAfter = null;
  server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", range: request.headers.range });
    const body = request.url?.endsWith("weights.bin") ? big : request.url?.endsWith("config.json") ? small : null;
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const match = /bytes=(\d+)-/.exec(request.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const slice = body.subarray(start);
    response.writeHead(match ? 206 : 200, { "Content-Length": slice.length });
    if (failAfter !== null && slice.length > failAfter) {
      response.write(slice.subarray(0, failAfter));
      setTimeout(() => response.destroy(), 20);
      return;
    }
    response.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
});

const quiet = { onProgress: () => undefined, onVerify: () => undefined };

describe("bundle download", () => {
  it("downloads, verifies and marks the bundle present", async () => {
    expect(await checkBundle(directory, bundle)).toEqual({ status: "absent" });
    await downloadBundle(directory, bundle, { ...quiet, signal: new AbortController().signal, baseUrl });
    expect(await checkBundle(directory, bundle)).toEqual({ status: "present" });
    expect(requests.map((request) => request.url)).toEqual([
      `/test/model/resolve/${bundle.revision}/weights.bin`,
      `/test/model/resolve/${bundle.revision}/nested/config.json`,
    ]);
  });

  it("reports download and hashing progress for each file", async () => {
    const downloaded: number[] = [];
    const checked: { file: string; bytes: number; totalBytes: number }[] = [];
    await downloadBundle(directory, bundle, {
      signal: new AbortController().signal,
      baseUrl,
      onProgress: ({ bytes }) => downloaded.push(bytes),
      onVerify: (progress) => checked.push(progress),
    });
    expect(downloaded.at(-1)).toBe(big.length + small.length);
    expect(checked[0]).toEqual({ file: "weights.bin", bytes: 0, totalBytes: big.length });
    expect(checked.map((progress) => progress.file)).toContain("nested/config.json");
  });

  it("continues an interrupted download with a range request", async () => {
    failAfter = 50_000;
    await expectCode(downloadBundle(directory, bundle, { ...quiet, signal: new AbortController().signal, baseUrl }), "OFFLINE");
    const partial = await checkBundle(directory, bundle);
    expect(partial.status).toBe("partial");
    const kept = (await stat(partPath(path.join(directory, "weights.bin")))).size;
    expect(kept).toBeGreaterThan(0);

    failAfter = null;
    await downloadBundle(directory, bundle, { ...quiet, signal: new AbortController().signal, baseUrl });
    expect(requests.at(-2)?.range).toBe(`bytes=${kept}-`);
    expect(await readFile(path.join(directory, "weights.bin"))).toEqual(big);
  });

  it("reuses verified files from another folder and ignores damaged ones", async () => {
    const legacy = path.join(directory, "legacy");
    await mkdir(path.join(legacy, "nested"), { recursive: true });
    await writeFile(path.join(legacy, "weights.bin"), big);
    await writeFile(path.join(legacy, "nested", "config.json"), Buffer.from('{"labels":9}'));
    const target = path.join(directory, "target");
    await downloadBundle(target, bundle, { ...quiet, signal: new AbortController().signal, baseUrl, reuseFrom: [legacy] });
    expect(requests.map((request) => request.url)).toEqual([`/test/model/resolve/${bundle.revision}/nested/config.json`]);
    expect(await checkBundle(target, bundle)).toEqual({ status: "present" });
  });

  it("discards a file whose content does not match its hash", async () => {
    const tampered: ModelBundle = { ...bundle, files: [{ ...bundle.files[0]!, sha256: "0".repeat(64) }] };
    await expectCode(downloadBundle(directory, tampered, { ...quiet, signal: new AbortController().signal, baseUrl }), "INTERNAL");
    expect(await checkBundle(directory, tampered)).toEqual({ status: "absent" });
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadBundle(directory, bundle, { ...quiet, signal: controller.signal, baseUrl })).rejects.toBeInstanceOf(DownloadCancelled);
  });

  it("reports a file changed after verification as partial", async () => {
    await downloadBundle(directory, bundle, { ...quiet, signal: new AbortController().signal, baseUrl });
    await writeFile(path.join(directory, "nested", "config.json"), Buffer.from('{"labels":3}'));
    expect((await checkBundle(directory, bundle)).status).toBe("partial");
  });
});

class FakeWorker implements WorkerHandle {
  sent: ToWorker[] = [];
  private messageListener: (message: FromWorker) => void = () => undefined;
  private exitListener: (code: number) => void = () => undefined;
  killed = false;

  send(message: ToWorker): void {
    this.sent.push(message);
  }
  onMessage(listener: (message: FromWorker) => void): void {
    this.messageListener = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }
  kill(): void {
    this.killed = true;
  }
  reply(message: FromWorker): void {
    this.messageListener(message);
  }
  crash(): void {
    this.exitListener(1);
  }
}

describe("ModelService", () => {
  let workers: FakeWorker[];
  let infos: ModelInfo[];

  async function presentService(): Promise<ModelService> {
    const service = new ModelService({
      modelsDir: directory,
      bundle,
      startWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      onChange: (info) => infos.push(info),
    });
    await downloadBundle(service.directory, bundle, { ...quiet, signal: new AbortController().signal, baseUrl });
    await service.check();
    return service;
  }

  beforeEach(() => {
    workers = [];
    infos = [];
  });

  it("refuses to load before the model is downloaded", async () => {
    const service = new ModelService({ modelsDir: directory, bundle, startWorker: () => new FakeWorker(), onChange: () => undefined });
    expect((await service.check()).state.status).toBe("absent");
    await expectCode(service.ensureLoaded(), "MODEL_UNAVAILABLE");
  });

  it("loads lazily, scores, and reports ready", async () => {
    const service = await presentService();
    expect(service.info().state).toEqual({ status: "present" });
    const loading = service.ensureLoaded();
    expect(service.info().state.status).toBe("loading");
    workers[0]!.reply({ type: "loaded" });
    await loading;
    expect(service.info().state.status).toBe("ready");

    const scoring = service.score({ title: "t", text: "x" }, [{ name: "travel", instructions: "?" }]);
    await Promise.resolve();
    const request = workers[0]!.sent.find((message) => message.type === "score");
    if (request?.type !== "score") throw new Error("no score request");
    workers[0]!.reply({ type: "scored", requestId: request.requestId, probabilities: { travel: 0.9 } });
    expect(await scoring).toEqual({ travel: 0.9 });
  });

  it("restarts after one crash and gives up after two in a row", async () => {
    const service = await presentService();
    const first = service.ensureLoaded();
    workers[0]!.crash();
    await expectCode(first, "MODEL_UNAVAILABLE");
    expect(service.info().state).toMatchObject({ status: "error", retryable: true });

    const second = service.ensureLoaded();
    workers[1]!.crash();
    await expectCode(second, "MODEL_UNAVAILABLE");
    expect(service.info().state).toMatchObject({ status: "error", retryable: false });
    await expectCode(service.ensureLoaded(), "MODEL_UNAVAILABLE");
    expect(workers).toHaveLength(2);
  });

  it("reports a load failure as a retryable error", async () => {
    const service = await presentService();
    const loading = service.ensureLoaded();
    workers[0]!.reply({ type: "loadFailed", message: "bad graph" });
    await expectCode(loading, "MODEL_UNAVAILABLE");
    expect(service.info().state).toMatchObject({ status: "error", retryable: true });
    expect(workers[0]!.killed).toBe(true);
  });

  it("measures the space the model uses and frees it on delete", async () => {
    const service = await presentService();
    await writeFile(path.join(service.directory, "stray.part"), Buffer.alloc(1_000));
    await service.check();
    const marker = (await stat(path.join(service.directory, ".verified.json"))).size;
    expect(service.info().diskBytes).toBe(big.length + small.length + marker + 1_000);

    await service.deleteModel();
    expect(service.info().state.status).toBe("absent");
    expect(service.info().diskBytes).toBe(0);
    expect(service.filesPresent).toBe(false);
  });
});
