export type Severity = "debug" | "info" | "warn" | "error";
export type AttributeValue = string | number | boolean;

/** One line of output, classified before it becomes an OpenTelemetry log record. */
export type ParsedLine = {
  severity: Severity;
  source: string;
  body: string;
  attributes: Record<string, AttributeValue>;
  time?: number;
};

/** What the monitor page shows, decoded from OTLP. */
export type MonitorRecord = {
  id: number;
  time: number;
  severity: Severity;
  source: string;
  body: string;
  attributes: Record<string, unknown>;
};

export const SEVERITY_NUMBER: Record<Severity, number> = { debug: 5, info: 9, warn: 13, error: 17 };

const STRUCTURED_PREFIX = "laya:log ";
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const CHROMIUM = /^\[\d+:\d+\/[\d.]+:(VERBOSE\d*|INFO|WARNING|ERROR|FATAL):[^\]]*\]\s*/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function severityFromLevel(level: unknown): Severity {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") return level;
  return "info";
}

function structured(line: string): ParsedLine | null {
  try {
    const record = JSON.parse(line.slice(STRUCTURED_PREFIX.length)) as Record<string, unknown>;
    const attributes: Record<string, AttributeValue> = {};
    if (record.detail !== undefined) attributes["laya.detail"] = JSON.stringify(record.detail);
    const time = typeof record.time === "string" ? Date.parse(record.time) : NaN;
    return {
      severity: severityFromLevel(record.level),
      source: typeof record.source === "string" ? record.source : "main",
      body: String(record.message ?? ""),
      attributes,
      ...(Number.isNaN(time) ? {} : { time }),
    };
  } catch {
    return null;
  }
}

/** Sorts a line of `electron-forge start` output by where it came from and how serious it is. */
export function classifyLine(raw: string, stream: "stdout" | "stderr"): ParsedLine | null {
  const line = stripAnsi(raw).trimEnd();
  if (!line.trim()) return null;
  const attributes: Record<string, AttributeValue> = { "log.iostream": stream };

  if (line.startsWith(STRUCTURED_PREFIX)) {
    const parsed = structured(line);
    if (parsed) return { ...parsed, attributes: { ...attributes, ...parsed.attributes } };
  }

  const chromium = CHROMIUM.exec(line);
  if (chromium) {
    const level = chromium[1] ?? "INFO";
    const severity: Severity = level === "ERROR" || level === "FATAL" ? "error" : level === "WARNING" ? "warn" : level.startsWith("VERBOSE") ? "debug" : "info";
    return { severity, source: "electron", body: line.slice(chromium[0].length), attributes };
  }

  const body = line.trim();
  if (/\[vite\]|vite v\d|➜ {2}(Local|Network)/i.test(body)) {
    return { severity: /error/i.test(body) ? "error" : "info", source: "vite", body, attributes };
  }
  if (/@electron-forge|^[✔✖❯›→√×]|^(Checking|Launching|Launched|Preparing|Running|Building)\b/.test(body)) {
    return { severity: body.startsWith("✖") || body.startsWith("×") ? "error" : "info", source: "forge", body, attributes };
  }
  if (/^DevTools listening on/.test(body)) return { severity: "info", source: "electron", body, attributes };
  if (/^npm (warn|notice)/.test(body)) return { severity: body.startsWith("npm warn") ? "warn" : "debug", source: "npm", body, attributes };

  const looksLikeError = /(error|exception)\b|\b(failed|uncaught)\b/i.test(body);
  const severity: Severity = looksLikeError ? "error" : stream === "stderr" ? "warn" : "info";
  return { severity, source: "forge", body, attributes };
}

/** Splits a stream into lines, keeping a partial last line until the rest arrives. */
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; end: () => void } {
  let buffered = "";
  return {
    push(chunk) {
      const parts = (buffered + chunk).split(/\r\n|\n|\r/);
      buffered = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    },
    end() {
      if (buffered) onLine(buffered);
      buffered = "";
    },
  };
}

type OtlpValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | string;
  doubleValue?: number;
  arrayValue?: { values?: OtlpValue[] };
  kvlistValue?: { values?: { key: string; value?: OtlpValue }[] };
  bytesValue?: string;
};

function decodeValue(value: OtlpValue | undefined): unknown {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decodeValue);
  if (value.kvlistValue) return Object.fromEntries((value.kvlistValue.values ?? []).map((entry) => [entry.key, decodeValue(entry.value)]));
  if (value.bytesValue !== undefined) return value.bytesValue;
  return null;
}

function severityFromNumber(severityNumber: number | undefined): Severity {
  if (!severityNumber) return "info";
  if (severityNumber >= 17) return "error";
  if (severityNumber >= 13) return "warn";
  if (severityNumber >= 9) return "info";
  return "debug";
}

/** Decodes an OTLP/HTTP JSON logs request (`ExportLogsServiceRequest`) into flat records. */
export function decodeOtlpLogs(payload: unknown, nextId: () => number): MonitorRecord[] {
  const records: MonitorRecord[] = [];
  const resourceLogs = (payload as { resourceLogs?: unknown[] })?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return records;
  for (const resource of resourceLogs as { resource?: { attributes?: { key: string; value?: OtlpValue }[] }; scopeLogs?: unknown[] }[]) {
    const service = resource.resource?.attributes?.find((attribute) => attribute.key === "service.name");
    for (const scope of (resource.scopeLogs ?? []) as { logRecords?: unknown[] }[]) {
      for (const raw of (scope.logRecords ?? []) as {
        timeUnixNano?: string | number;
        observedTimeUnixNano?: string | number;
        severityNumber?: number;
        body?: OtlpValue;
        attributes?: { key: string; value?: OtlpValue }[];
      }[]) {
        const attributes: Record<string, unknown> = Object.fromEntries((raw.attributes ?? []).map((entry) => [entry.key, decodeValue(entry.value)]));
        if (service) attributes["service.name"] = decodeValue(service.value);
        const source = typeof attributes["laya.source"] === "string" ? attributes["laya.source"] : "unknown";
        delete attributes["laya.source"];
        const nanos = Number(raw.timeUnixNano || raw.observedTimeUnixNano || 0);
        const body = decodeValue(raw.body);
        records.push({
          id: nextId(),
          time: nanos ? Math.round(nanos / 1e6) : Date.now(),
          severity: severityFromNumber(raw.severityNumber),
          source,
          body: typeof body === "string" ? body : JSON.stringify(body),
          attributes,
        });
      }
    }
  }
  return records;
}
