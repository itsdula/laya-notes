import { describe, expect, it } from "vitest";
import { LayaError } from "@shared/result.ts";
import { IpcRouter } from "./router.ts";

describe("IpcRouter", () => {
  it("refuses unknown channels", async () => {
    const router = new IpcRouter();
    expect(await router.dispatch("fs:readEverything", {})).toEqual({ ok: false, error: { code: "INVALID", message: "Unknown request." } });
  });

  it("validates input before calling the handler", async () => {
    const router = new IpcRouter();
    let called = false;
    router.handle("note:read", () => {
      called = true;
      throw new Error("unreachable");
    });
    const result = await router.dispatch("note:read", { id: 42 });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("turns thrown errors into failed results", async () => {
    const router = new IpcRouter();
    router.handle("note:delete", () => {
      throw new LayaError("NOT_FOUND", "gone");
    });
    router.handle("note:create", () => {
      throw new Error("disk exploded");
    });
    expect(await router.dispatch("note:delete", { id: "a.md" })).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "gone" } });
    const internal = await router.dispatch("note:create", { folder: "" });
    expect(internal).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("rejects settings fields the window may not change", async () => {
    const router = new IpcRouter();
    router.handle("settings:update", () => undefined as never);
    const result = await router.dispatch("settings:update", { notesDir: "/etc" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });
});
