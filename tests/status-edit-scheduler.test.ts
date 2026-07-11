import assert from "node:assert/strict";
import { test } from "node:test";
import { StatusEditScheduler, getRetryAfterSeconds } from "../src/download/status-edit-scheduler.js";
import { createLoggerSpy } from "./helpers/test-utils.js";

function createTelegram429Error(retryAfter: number): Error {
  const error = new Error("Too Many Requests") as Error & {
    response: { parameters: { retry_after: number } };
  };
  error.response = { parameters: { retry_after: retryAfter } };
  return error;
}

test("getRetryAfterSeconds reads Telegram retry_after parameter", () => {
  assert.equal(getRetryAfterSeconds(createTelegram429Error(868)), 868);
  assert.equal(getRetryAfterSeconds(new Error("other")), undefined);
});

test("status scheduler coalesces rapid progress updates for the same message", async () => {
  const logger = createLoggerSpy();
  const edits: string[] = [];
  const scheduler = new StatusEditScheduler(
    async (_chatId, _messageId, text) => {
      edits.push(text);
    },
    logger,
    0,
    5,
    async () => {},
  );

  for (let index = 0; index < 10; index += 1) {
    scheduler.scheduleProgress(1234, 99, `progress ${index}`);
  }

  await scheduler.whenIdle();

  assert.deepEqual(edits, ["progress 9"]);
});

test("status scheduler retries terminal edits after 429 and respects retry_after", async () => {
  const logger = createLoggerSpy();
  const sleeps: number[] = [];
  let attempts = 0;
  const scheduler = new StatusEditScheduler(
    async () => {
      attempts += 1;

      if (attempts === 1) {
        throw createTelegram429Error(2);
      }
    },
    logger,
    0,
    5,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await scheduler.scheduleTerminal(1234, 99, "Saved movie.mp4");

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("status scheduler falls back to reply when terminal edits keep failing", async () => {
  const logger = createLoggerSpy();
  const replies: string[] = [];
  const scheduler = new StatusEditScheduler(
    async () => {
      throw new Error("edit failed");
    },
    logger,
    0,
    2,
    async () => {},
  );

  await scheduler.scheduleTerminal(1234, 99, "Saved movie.mp4", undefined, async (message) => {
    replies.push(message);
    return { message_id: 1 };
  });

  assert.deepEqual(replies, ["Saved movie.mp4"]);
  assert.equal(logger.entries.filter((entry) => entry.message.includes("Failed to edit Telegram progress message")).length, 2);
});

test("status scheduler prioritizes terminal edits ahead of pending progress", async () => {
  const logger = createLoggerSpy();
  const edits: string[] = [];
  const scheduler = new StatusEditScheduler(
    async (_chatId, _messageId, text) => {
      edits.push(text);
    },
    logger,
    0,
    5,
    async () => {},
  );

  scheduler.scheduleProgress(1234, 100, "progress other");
  scheduler.scheduleProgress(1234, 101, "progress another");
  const terminalPromise = scheduler.scheduleTerminal(1234, 99, "Saved movie.mp4");
  await terminalPromise;
  await scheduler.whenIdle();

  assert.deepEqual(edits, ["Saved movie.mp4", "progress other", "progress another"]);
});
