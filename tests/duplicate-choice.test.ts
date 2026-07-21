import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDuplicateChoiceReplyMarkup,
  createDuplicatePromptMessage,
  createDuplicateSkippedMessage,
  DuplicateChoicePending,
  parseDuplicateCallbackData,
} from "../src/bot/duplicate-choice.js";
import { DownloadHandlers } from "../src/bot/download-handlers.js";
import { ActiveDownloads } from "../src/download/active-downloads.js";
import { DeleteButtonState } from "../src/files/delete-buttons.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

test("parseDuplicateCallbackData accepts replace, keep, and skip", () => {
  assert.deepEqual(parseDuplicateCallbackData("dl-dup:replace:abc123"), { action: "replace", token: "abc123" });
  assert.deepEqual(parseDuplicateCallbackData("dl-dup:keep:abc123"), { action: "keep", token: "abc123" });
  assert.deepEqual(parseDuplicateCallbackData("dl-dup:skip:abc123"), { action: "skip", token: "abc123" });
  assert.equal(parseDuplicateCallbackData("dl-dup:nope:abc123"), undefined);
  assert.equal(parseDuplicateCallbackData("file-delete:ask:abc123"), undefined);
});

test("createDuplicateChoiceReplyMarkup exposes three actions", () => {
  const markup = createDuplicateChoiceReplyMarkup("tok");
  assert.deepEqual(
    markup.reply_markup.inline_keyboard[0]?.map((button) => button.callback_data),
    ["dl-dup:replace:tok", "dl-dup:keep:tok", "dl-dup:skip:tok"],
  );
  assert.match(createDuplicatePromptMessage("/video/Movies/a.mkv"), /Already exists/);
  assert.match(createDuplicateSkippedMessage("clip.mp4", "/video/a.mkv"), /Skipped \(duplicate\)/);
});

test("DuplicateChoicePending resolves choice and expires as skip", async () => {
  const pending = new DuplicateChoicePending();
  const created = pending.create({ chatId: 1, messageId: 2, existingPath: "/a.mkv" }, 20);
  assert.equal(pending.resolveToken(created.token, "keep"), true);
  assert.equal(await created.choice, "keep");
  assert.equal(pending.resolveToken(created.token, "skip"), false);

  const timedOut = pending.create({ chatId: 1, messageId: 3, existingPath: "/b.mkv" }, 20);
  assert.equal(await timedOut.choice, "skip");
});

test("DownloadHandlers prompts for duplicate choice and skips download on Skip", async () => {
  await withTempDir(async (tempDir) => {
    const terminals: Array<{ text: string; markup?: unknown }> = [];
    const answers: string[] = [];
    let downloaded = false;
    const existingPath = `${tempDir}/Movies/Old/old.mkv`;
    const downloader = {
      isMediaDownloadBusy() {
        return false;
      },
      async prepareDownload() {
        return {
          message: {},
          metadata: { kind: "film" as const, title: "Movie", plexIds: { imdb: "tt1" } },
          canonicalPath: `${tempDir}/Movies/New/new.mkv`,
          existingPath,
        };
      },
      async downloadPrepared() {
        downloaded = true;
        return { outputPath: `${tempDir}/Movies/New/new.mkv`, bytes: 1 };
      },
    };
    const handlers = new DownloadHandlers(
      createSettings({
        download: { directory: tempDir },
        app: { stateDirectory: tempDir },
      }),
      downloader as never,
      createLoggerSpy(),
      DeleteButtonState.forStateDirectory(tempDir),
      new ActiveDownloads(),
      {
        async scheduleTerminal(_chatId: number, _messageId: number, text: string, markup?: unknown) {
          terminals.push({ text, markup });
        },
      } as never,
      10_000,
      10,
    );

    const runPromise = handlers.downloadAndNotify(
      1234,
      { message_id: 1, date: 1_000, video: { file_name: "clip.mp4" } } as never,
      1234,
      async () => ({ message_id: 99 }),
      99,
    );

    await waitFor(() => terminals.some((entry) => entry.text.includes("Already exists")));
    const markup = terminals.find((entry) => entry.text.includes("Already exists"))?.markup as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    const skipData = markup.reply_markup.inline_keyboard[0]?.find((button) => button.callback_data.includes(":skip:"))
      ?.callback_data;
    assert.ok(skipData);

    await handlers.handleDuplicateChoiceButton(
      createCallbackContext(skipData, (message) => {
        answers.push(message);
      }),
    );

    await runPromise;

    assert.equal(downloaded, false);
    assert.ok(terminals.some((entry) => entry.text.includes("Skipped (duplicate)")));
    assert.deepEqual(answers, ["Skipped."]);
  });
});

test("DownloadHandlers replace downloads after duplicate confirmation", async () => {
  await withTempDir(async (tempDir) => {
    const terminals: Array<{ text: string; markup?: unknown }> = [];
    let downloadChoice: string | undefined;
    const existingPath = `${tempDir}/Movies/Old/old.mkv`;
    const downloader = {
      isMediaDownloadBusy() {
        return false;
      },
      async prepareDownload() {
        return {
          message: {},
          metadata: { kind: "film" as const, title: "Movie", plexIds: { imdb: "tt1" } },
          canonicalPath: `${tempDir}/Movies/New/new.mkv`,
          existingPath,
        };
      },
      async downloadPrepared(_prepared: unknown, _request: unknown, choice?: string) {
        downloadChoice = choice;
        return { outputPath: `${tempDir}/Movies/New/new.mkv`, bytes: 4 };
      },
    };
    const handlers = new DownloadHandlers(
      createSettings({
        download: { directory: tempDir },
        app: { stateDirectory: tempDir },
      }),
      downloader as never,
      createLoggerSpy(),
      DeleteButtonState.forStateDirectory(tempDir),
      new ActiveDownloads(),
      {
        async scheduleTerminal(_chatId: number, _messageId: number, text: string, markup?: unknown) {
          terminals.push({ text, markup });
        },
      } as never,
      10_000,
      10,
    );

    const runPromise = handlers.downloadAndNotify(
      1234,
      { message_id: 1, date: 1_000, video: { file_name: "clip.mp4" } } as never,
      1234,
      async () => ({ message_id: 99 }),
      99,
    );

    await waitFor(() => terminals.some((entry) => entry.text.includes("Already exists")));
    const markup = terminals.find((entry) => entry.text.includes("Already exists"))?.markup as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    const replaceData = markup.reply_markup.inline_keyboard[0]?.find((button) =>
      button.callback_data.includes(":replace:"),
    )?.callback_data;
    assert.ok(replaceData);

    await handlers.handleDuplicateChoiceButton(createCallbackContext(replaceData, () => {}));
    await runPromise;

    assert.equal(downloadChoice, "replace");
    assert.ok(terminals.some((entry) => entry.text.includes("Saved clip.mp4")));
  });
});

function createCallbackContext(data: string, onAnswer: (message: string) => void) {
  return {
    from: { id: 1234 },
    callbackQuery: { data },
    async answerCbQuery(message: string) {
      onAnswer(message);
    },
  } as never;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
