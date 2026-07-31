import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ActiveDownloads } from "../src/download/active-downloads.js";
import { DownloadHandlers } from "../src/bot/download-handlers.js";
import { DeleteHandlers } from "../src/bot/delete-handlers.js";
import {
  createDeleteConfirmationReplyMarkup,
  createMoveToKidsConfirmationReplyMarkup,
  createStatusActionReplyMarkup,
  DeleteButtonState,
} from "../src/files/delete-buttons.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

test("DownloadHandlers ignores unauthorized users", async () => {
  const logger = createLoggerSpy();
  const replies: string[] = [];
  const handlers = new DownloadHandlers(
    createSettings(),
    {} as never,
    logger,
    {} as never,
    new ActiveDownloads(),
    {} as never,
    10_000,
    10,
  );

  await handlers.handleDownloadableMessage(
    999,
    { message_id: 1, date: 1_000, video: { file_name: "clip.mp4" } } as never,
    1234,
    async (message) => {
      replies.push(message);
      return { message_id: 1 };
    },
  );

  assert.deepEqual(replies, []);
  assert.equal(
    logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("unauthorized")),
    true,
  );
});

test("DownloadHandlers shows Queued when the user media download is already busy", async () => {
  await withTempDir(async (tempDir) => {
    const settings = createSettings({
      download: { directory: tempDir },
      app: { stateDirectory: tempDir },
    });
    const terminals: string[] = [];
    let resolveDownload: () => void = () => {};
    const downloadGate = new Promise<void>((resolve) => {
      resolveDownload = resolve;
    });
    let downloadStarted = false;

    const downloader = {
      isMediaDownloadBusy() {
        return downloadStarted;
      },
      async prepareDownload() {
        return {
          message: {},
          metadata: { kind: "undefined" as const, reason: "test" },
          canonicalPath: path.join(tempDir, "clip.mp4"),
        };
      },
      async downloadPrepared() {
        downloadStarted = true;
        await downloadGate;
        return { outputPath: path.join(tempDir, "clip.mp4"), bytes: 1 };
      },
    };
    const handlers = new DownloadHandlers(
      settings,
      downloader as never,
      createLoggerSpy(),
      DeleteButtonState.forStateDirectory(tempDir),
      new ActiveDownloads(),
      {
        async scheduleTerminal(_chatId: number, _messageId: number, message: string) {
          terminals.push(message);
        },
      } as never,
      10_000,
      10,
    );

    const first = handlers.downloadAndNotify(
      1234,
      { message_id: 1, date: 1_000, video: { file_name: "first.mp4" } } as never,
      1234,
      async () => ({ message_id: 98 }),
      98,
    );

    await waitFor(() => downloadStarted);

    const second = handlers.downloadAndNotify(
      1234,
      { message_id: 2, date: 1_000, video: { file_name: "second.mp4" } } as never,
      1234,
      async () => ({ message_id: 99 }),
      99,
    );

    await waitFor(() => terminals.includes("Queued: second.mp4"));
    assert.deepEqual(terminals, ["Queued: second.mp4"]);

    resolveDownload();
    await Promise.all([first, second]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("DeleteHandlers ask shows confirmation markup", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "Movies", "Demo Movie", "movie.mp4");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "video", "utf8");
    const state = DeleteButtonState.forStateDirectory(tempDir);
    const record = await state.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });
    const edits: Array<{ text: string; extra?: unknown }> = [];
    const answers: string[] = [];
    const handlers = new DeleteHandlers(createSettings({ download: { directory: tempDir } }), createLoggerSpy(), state, new ActiveDownloads());

    await handlers.handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-delete:ask:${record.token}`,
        message: { message_id: 99, chat: { id: 1234 }, text: "Saved movie.mp4" },
      },
      telegram: {
        editMessageText: async (
          _chatId: number,
          _messageId: number,
          _inline: undefined,
          text: string,
          extra?: unknown,
        ) => {
          edits.push({ text, extra });
        },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.match(edits[0]?.text ?? "", /Delete this downloaded file\?/);
    assert.deepEqual(edits[0]?.extra, createDeleteConfirmationReplyMarkup(record.token));
    assert.deepEqual(answers, ["Confirm deletion."]);
  });
});

test("DeleteHandlers ask-move shows Move to Kids confirmation", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "Movies", "Demo Movie", "movie.mp4");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "video", "utf8");
    const state = DeleteButtonState.forStateDirectory(tempDir);
    const record = await state.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });
    const edits: Array<{ text: string; extra?: unknown }> = [];
    const answers: string[] = [];
    const handlers = new DeleteHandlers(createSettings({ download: { directory: tempDir } }), createLoggerSpy(), state, new ActiveDownloads());

    await handlers.handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-delete:ask-move:${record.token}`,
        message: { message_id: 99, chat: { id: 1234 }, text: "Saved movie.mp4" },
      },
      telegram: {
        editMessageText: async (
          _chatId: number,
          _messageId: number,
          _inline: undefined,
          text: string,
          extra?: unknown,
        ) => {
          edits.push({ text, extra });
        },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.match(edits[0]?.text ?? "", /Move this to Kids\?/);
    assert.match(edits[0]?.text ?? "", /Movies\/Demo Movie/);
    assert.match(edits[0]?.text ?? "", /Kids\/Movies\/Demo Movie/);
    assert.deepEqual(edits[0]?.extra, createMoveToKidsConfirmationReplyMarkup(record.token));
    assert.deepEqual(answers, ["Confirm move to Kids."]);
  });
});

