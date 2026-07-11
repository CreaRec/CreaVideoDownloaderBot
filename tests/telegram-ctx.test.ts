import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerCallback,
  getCallbackData,
  getCallbackMessage,
  getCommandArgument,
  isAllowedUser,
  safeReply,
} from "../src/telegram/telegram-ctx.js";
import { createLoggerSpy, createSettings } from "./helpers/test-utils.js";

test("isAllowedUser accepts configured user ids only", () => {
  const settings = createSettings();

  assert.equal(isAllowedUser(settings, 1234), true);
  assert.equal(isAllowedUser(settings, 999), false);
  assert.equal(isAllowedUser(settings, undefined), false);
});

test("getCallbackData reads callback query data when present", () => {
  assert.equal(getCallbackData({ callbackQuery: { data: "file-delete:ask:tok" } } as never), "file-delete:ask:tok");
  assert.equal(getCallbackData({} as never), undefined);
  assert.equal(getCallbackData({ callbackQuery: {} } as never), undefined);
});

test("getCallbackMessage reads message metadata from callback queries", () => {
  assert.deepEqual(
    getCallbackMessage({
      callbackQuery: {
        data: "x",
        message: {
          message_id: 42,
          chat: { id: 7 },
          text: "hello",
        },
      },
    } as never),
    {
      message_id: 42,
      chat: { id: 7 },
      text: "hello",
    },
  );
  assert.equal(getCallbackMessage({} as never), undefined);
  assert.equal(
    getCallbackMessage({
      callbackQuery: {
        message: {
          message_id: "bad",
          chat: { id: 7 },
        },
      },
    } as never),
    undefined,
  );
});

test("getCommandArgument returns trimmed trailing arguments", () => {
  assert.equal(getCommandArgument({ message: { text: "/usage" } } as never), undefined);
  assert.equal(getCommandArgument({ message: { text: "/restart now please" } } as never), "now please");
  assert.equal(getCommandArgument({} as never), undefined);
});

test("safeReply returns the reply result and swallows failures", async () => {
  const logger = createLoggerSpy();
  const success = await safeReply(async (message) => ({ message_id: 9, echoed: message }), logger, "hi");
  assert.deepEqual(success, { message_id: 9, echoed: "hi" });

  const failure = await safeReply(
    async () => {
      throw new Error("boom");
    },
    logger,
    "hi",
  );
  assert.equal(failure, undefined);
  assert.equal(logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("Failed to send")), true);
});

test("answerCallback answers callbacks and swallows failures", async () => {
  const logger = createLoggerSpy();
  const answers: string[] = [];

  await answerCallback(
    {
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never,
    logger,
    "ok",
  );
  assert.deepEqual(answers, ["ok"]);

  await answerCallback(
    {
      answerCbQuery: async () => {
        throw new Error("gone");
      },
    } as never,
    logger,
    "ok",
  );
  assert.equal(
    logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("Failed to answer")),
    true,
  );
});
