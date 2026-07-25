import { trace } from "@opentelemetry/api";
import type { Settings } from "./settings.js";

export type LogLevel = Settings["app"]["logLevel"];
export type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogAttributes = Record<string, string | number | boolean | undefined>;

/** Max chars for caption / user-text previews in logs. */
export const LOG_USER_TEXT_MAX = 200;

type TelemetryLogger = {
  emit(record: {
    severityText: string;
    body: string;
    attributes?: Record<string, string>;
  }): void;
};

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const severityToLevel: Record<LogSeverity, LogLevel> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

/** Injected by telemetry bootstrap; null until startTelemetry() / after shutdown. */
let otelLogger: TelemetryLogger | null = null;
let minLevel: LogLevel = "info";

export function bindOtelLogger(logger: TelemetryLogger | null): void {
  otelLogger = logger;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Collapse whitespace and trim for log previews; appends … when truncated. */
export function truncateForLog(text: string, max = LOG_USER_TEXT_MAX): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function toStringAttrs(attributes: LogAttributes): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Keys appended into the log body so Grafana "Recent logs" panels stay readable. */
const BODY_ATTR_KEYS = [
  "handler",
  "result",
  "step",
  "duration_ms",
  "user_text",
  "error_type",
  "media_kind",
  "file_name",
] as const;

function formatBody(message: string, attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of BODY_ATTR_KEYS) {
    if (attrs[key] !== undefined && attrs[key] !== "") {
      parts.push(`${key}=${attrs[key]}`);
    }
  }
  return parts.length > 0 ? `${message} ${parts.join(" ")}` : message;
}

function shouldEmit(severity: LogSeverity): boolean {
  return levelWeights[severityToLevel[severity]] >= levelWeights[minLevel];
}

/**
 * Application logger: mirrors to console and emits OTEL logs (Loki via Alloy)
 * with explicit severityText. Attaches active trace_id when present.
 * Never throws; telemetry failures must not block business logic.
 */
export function log(severity: LogSeverity, message: string, attributes: LogAttributes = {}): void {
  if (!shouldEmit(severity)) return;

  const attrs = toStringAttrs(attributes);
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  if (traceId && !attrs.trace_id) {
    attrs.trace_id = traceId;
  }

  const body = formatBody(message, attrs);
  const consolePayload = Object.keys(attrs).length > 0 ? `${body} ${JSON.stringify(attrs)}` : body;
  switch (severity) {
    case "ERROR":
      console.error(consolePayload);
      break;
    case "WARN":
      console.warn(consolePayload);
      break;
    case "DEBUG":
      console.debug(consolePayload);
      break;
    default:
      console.log(consolePayload);
  }

  if (!otelLogger) return;
  try {
    otelLogger.emit({
      severityText: severity,
      body,
      attributes: attrs,
    });
  } catch (err) {
    console.warn(`[log] otel emit failed: ${errorMessage(err)}`);
  }
}

/** Module-level logger used by telemetry middleware and code without a Logger instance. */
export const logger = {
  debug(message: string, attributes?: LogAttributes): void {
    log("DEBUG", message, attributes);
  },
  info(message: string, attributes?: LogAttributes): void {
    log("INFO", message, attributes);
  },
  warn(message: string, attributes?: LogAttributes): void {
    log("WARN", message, attributes);
  },
  error(message: string, attributes?: LogAttributes): void {
    log("ERROR", message, attributes);
  },
  exception(message: string, err: unknown, attributes?: LogAttributes): void {
    log("ERROR", message, {
      ...attributes,
      error_message: errorMessage(err),
      error_name: err instanceof Error ? err.name : "unknown",
    });
  },
};

/**
 * Injectable logger that honors the configured app log level.
 * Methods accept structured attributes (not free-form details objects).
 */
export class Logger {
  constructor(level: LogLevel) {
    setLogLevel(level);
  }

  debug(message: string, attributes?: LogAttributes): void {
    logger.debug(message, attributes);
  }

  info(message: string, attributes?: LogAttributes): void {
    logger.info(message, attributes);
  }

  warn(message: string, attributes?: LogAttributes): void {
    logger.warn(message, attributes);
  }

  error(message: string, attributes?: LogAttributes): void {
    logger.error(message, attributes);
  }

  exception(message: string, err: unknown, attributes?: LogAttributes): void {
    logger.exception(message, err, attributes);
  }
}
