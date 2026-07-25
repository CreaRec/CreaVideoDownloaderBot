import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { BotTelemetryHandle } from "@crearec/otel";
import { bindOtelLogger, setLogLevel } from "../src/config/logger.js";
import {
  markUpdateError,
  markUpdateSkipped,
  setTelemetryForTests,
  setUpdateHandler,
  shutdownTelemetry,
  telemetryMiddleware,
} from "../src/telemetry.js";

function createFakeTelemetry(): {
  handle: BotTelemetryHandle;
  bot: {
    recordHandledUpdate: ReturnType<typeof mock.fn>;
    recordError: ReturnType<typeof mock.fn>;
    setUp: ReturnType<typeof mock.fn>;
  };
  span: {
    setAttribute: ReturnType<typeof mock.fn>;
    setStatus: ReturnType<typeof mock.fn>;
    recordException: ReturnType<typeof mock.fn>;
    end: ReturnType<typeof mock.fn>;
    spanContext: () => { traceId: string };
  };
  logger: { emit: ReturnType<typeof mock.fn> };
} {
  const span = {
    setAttribute: mock.fn(),
    setStatus: mock.fn(),
    recordException: mock.fn(),
    end: mock.fn(),
    spanContext: () => ({ traceId: "trace-abc" }),
  };
  const bot = {
    recordHandledUpdate: mock.fn(),
    recordError: mock.fn(),
    setUp: mock.fn(),
  };
  const logger = { emit: mock.fn() };
  const handle = {
    kind: "bot" as const,
    serviceName: "crea-video-downloader",
    serviceNamespace: "bots",
    tracer: {
      startActiveSpan: async (_name: string, fn: (activeSpan: typeof span) => Promise<void>) => fn(span),
    },
    meter: {},
    logger,
    bot,
    shutdown: mock.fn(async () => undefined),
  } as unknown as BotTelemetryHandle;

  return { handle, bot, span, logger };
}

afterEach(async () => {
  mock.restoreAll();
  setTelemetryForTests(null);
  bindOtelLogger(null);
  setLogLevel("info");
  await shutdownTelemetry();
});

test("records duration and updates together on success", async () => {
  const { handle, bot, span, logger } = createFakeTelemetry();
  setTelemetryForTests(handle);

  const middleware = telemetryMiddleware();
  await middleware({ update: { update_id: 1 }, message: { text: "hello" } } as never, async () => undefined);

  assert.equal(bot.recordHandledUpdate.mock.callCount(), 1);
  assert.deepEqual(
    {
      result: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { result: string }).result,
      handler: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { handler: string }).handler,
    },
    { result: "success", handler: "text" },
  );
  assert.equal(typeof (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { durationSeconds: number }).durationSeconds, "number");
  assert.equal(bot.recordError.mock.callCount(), 0);
  assert.equal(span.end.mock.callCount(), 1);
  assert.equal(logger.emit.mock.callCount() >= 1, true);
});

test("marks auth rejects as skipped and still increments the counter", async () => {
  const { handle, bot } = createFakeTelemetry();
  setTelemetryForTests(handle);

  const middleware = telemetryMiddleware();
  const ctx = { update: { update_id: 2 }, message: { text: "hi" } };
  await middleware(ctx as never, async () => {
    markUpdateSkipped(ctx as never, "auth");
  });

  assert.deepEqual(
    {
      result: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { result: string }).result,
      handler: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { handler: string }).handler,
    },
    { result: "skipped", handler: "auth" },
  );
  assert.equal(bot.recordError.mock.callCount(), 0);
});

test("records error counter + handled update together when next throws", async () => {
  const { handle, bot, span } = createFakeTelemetry();
  setTelemetryForTests(handle);

  const middleware = telemetryMiddleware();
  const ctx = { update: { update_id: 3 }, message: { text: "boom" } };
  const err = Object.assign(new Error("timed out"), { name: "TimeoutError" });

  await assert.rejects(
    () =>
      middleware(ctx as never, async () => {
        throw err;
      }),
    (thrown: unknown) => thrown === err,
  );

  assert.deepEqual(bot.recordError.mock.calls[0].arguments[0], { errorType: "timeout", handler: "text" });
  assert.deepEqual(
    {
      result: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { result: string }).result,
      handler: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { handler: string }).handler,
    },
    { result: "error", handler: "text" },
  );
  assert.equal(span.recordException.mock.calls[0].arguments[0], err);
});

test("records application errors without rethrowing when markUpdateError is used", async () => {
  const { handle, bot } = createFakeTelemetry();
  setTelemetryForTests(handle);

  const middleware = telemetryMiddleware();
  const ctx = { update: { update_id: 4 }, message: { video: { file_id: "x" } } };

  await middleware(ctx as never, async () => {
    setUpdateHandler(ctx as never, "download");
    markUpdateError(ctx as never, new Error("openai failed"), { errorType: "openai" });
  });

  assert.deepEqual(bot.recordError.mock.calls[0].arguments[0], {
    errorType: "openai",
    handler: "download",
  });
  assert.deepEqual(
    {
      result: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { result: string }).result,
      handler: (bot.recordHandledUpdate.mock.calls[0].arguments[0] as { handler: string }).handler,
    },
    { result: "error", handler: "download" },
  );
});

test("infers download and callback handlers from update shape", async () => {
  const { handle, bot } = createFakeTelemetry();
  setTelemetryForTests(handle);
  const middleware = telemetryMiddleware();

  await middleware({ update: { update_id: 5 }, message: { video: { file_id: "v" } } } as never, async () => undefined);
  assert.equal((bot.recordHandledUpdate.mock.calls[0].arguments[0] as { handler: string }).handler, "download");

  bot.recordHandledUpdate.mock.resetCalls();
  await middleware(
    { update: { update_id: 6 }, callbackQuery: { data: "file-tree:abc", id: "1", from: { id: 1 } } } as never,
    async () => undefined,
  );
  assert.equal((bot.recordHandledUpdate.mock.calls[0].arguments[0] as { handler: string }).handler, "file_tree");
});
