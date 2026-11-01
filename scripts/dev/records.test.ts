import { describe, expect, it } from "vitest";
import { classifyLine, decodeOtlpLogs, lineSplitter } from "./records.ts";

describe("classifyLine", () => {
  it("reads the app's structured records", () => {
    const line = `laya:log ${JSON.stringify({ time: "2026-11-01T00:00:00.000Z", level: "warn", source: "worker", message: "slow", detail: { ms: 900 } })}`;
    expect(classifyLine(line, "stdout")).toEqual({
      severity: "warn",
      source: "worker",
      body: "slow",
      attributes: { "log.iostream": "stdout", "laya.detail": '{"ms":900}' },
      time: Date.parse("2026-11-01T00:00:00.000Z"),
    });
  });

  it("recognizes Chromium, Vite and Forge lines and strips color codes", () => {
    expect(classifyLine("[123:1101/031000.123456:ERROR:gpu_init.cc(1)] GPU failed", "stderr")).toMatchObject({ severity: "error", source: "electron", body: "GPU failed" });
    expect(classifyLine("\u001b[32m3:08:46 AM\u001b[39m [vite] page reload", "stdout")).toMatchObject({ source: "vite", body: "3:08:46 AM [vite] page reload" });
    expect(classifyLine("✔ Checking your system", "stdout")).toMatchObject({ source: "forge", severity: "info" });
    expect(classifyLine("✖ Running preStart hook", "stdout")).toMatchObject({ source: "forge", severity: "error" });
  });

  it("treats other stderr as a warning unless it reads like an error, and skips blank lines", () => {
    expect(classifyLine("(node:1) DeprecationWarning: x", "stderr")).toMatchObject({ severity: "warn" });
    expect(classifyLine("TypeError: boom", "stderr")).toMatchObject({ severity: "error" });
    expect(classifyLine("compiled with 0 errors", "stdout")).toMatchObject({ severity: "info" });
    expect(classifyLine("Uncaught error in main", "stderr")).toMatchObject({ severity: "error" });
    expect(classifyLine("   ", "stdout")).toBeNull();
  });
});

describe("lineSplitter", () => {
  it("joins lines split across chunks and handles carriage returns", () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));
    splitter.push("one\ntw");
    splitter.push("o\r\nthree\rfour");
    splitter.end();
    expect(lines).toEqual(["one", "two", "three", "four"]);
  });
});

describe("decodeOtlpLogs", () => {
  it("flattens an OTLP/HTTP JSON request", () => {
    let id = 0;
    const records = decodeOtlpLogs(
      {
        resourceLogs: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "laya-notes-dev" } }] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1793491840000000000",
                    severityNumber: 17,
                    body: { stringValue: "failed" },
                    attributes: [
                      { key: "laya.source", value: { stringValue: "main" } },
                      { key: "attempt", value: { intValue: "2" } },
                      { key: "meta", value: { kvlistValue: { values: [{ key: "ok", value: { boolValue: false } }] } } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      () => ++id,
    );
    expect(records).toEqual([
      {
        id: 1,
        time: 1793491840000,
        severity: "error",
        source: "main",
        body: "failed",
        attributes: { attempt: 2, meta: { ok: false }, "service.name": "laya-notes-dev" },
      },
    ]);
  });

  it("ignores payloads that are not OTLP logs", () => {
    expect(decodeOtlpLogs({ nope: true }, () => 1)).toEqual([]);
    expect(decodeOtlpLogs(null, () => 1)).toEqual([]);
  });
});
