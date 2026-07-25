import type { Context, MiddlewareFn } from "telegraf";
import { trace } from "@opentelemetry/api";
import {
  initTelemetry,
  isBotHandle,
  type BotResult,
  type BotTelemetryHandle,
} from "@crearec/otel";
import { bindOtelLogger, logger } from "./config/logger.js";

const SERVICE_NAME = "crea-video-downloader";
const SERVICE_NAMESPACE = "bots";

type TelemetryState = {
  result: BotResult;
  handler: string;
  errorType?: string;
};

const stateByUpdate = new WeakMap<object, TelemetryState>();

let telemetry: BotTelemetryHandle | null = null;

/** Test-only: inject a fake handle without calling initTelemetry. */
export function setTelemetryForTests(tel: BotTelemetryHandle | null): void {
  telemetry = tel;
  bindOtelLogger(tel?.logger ?? null);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stateKey(ctx: Context): object {
  return ctx.update ?? ctx;
}

function getState(ctx: Context): TelemetryState | undefined {
  return stateByUpdate.get(stateKey(ctx));
}

function inferHandler(ctx: Context): string {
  if (ctx.callbackQuery) {
    const data =
      "data" in ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
        ? ctx.callbackQuery.data
        : "";
    if (data.startsWith("file-delete:")) return "delete";
    if (data.startsWith("file-tree:")) return "file_tree";
    if (data.startsWith("fix-meta:")) return "metadata_fix";
    if (data.startsWith("dl-dup:")) return "duplicate_choice";
    return "callback";
  }

  const msg = ctx.message;
  if (!msg) return "update";

  if ("text" in msg && typeof msg.text === "string") {
    if (msg.text === "/start" || msg.text.startsWith("/start ")) return "start";
    if (msg.text === "/help" || msg.text.startsWith("/help ")) return "help";
    if (msg.text === "/files" || msg.text.startsWith("/files ")) return "files";
    if (msg.text === "/usage" || msg.text.startsWith("/usage ")) return "usage";
    if (msg.text === "/restart" || msg.text.startsWith("/restart ")) return "restart";
    if (msg.text.startsWith("/")) return "command";
    return "text";
  }
  if ("video" in msg) return "download";
  if ("document" in msg) return "download";
  if ("photo" in msg) return "metadata_fix";
  return "message";
}

function inferUpdateKind(ctx: Context): string {
  if (ctx.callbackQuery) return "callback_query";
  const msg = ctx.message;
  if (!msg) return "other";
  if ("text" in msg) return "text";
  if ("video" in msg) return "video";
  if ("document" in msg) return "document";
  if ("photo" in msg) return "photo";
  return "message";
}

function classifyError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err && err.name === "TimeoutError") {
    return "timeout";
  }
  if (err && typeof err === "object" && "name" in err && err.name === "DownloadCanceledError") {
    return "canceled";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/openai|api key|rate limit/i.test(message)) return "openai";
  if (/tmdb/i.test(message)) return "tmdb";
  if (/telegram|403|429|ECONNREFUSED|FILE_REFERENCE_/i.test(message)) return "telegram";
  if (/ENOENT|EACCES|EPERM|filesystem|no such file/i.test(message)) return "fs";
  return "unknown";
}

/** Bootstrap OTLP → Alloy. Safe to call once at process start. */
export function startTelemetry(): BotTelemetryHandle {
  if (telemetry) return telemetry;

  const tel = initTelemetry({
    kind: "bot",
    serviceName: readEnv("OTEL_SERVICE_NAME") ?? SERVICE_NAME,
    serviceNamespace: readEnv("OTEL_SERVICE_NAMESPACE") ?? SERVICE_NAMESPACE,
    deploymentEnvironment: readEnv("DEPLOY_ENV") ?? "local",
    serviceVersion: readEnv("OTEL_SERVICE_VERSION"),
    endpoint: readEnv("OTEL_EXPORTER_OTLP_ENDPOINT"),
  });

  if (!isBotHandle(tel)) {
    throw new Error("expected @crearec/otel kind: bot");
  }

  tel.bot.setUp(true);
  bindOtelLogger(tel.logger);
  telemetry = tel;
  return tel;
}

