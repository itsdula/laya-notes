import type { Settings } from "./settings.ts";

export type AppDataState =
  | { status: "ok"; notices: string[] }
  /** userData cannot be written: settings live in memory for this session. */
  | { status: "degraded"; reason: string; notices: string[] };

export type LibraryState =
  /** First launch: no folder chosen yet. */
  | { status: "unset"; suggestedPath: string }
  | { status: "ready"; path: string }
  | { status: "readOnly"; path: string }
  /** The folder is gone. It is never recreated automatically: it may be an unplugged drive. */
  | { status: "missing"; path: string }
  | { status: "unusable"; path: string; reason: string };

export type ModelState =
  | { status: "absent"; totalBytes: number }
  | { status: "partial"; bytes: number; totalBytes: number }
  | { status: "downloading"; file: string; bytes: number; totalBytes: number }
  /** Checking a file against its published hash. `bytes` counts within that file. */
  | { status: "verifying"; file: string; bytes: number; totalBytes: number }
  | { status: "present" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; reason: string; retryable: boolean };

export type ModelInfo = {
  state: ModelState;
  directory: string;
  revision: string;
  totalBytes: number;
  /** What the model folder takes up right now, including unfinished downloads. */
  diskBytes: number;
  freeBytes: number | null;
};

export type HealthReport = {
  appData: AppDataState;
  library: LibraryState;
  model: ModelInfo;
  settings: Settings;
  platform: "darwin" | "win32" | "linux" | string;
};

export function libraryIsOpen(state: LibraryState): state is { status: "ready" | "readOnly"; path: string } {
  return state.status === "ready" || state.status === "readOnly";
}
