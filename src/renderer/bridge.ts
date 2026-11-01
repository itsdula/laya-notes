import type { Channel, EventName, Events, InvokeArgs, Output } from "@shared/ipc.ts";
import type { ErrorCode } from "@shared/result.ts";

/** A failed request, carrying the main process's error code. */
export class BridgeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export async function call<C extends Channel>(channel: C, ...args: InvokeArgs<C>): Promise<Output<C>> {
  const result = await window.laya.invoke(channel, ...args);
  if (!result.ok) throw new BridgeError(result.error.code, result.error.message);
  return result.value;
}

export function subscribe<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void {
  return window.laya.on(event, listener);
}

export function isCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof BridgeError && error.code === code;
}

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

export const platform = window.laya.platform;
export const isMac = platform === "darwin";
export const fileManagerName = isMac ? "Finder" : platform === "win32" ? "File Explorer" : "the file manager";