export function getTelemetry(): BotTelemetryHandle {
  if (!telemetry) {
    throw new Error("telemetry not started; call startTelemetry() first");
  }
  return telemetry;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!telemetry) return;
  telemetry.bot.setUp(false);
  bindOtelLogger(null);
  await telemetry.shutdown();
  telemetry = null;
}

/** Mark the current update as skipped (auth reject, ignored command, …). */
export function markUpdateSkipped(ctx: Context, handler?: string): void {
  const state = getState(ctx);
  if (!state) return;
  state.result = "skipped";
  if (handler) state.handler = handler;
}

/** Refine low-cardinality handler label before the update finishes. */
export function setUpdateHandler(ctx: Context, handler: string): void {
  const state = getState(ctx);
  if (!state) return;
  state.handler = handler;
}

/**
 * Record an application error for the current update without rethrowing.
 * Still sets result=error so counter + histogram stay aligned.
 */
export function markUpdateError(
  ctx: Context,
  err: unknown,
  options?: { errorType?: string; handler?: string },
): void {
  const state = getState(ctx);
  const handler = options?.handler ?? state?.handler ?? inferHandler(ctx);
  const errorType = options?.errorType ?? classifyError(err);

  if (state) {
    state.result = "error";
    state.handler = handler;
    state.errorType = errorType;
  }

  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    if (err instanceof Error) {
      activeSpan.recordException(err);
    }
    activeSpan.setStatus({ code: 2, message: errorType });
    activeSpan.setAttribute("error.type", errorType);
  }

  try {
    getTelemetry().bot.recordError({ errorType, handler });
  } catch {
    // Telemetry must not break business logic (tests without startTelemetry).
  }

  logger.exception("[bot] handler error", err, {
    component: "bot",
    handler,
    result: "error",
    error_type: errorType,
  });
}

/**
 * Root middleware: one `bot.handle_update` span per Telegram update, and
 * always emit `bot_handler_duration_seconds` + `bot_updates_total` together.
 */
export function telemetryMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const tel = getTelemetry();
    const state: TelemetryState = {
      result: "success",
      handler: inferHandler(ctx),
    };
    stateByUpdate.set(stateKey(ctx), state);

    await tel.tracer.startActiveSpan("bot.handle_update", async (span) => {
      const started = process.hrtime.bigint();
      const traceId = span.spanContext().traceId;
      const updateKind = inferUpdateKind(ctx);

      logger.info("[bot] update started", {
        component: "bot",
        handler: state.handler,
        update_kind: updateKind,
        step: "start",
      });

      try {
        await next();
      } catch (err) {
        state.result = "error";
        const alreadyRecorded = state.errorType !== undefined;
        const errorType = state.errorType ?? classifyError(err);
        state.errorType = errorType;
        if (!alreadyRecorded) {
          try {
            tel.bot.recordError({ errorType, handler: state.handler });
          } catch {
            // ignore
          }
          logger.exception("[bot] update failed", err, {
            component: "bot",
            handler: state.handler,
            result: "error",
            error_type: errorType,
            step: "failed",
          });
        }
        if (err instanceof Error) {
          span.recordException(err);
        }
        span.setStatus({ code: 2, message: errorType });
        throw err;
      } finally {
        const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
        try {
          tel.bot.recordHandledUpdate({
            result: state.result,
            durationSeconds,
            handler: state.handler,
          });
        } catch (err) {
          logger.warn("[telemetry] metric emit failed", {
            component: "telemetry",
            error_message: err instanceof Error ? err.message : String(err),
          });
        }

        logger.info("[bot] update finished", {
          component: "bot",
          handler: state.handler,
          result: state.result,
          duration_ms: Math.round(durationSeconds * 1000),
          update_kind: updateKind,
          step: "finish",
          ...(state.errorType ? { error_type: state.errorType } : {}),
          trace_id: traceId,
        });

        span.setAttribute("result", state.result);
        span.setAttribute("handler", state.handler);
        if (state.errorType) {
          span.setAttribute("error.type", state.errorType);
        }
        span.end();
        stateByUpdate.delete(stateKey(ctx));
      }
    });
  };
}
