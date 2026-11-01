import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
/** Which process a record came from. */
export type LogSource = "main" | "worker" | "renderer";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Lines starting with this are structured records that `npm run dev` turns into OpenTelemetry logs. */
export const STRUCTURED_LOG_PREFIX = "laya:log ";
let logFile: string | null = null;
let pending: Promise<void> = Promise.resolve();

/** Packaged builds append to userData/logs; development prints to the terminal as well. */
export function configureLog(directory: string | null): void {
  logFile = directory ? path.join(directory, "laya-notes.log") : null;
}

function serialize(detail: unknown): unknown {
  return detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail;
}

export function writeLog(level: Level, message: string, detail?: unknown, source: LogSource = "main"): void {
  const record = {
    time: new Date().toISOString(),
    level,
    source,
    message,
    ...(detail === undefined ? {} : { detail: serialize(detail) }),
  };
  const line = JSON.stringify(record);
  if (process.env.LAYA_LOG_STDOUT === "json") {
    process.stdout.write(`${STRUCTURED_LOG_PREFIX}${line}\n`);
  } else if (!logFile || process.env.NODE_ENV === "development" || level === "error") {
    (level === "error" ? console.error : console.log)(`[laya:${source}] ${level} ${message}`, detail ?? "");
  }
  const file = logFile;
  if (!file) return;
  pending = pending
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      if (size > MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
      await appendFile(file, `${line}\n`, "utf8");
    })
    .catch(() => undefined);
}

export const log = {
  debug: (message: string, detail?: unknown) => writeLog("debug", message, detail),
  info: (message: string, detail?: unknown) => writeLog("info", message, detail),
  warn: (message: string, detail?: unknown) => writeLog("warn", message, detail),
  error: (message: string, detail?: unknown) => writeLog("error", message, detail),
};
