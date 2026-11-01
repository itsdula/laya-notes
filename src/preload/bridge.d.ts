import type { LayaBridge } from "../shared/ipc.ts";

declare global {
  interface Window {
    laya: LayaBridge;
  }
}

export {};
