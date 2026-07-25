import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  bindOtelLogger,
  LOG_USER_TEXT_MAX,
  logger,
  setLogLevel,
  truncateForLog,
} from "../src/config/logger.js";

afterEach(() => {
  mock.restoreAll();
  bindOtelLogger(null);
  setLogLevel("info");
});

test("logger mirrors to console and emits OTEL logs with severity, body summary, and trace_id", async () => {
  const emit = mock.fn();
  const logSpy = mock.method(console, "log", () => {});
  bindOtelLogger({ emit });

  // No active span in this unit test; trace_id is optional.
  logger.info("[test] hello", {
    component: "test",
    step: "start",
    handler: "download",
    user_text: "movie caption",
  });

  assert.equal(logSpy.mock.callCount(), 1);
  assert.equal(emit.mock.callCount(), 1);
  const payload = emit.mock.calls[0].arguments[0] as {
    severityText: string;
    body: string;
    attributes: Record<string, string>;
  };
  assert.equal(payload.severityText, "INFO");
  assert.match(payload.body, /\[test\] hello/);
  assert.match(payload.body, /handler=download/);
  assert.match(payload.body, /step=start/);
  assert.match(payload.body, /user_text=movie caption/);
  assert.equal(payload.attributes.component, "test");
  assert.equal(payload.attributes.handler, "download");
  assert.equal(payload.attributes.user_text, "movie caption");
});

test("truncateForLog truncates long user text for log previews", () => {
  const long = "a".repeat(LOG_USER_TEXT_MAX + 50);
  const preview = truncateForLog(long);
  assert.equal(preview.length, LOG_USER_TEXT_MAX);
  assert.equal(preview.endsWith("…"), true);
});

test("logger.exception falls back to console when OTEL logger is unbound", () => {
  const errorSpy = mock.method(console, "error", () => {});
  bindOtelLogger(null);

  logger.exception("[test] boom", new Error("nope"), { component: "test" });

  assert.equal(errorSpy.mock.callCount(), 1);
  const logged = String(errorSpy.mock.calls[0]?.arguments[0] ?? "");
  assert.match(logged, /\[test\] boom/);
  assert.match(logged, /error_message/);
});
