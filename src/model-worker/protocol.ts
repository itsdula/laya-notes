import type { Tag } from "@shared/types.ts";

export type ToWorker =
  | { type: "load"; modelDir: string }
  | { type: "score"; requestId: string; note: { title: string; text: string }; tags: Tag[] }
  | { type: "unload" };

export type FromWorker =
  | { type: "loaded" }
  | { type: "loadFailed"; message: string }
  | { type: "scored"; requestId: string; probabilities: Record<string, number> }
  | { type: "scoreFailed"; requestId: string; message: string };

/** What the main process needs from a worker; the Electron utility process and the tests both provide it. */
export interface WorkerHandle {
  send(message: ToWorker): void;
  onMessage(listener: (message: FromWorker) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}
