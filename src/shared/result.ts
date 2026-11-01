export const ERROR_CODES = [
  "INVALID",
  "NOT_FOUND",
  "CONFLICT",
  "LIBRARY_UNAVAILABLE",
  "READ_ONLY",
  "MODEL_UNAVAILABLE",
  "BUSY",
  "NO_SPACE",
  "OFFLINE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorInfo = { code: ErrorCode; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Thrown inside the main process; the IPC router turns it into a failed Result. */
export class LayaError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "LayaError";
    this.code = code;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message };
  }
}

export function isLayaError(error: unknown): error is LayaError {
  return error instanceof LayaError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}
