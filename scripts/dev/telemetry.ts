import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { SEVERITY_NUMBER, type ParsedLine } from "./records.ts";

export type Telemetry = {
  emit: (line: ParsedLine) => void;
  shutdown: () => Promise<void>;
};

/**
 * Every line becomes an OpenTelemetry log record, exported over OTLP/HTTP to the monitor.
 * Setting OTEL_EXPORTER_OTLP_ENDPOINT also sends them to that collector.
 */
export function createTelemetry(monitorUrl: string): Telemetry {
  const processors = [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: monitorUrl }), scheduledDelayMillis: 150 })];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    processors.push(new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }));
  }
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "laya-notes-dev", "service.version": process.env.npm_package_version ?? "dev" }),
    processors,
  });
  const logger = provider.getLogger("laya-dev");

  return {
    emit(line) {
      logger.emit({
        severityNumber: SEVERITY_NUMBER[line.severity],
        severityText: line.severity.toUpperCase(),
        body: line.body,
        attributes: { ...line.attributes, "laya.source": line.source },
        ...(line.time ? { timestamp: line.time } : {}),
      });
    },
    shutdown: () => provider.shutdown(),
  };
}
