import type { z } from "zod";
import { isChannel, requests, type Channel, type Output } from "@shared/ipc.ts";
import { fail, isLayaError, ok, type Result } from "@shared/result.ts";
import { log } from "../log.ts";

type ParsedInput<C extends Channel> = z.output<(typeof requests)[C]["input"]>;
export type Handler<C extends Channel> = (input: ParsedInput<C>) => Promise<Output<C>> | Output<C>;

/**
 * Every request goes through `dispatch`: unknown channels and malformed input are refused, and
 * whatever the handler throws comes back as a failed Result instead of an exception.
 */
export class IpcRouter {
  private readonly handlers = new Map<Channel, Handler<Channel>>();

  handle<C extends Channel>(channel: C, handler: Handler<C>): void {
    this.handlers.set(channel, handler as unknown as Handler<Channel>);
  }

  missing(): Channel[] {
    return (Object.keys(requests) as Channel[]).filter((channel) => !this.handlers.has(channel));
  }

  async dispatch(channel: unknown, input: unknown): Promise<Result<unknown>> {
    if (!isChannel(channel)) return fail("INVALID", "Unknown request.");
    const handler = this.handlers.get(channel);
    if (!handler) return fail("INVALID", "Unknown request.");
    const parsed = requests[channel].input.safeParse(input);
    if (!parsed.success) {
      log.warn("invalid request", { channel, issues: parsed.error.issues.map((issue) => issue.message) });
      return fail("INVALID", "The request was not valid.");
    }
    try {
      return ok(await handler(parsed.data as never));
    } catch (error) {
      if (isLayaError(error)) return { ok: false, error: error.toInfo() };
      log.error(`request ${channel} failed`, error);
      return fail("INTERNAL", "Something went wrong. Details were written to the log.");
    }
  }
}