test("DeleteHandlers cancel restores delete and Move to Kids buttons", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "Movies", "Demo Movie", "movie.mp4");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "video", "utf8");
    const state = DeleteButtonState.forStateDirectory(tempDir);
    const record = await state.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });
    const edits: Array<{ text: string; extra?: unknown }> = [];
    const answers: string[] = [];
    const handlers = new DeleteHandlers(createSettings({ download: { directory: tempDir } }), createLoggerSpy(), state, new ActiveDownloads());

    await handlers.handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-delete:cancel:${record.token}`,
        message: {
          message_id: 99,
          chat: { id: 1234 },
          text: "Saved movie.mp4\n\nMove this to Kids?\nMovies/Demo Movie\n→\nKids/Movies/Demo Movie",
        },
      },
      telegram: {
        editMessageText: async (
          _chatId: number,
          _messageId: number,
          _inline: undefined,
          text: string,
          extra?: unknown,
        ) => {
          edits.push({ text, extra });
        },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.equal(edits[0]?.text, "Saved movie.mp4");
    assert.deepEqual(edits[0]?.extra, createStatusActionReplyMarkup(record.token, filePath, tempDir));
    assert.deepEqual(answers, ["Cancelled."]);
  });
});

test("DeleteHandlers confirm-move moves the movie folder to Kids", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "Movies", "Demo Movie", "movie.mp4");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "video", "utf8");
    const state = DeleteButtonState.forStateDirectory(tempDir);
    const record = await state.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });
    const edits: Array<{ text: string; extra?: unknown }> = [];
    const answers: string[] = [];
    const handlers = new DeleteHandlers(createSettings({ download: { directory: tempDir } }), createLoggerSpy(), state, new ActiveDownloads());

    await handlers.handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-delete:confirm-move:${record.token}`,
        message: {
          message_id: 99,
          chat: { id: 1234 },
          text: "Saved movie.mp4\n\nMove this to Kids?\nMovies/Demo Movie\n→\nKids/Movies/Demo Movie",
        },
      },
      telegram: {
        editMessageText: async (
          _chatId: number,
          _messageId: number,
          _inline: undefined,
          text: string,
          extra?: unknown,
        ) => {
          edits.push({ text, extra });
        },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.match(edits[0]?.text ?? "", /Moved to Kids: Movies\/Demo Movie → Kids\/Movies\/Demo Movie/);
    assert.equal(edits[0]?.extra, undefined);
    assert.deepEqual(answers, ["Moved to Kids."]);
    assert.ok((await state.get(record.token))?.deletedAt);
    await assert.rejects(stat(path.join(tempDir, "Movies", "Demo Movie")));
    await stat(path.join(tempDir, "Kids", "Movies", "Demo Movie", "movie.mp4"));
  });
});

test("DeleteHandlers rejects missing tokens and mismatched messages", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "movie.mp4");
    await mkdir(tempDir, { recursive: true });
    await writeFile(filePath, "video", "utf8");
    const state = DeleteButtonState.forStateDirectory(tempDir);
    const record = await state.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });
    const answers: string[] = [];
    const handlers = new DeleteHandlers(createSettings({ download: { directory: tempDir } }), createLoggerSpy(), state, new ActiveDownloads());

    await handlers.handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: { data: "file-delete:ask:missing-token" },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    await handlers.handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-delete:ask:${record.token}`,
        message: { message_id: 100, chat: { id: 1234 }, text: "Saved movie.mp4" },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.deepEqual(answers, [
      "Delete action is no longer available.",
      "Delete action does not match this message.",
    ]);
  });
});
