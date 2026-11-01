import { randomUUID } from "node:crypto";
import { LayaError } from "@shared/result.ts";

const LIFETIME_MS = 10 * 60 * 1000;

/**
 * Folder choices made in the main process are handed to the window as tokens, so the window can
 * confirm a choice but never send a path of its own.
 */
export class LocationTokens {
  private readonly tokens = new Map<string, { path: string; expires: number }>();

  issue(path: string): string {
    this.sweep();
    const token = randomUUID();
    this.tokens.set(token, { path, expires: Date.now() + LIFETIME_MS });
    return token;
  }

  take(token: string): string {
    this.sweep();
    const entry = this.tokens.get(token);
    if (!entry) throw new LayaError("INVALID", "That folder choice has expired. Choose the folder again.");
    this.tokens.delete(token);
    return entry.path;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) if (entry.expires < now) this.tokens.delete(token);
  }
}
