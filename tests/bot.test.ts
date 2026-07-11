import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { BotService } from "../src/bot/bot.js";
import { createDeleteButtonReplyMarkup, parseDeleteCallbackData, type DeleteButtonReplyMarkup } from "../src/files/delete-buttons.js";
import { DownloadCanceledError, type DownloadRequest } from "../src/download/downloader.js";
import type { FileTreeBrowser } from "../src/files/file-tree.js";
import { DownloadSemaphore } from "../src/download/download-semaphore.js";
import { createProgressReporter, formatBytes } from "../src/download/progress-reporter.js";
import { StatusEditScheduler } from "../src/download/status-edit-scheduler.js";
import { getCaption, getDisplayFileName, getSuggestedFileName } from "../src/telegram/telegram-message.js";
import { createLoggerSpy, createSettings, withTempDir, type LoggerSpy } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

function createSchedulerForEdits(
  edits: Array<{ message: string; extra?: unknown }>,
  logger: LoggerSpy,
): StatusEditScheduler {
  return new StatusEditScheduler(
    async (_chatId, _messageId, message, extra) => {
      edits.push({ message, extra });
    },
    logger,
    0,
  );
}

test("formatBytes renders unknown, byte, and larger values", () => {
  assert.equal(formatBytes(undefined), "unknown size");
  assert.equal(formatBytes(Number.NaN), "unknown size");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(12 * 1024), "12.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.00 MB");
});

test("message helper functions extract filenames and captions", () => {
  const documentMessage = {
    message_id: 1,
    caption: "document caption",
    document: { file_name: "document.mp4" },
  };
  const videoMessage = {
    message_id: 2,
    caption: "video caption",
    video: { file_name: "video.mp4" },
  };
  const unnamedVideo = {
    message_id: 3,
    video: {},
  };

  assert.equal(getSuggestedFileName(documentMessage as never), "document.mp4");
  assert.equal(getSuggestedFileName(videoMessage as never), "video.mp4");
  assert.equal(getSuggestedFileName(unnamedVideo as never), undefined);
  assert.equal(getDisplayFileName(unnamedVideo as never), "video-3");
  assert.equal(getCaption(documentMessage as never), "document caption");
  assert.equal(getCaption(unnamedVideo as never), undefined);
});

test("progress reporter edits status messages at percent steps and on completion", async () => {
  const logger = createLoggerSpy();
  const edits: Array<{ message: string; extra: unknown }> = [];
  let now = 1_000;
  mock.method(Date, "now", () => now);
  const scheduler = createSchedulerForEdits(edits, logger);

  const reporter = createProgressReporter({
    scheduler,
    chatId: 1234,
    fileName: "movie.mp4",
    logger,
    messageId: 10,
    statusMessageId: 99,
    progressMinIntervalMs: 1_000,
    progressPercentStep: 5,
    getStatusMarkup: () => createDeleteButtonReplyMarkup("token"),
  });

  reporter.report({ downloadedBytes: 12, totalBytes: 100, percent: 12 });
  await scheduler.whenIdle();
  now = 2_000;
  reporter.report({ downloadedBytes: 13, totalBytes: 100, percent: 13 });
  reporter.report({ downloadedBytes: 16, totalBytes: 100, percent: 16 });
  await scheduler.whenIdle();
  await reporter.complete({ outputPath: "/tmp/movie.mp4", bytes: 100 }, async () => ({ message_id: 1 }));
  await scheduler.whenIdle();

  assert.deepEqual(edits, [
    {
      message: "Downloading movie.mp4: 12% (12 B of 100 B)",
      extra: createDeleteButtonReplyMarkup("token"),
    },
    {
      message: "Downloading movie.mp4: 16% (16 B of 100 B)",
      extra: createDeleteButtonReplyMarkup("token"),
    },
    {
      message: "Saved movie.mp4 to /tmp/movie.mp4 (100 B)",
      extra: createDeleteButtonReplyMarkup("token"),
    },
  ]);
});

test("progress reporter can refresh the active status with delete markup", async () => {
  const edits: Array<{ message: string; extra: unknown }> = [];
  const reporter = createProgressReporter({
    scheduler: createSchedulerForEdits(edits, createLoggerSpy()),
    chatId: 1234,
    fileName: "movie.mp4",
    logger: createLoggerSpy(),
    messageId: 10,
    statusMessageId: 99,
    getStatusMarkup: () => createDeleteButtonReplyMarkup("token"),
  });

  await reporter.refresh();

  assert.deepEqual(edits, [
    {
      message: "Download started: movie.mp4",
      extra: createDeleteButtonReplyMarkup("token"),
    },
  ]);
});

test("progress reporter stops editing after the file has been deleted", async () => {
  const edits: string[] = [];
  let deleted = false;
  const logger = createLoggerSpy();
  const scheduler = new StatusEditScheduler(
    async (_chatId, _messageId, message) => {
      edits.push(message);
    },
    logger,
    0,
  );
  const reporter = createProgressReporter({
    scheduler,
    chatId: 1234,
    fileName: "movie.mp4",
    logger,
    messageId: 10,
    statusMessageId: 99,
    isDeleted: () => deleted,
  });

  reporter.report({ downloadedBytes: 50, totalBytes: 100, percent: 50 });
  await scheduler.whenIdle();
  deleted = true;
  reporter.report({ downloadedBytes: 100, totalBytes: 100, percent: 100 });
  await reporter.complete({ outputPath: "/tmp/movie.mp4", bytes: 100 }, async () => ({ message_id: 1 }));
  await scheduler.whenIdle();

  assert.deepEqual(edits, ["Downloading movie.mp4: 50% (50 B of 100 B)"]);
});

test("progress reporter throttles byte-only updates by time interval", async () => {
  const logger = createLoggerSpy();
  const edits: string[] = [];
  let now = 5_000;
  mock.method(Date, "now", () => now);
  const scheduler = new StatusEditScheduler(
    async (_chatId, _messageId, message) => {
      edits.push(message);
    },
    logger,
    0,
  );

  const reporter = createProgressReporter({
    scheduler,
    chatId: 1234,
    fileName: "movie.mp4",
    logger,
    messageId: 10,
    statusMessageId: 99,
    progressMinIntervalMs: 3_000,
  });

  reporter.report({ downloadedBytes: 1024 });
  await scheduler.whenIdle();
  now = 6_000;
  reporter.report({ downloadedBytes: 2048 });
  now = 8_500;
  reporter.report({ downloadedBytes: 4096 });
  await scheduler.whenIdle();
  await reporter.fail(async () => ({ message_id: 1 }));
  await scheduler.whenIdle();

  assert.deepEqual(edits, [
    "Downloading movie.mp4: 1.00 KB downloaded",
    "Downloading movie.mp4: 4.00 KB downloaded",
    "Failed to download movie.mp4. Check the logs for details.",
  ]);
});

test("progress reporter sends standalone replies when no status message exists", async () => {
  const replies: string[] = [];
  const reporter = createProgressReporter({
    scheduler: new StatusEditScheduler(async () => {
      throw new Error("should not edit without a status message");
    }, createLoggerSpy(), 0),
    chatId: 1234,
    fileName: "movie.mp4",
    logger: createLoggerSpy(),
    messageId: 10,
  });

  await reporter.complete({ outputPath: "/tmp/movie.mp4", bytes: undefined }, async (message) => {
    replies.push(message);
    return { message_id: 1 };
  });
  await reporter.fail(async (message) => {
    replies.push(message);
    return { message_id: 2 };
  });

  assert.deepEqual(replies, [
    "Saved movie.mp4 to /tmp/movie.mp4 (unknown size)",
    "Failed to download movie.mp4. Check the logs for details.",
  ]);
});

test("progress reporter logs edit and standalone reply failures", async () => {
  const logger = createLoggerSpy();
  const reporterWithStatus = createProgressReporter({
    scheduler: new StatusEditScheduler(
      async () => {
        throw new Error("edit failed");
      },
      logger,
      0,
      1,
    ),
    chatId: 1234,
    fileName: "movie.mp4",
    logger,
    messageId: 10,
    statusMessageId: 99,
  });
  const reporterWithoutStatus = createProgressReporter({
    scheduler: new StatusEditScheduler(async () => {}, logger, 0),
    chatId: 1234,
    fileName: "clip.mp4",
    logger,
    messageId: 11,
  });

  reporterWithStatus.report({ downloadedBytes: 50, totalBytes: 100, percent: 50 });
  await reporterWithStatus.complete({ outputPath: "/tmp/movie.mp4", bytes: 100 }, async () => ({ message_id: 1 }));
  await reporterWithoutStatus.fail(async () => {
    throw new Error("reply failed");
  });

  assert.ok(logger.entries.some((entry) => entry.message.includes("Failed to edit Telegram progress message")));
  assert.equal(logger.entries.filter((entry) => entry.message.includes("Failed to send Telegram reply")).length, 1);
});

test("confirming delete aborts the active download and suppresses failed status", async () => {
  await withTempDir(async (dir) => {
    const logger = createLoggerSpy();
    const outputPath = path.join(dir, "Movies", "movie.mp4");
    const edits: Array<{ message: string; extra?: DeleteButtonReplyMarkup }> = [];
    const callbackAnswers: string[] = [];
    let capturedSignal: AbortSignal | undefined;
    let resolveOutputRegistered: () => void = () => {};
    const outputRegistered = new Promise<void>((resolve) => {
      resolveOutputRegistered = resolve;
    });
    let capturedTelegramUserId: number | undefined;
    const fakeDownloader = {
      async downloadFromBotMessage(request: DownloadRequest) {
        capturedTelegramUserId = request.telegramUserId;
        capturedSignal = request.signal;
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, "partial", "utf8");
        await request.onOutputPath?.(outputPath);
        resolveOutputRegistered();

        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new DownloadCanceledError()), { once: true });
        });
      },
    };
    const service = new BotService(
      createSettings({
        download: {
          directory: dir,
        },
      }),
      fakeDownloader as never,
      logger,
    );
    (
      service as unknown as {
        bot: {
          telegram: {
            editMessageText: (
              _chatId: number,
              _messageId: number,
              _inlineMessageId: undefined,
              message: string,
              extra?: DeleteButtonReplyMarkup,
            ) => Promise<unknown>;
          };
        };
      }
    ).bot.telegram.editMessageText = async (_chatId, _messageId, _inlineMessageId, message, extra) => {
      edits.push({ message, extra });
    };
    const downloadAndNotify = (
      service as unknown as {
        downloadAndNotify: (
          fromUserId: number,
          message: unknown,
          chatId: number,
          reply: (message: string) => Promise<{ message_id?: number }>,
          statusMessageId: number,
        ) => Promise<void>;
      }
    ).downloadAndNotify.bind(service);
    const handleDeleteButton = (
      service as unknown as {
        handleDeleteButton: (ctx: unknown) => Promise<void>;
      }
    ).handleDeleteButton.bind(service);

    const downloadPromise = downloadAndNotify(
      1234,
      {
        message_id: 10,
        date: 1_000,
        video: { file_name: "movie.mp4" },
      },
      1234,
      async () => ({ message_id: 1 }),
      99,
    );

    await outputRegistered;
    assert.equal(capturedTelegramUserId, 1234);

    const deleteCallbackData = edits
      .flatMap((edit) => edit.extra?.reply_markup.inline_keyboard[0] ?? [])
      .find((button) => button.text === "Delete file")?.callback_data;
    const deleteCallback = parseDeleteCallbackData(deleteCallbackData);

    assert.equal(deleteCallback?.action, "ask");
    assert.equal(capturedSignal?.aborted, false);

    await handleDeleteButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-delete:confirm:${deleteCallback?.token}`,
        message: {
          message_id: 99,
          chat: { id: 1234 },
          text: "Downloading movie.mp4: 10% (1 B of 10 B)",
        },
      },
      telegram: {
        editMessageText: async (_chatId: number, _messageId: number, _inlineMessageId: undefined, message: string) => {
          edits.push({ message });
        },
      },
      answerCbQuery: async (message: string) => {
        callbackAnswers.push(message);
      },
    });
    await downloadPromise;

    assert.equal(capturedSignal?.aborted, true);
    await assert.rejects(stat(outputPath));
    assert.equal(callbackAnswers.at(-1), "File deleted.");
    assert.match(edits.at(-1)?.message ?? "", /Deleted file:/);
    assert.equal(edits.some((edit) => edit.message.includes("Failed to download")), false);
    assert.equal(logger.entries.some((entry) => entry.level === "error"), false);
  });
});

test("download semaphore limits active acquisitions to maxConcurrent", async () => {
  const semaphore = new DownloadSemaphore(3);
  const releaseCallbacks: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;

  const tasks = Array.from({ length: 4 }, async () => {
    await semaphore.acquire();

    try {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releaseCallbacks.push(() => {
          active -= 1;
          resolve();
        });
      });
    } finally {
      semaphore.release();
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(maxActive, 3);

  while (releaseCallbacks.length > 0) {
    releaseCallbacks.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await Promise.all(tasks);
  assert.equal(active, 0);
});

test("/files command replies with private message for unauthorized users", async () => {
  await withTempDir(async (dir) => {
    const service = new BotService(
      createSettings({
        download: {
          directory: dir,
        },
      }),
      {} as never,
      createLoggerSpy(),
    );
    const handleFilesCommand = (
      service as unknown as {
        handleFilesCommand: (ctx: unknown) => Promise<void>;
      }
    ).handleFilesCommand.bind(service);
    const replies: string[] = [];

    await handleFilesCommand({
      from: { id: 999 },
      reply: async (message: string) => {
        replies.push(message);
        return { message_id: 99 };
      },
    });

    assert.deepEqual(replies, ["This bot is private."]);
  });
});

test("/files command replies with the download tree for authorized users", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "Movies"), { recursive: true });
    await writeFile(path.join(dir, "loose.mp4"), "video", "utf8");

    const service = new BotService(
      createSettings({
        download: {
          directory: dir,
        },
      }),
      {} as never,
      createLoggerSpy(),
    );
    const handleFilesCommand = (
      service as unknown as {
        handleFilesCommand: (ctx: unknown) => Promise<void>;
      }
    ).handleFilesCommand.bind(service);
    const replies: Array<{ message: string; extra?: unknown }> = [];

    await handleFilesCommand({
      from: { id: 1234 },
      chat: { id: 5678 },
      reply: async (message: string, extra?: unknown) => {
        replies.push({ message, extra });
        return { message_id: 99 };
      },
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0].message, /Files in \//);
    assert.match(replies[0].message, /Folder Movies\/ \[protected\]/);
    assert.match(replies[0].message, /File loose\.mp4/);
    assert.ok(replies[0].extra);
  });
});

test("/files command resets the existing file tree message to a fresh root view", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "loose.mp4"), "video", "utf8");

    const service = new BotService(
      createSettings({
        download: {
          directory: dir,
        },
      }),
      {} as never,
      createLoggerSpy(),
    );
    const handleFilesCommand = (
      service as unknown as {
        handleFilesCommand: (ctx: unknown) => Promise<void>;
      }
    ).handleFilesCommand.bind(service);
    const replies: Array<{ message: string; extra?: unknown }> = [];
    const edits: Array<{ chatId: number; messageId: number; message: string; extra?: unknown }> = [];
    const createContext = () => ({
      from: { id: 1234 },
      chat: { id: 5678 },
      reply: async (message: string, extra?: unknown) => {
        replies.push({ message, extra });
        return { message_id: 100 };
      },
      telegram: {
        editMessageText: async (
          chatId: number,
          messageId: number,
          _inlineMessageId: undefined,
          message: string,
          extra?: unknown,
        ) => {
          edits.push({ chatId, messageId, message, extra });
        },
      },
    });

    await handleFilesCommand(createContext());
    await mkdir(path.join(dir, "Movies"), { recursive: true });

    await handleFilesCommand(createContext());

    assert.equal(replies.length, 1);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.chatId, 5678);
    assert.equal(edits[0]?.messageId, 100);
    assert.match(edits[0]?.message ?? "", /Files in \//);
    assert.match(edits[0]?.message ?? "", /Folder Movies\/ \[protected\]/);
    assert.match(edits[0]?.message ?? "", /File loose\.mp4/);
  });
});

test("/usage command replies with private message for unauthorized users", async () => {
  const service = new BotService(createSettings(), {} as never, createLoggerSpy(), {
    async createReport() {
      throw new Error("should not fetch usage for unauthorized users");
    },
  });
  const handleUsageCommand = (
    service as unknown as {
      handleUsageCommand: (ctx: unknown) => Promise<void>;
    }
  ).handleUsageCommand.bind(service);
  const replies: string[] = [];

  await handleUsageCommand({
    from: { id: 999 },
    message: {
      text: "/usage",
    },
    reply: async (message: string) => {
      replies.push(message);
      return { message_id: 99 };
    },
  });

  assert.deepEqual(replies, ["This bot is private."]);
});

test("/usage command replies to the requester with OpenAI usage", async () => {
  let requestedRange: string | undefined;
  const service = new BotService(createSettings(), {} as never, createLoggerSpy(), {
    async createReport(rangeArg?: string) {
      requestedRange = rangeArg;
      return "OpenAI usage\nTotal requests: 12\nTotal cost: $3.00\nCost per request: $0.2500";
    },
  });
  const handleUsageCommand = (
    service as unknown as {
      handleUsageCommand: (ctx: unknown) => Promise<void>;
    }
  ).handleUsageCommand.bind(service);
  const replies: string[] = [];

  await handleUsageCommand({
    from: { id: 1234 },
    message: {
      text: "/usage today",
    },
    reply: async (message: string) => {
      replies.push(message);
      return { message_id: 99 };
    },
  });

  assert.equal(requestedRange, "today");
  assert.deepEqual(replies, ["OpenAI usage\nTotal requests: 12\nTotal cost: $3.00\nCost per request: $0.2500"]);
});

test("/restart command replies with private message for unauthorized users", async () => {
  let restartCount = 0;
  const service = new BotService(createSettings(), {} as never, createLoggerSpy(), undefined, () => {
    restartCount += 1;
  }, 0);
  const handleRestartCommand = (
    service as unknown as {
      handleRestartCommand: (ctx: unknown) => Promise<void>;
    }
  ).handleRestartCommand.bind(service);
  const replies: string[] = [];

  await handleRestartCommand({
    from: { id: 999 },
    reply: async (message: string) => {
      replies.push(message);
      return { message_id: 99 };
    },
  });

  assert.deepEqual(replies, ["This bot is private."]);
  assert.equal(restartCount, 0);
});

test("/restart command replies and requests service restart for authorized users", async () => {
  let restartCount = 0;
  const logger = createLoggerSpy();
  const service = new BotService(createSettings(), {} as never, logger, undefined, () => {
    restartCount += 1;
  }, 0);
  const handleRestartCommand = (
    service as unknown as {
      handleRestartCommand: (ctx: unknown) => Promise<void>;
    }
  ).handleRestartCommand.bind(service);
  const replies: string[] = [];

  await handleRestartCommand({
    from: { id: 1234 },
    reply: async (message: string) => {
      replies.push(message);
      return { message_id: 99 };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(replies, ["Restarting service..."]);
  assert.equal(restartCount, 1);
  assert.ok(logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("Restart requested")));
});

test("file tree confirmation callback deletes the selected file and refreshes the parent directory", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "loose.mp4");
    const edits: Array<{ message: string; extra?: unknown }> = [];
    const callbackAnswers: string[] = [];

    await writeFile(filePath, "video", "utf8");

    const service = new BotService(
      createSettings({
        download: {
          directory: dir,
        },
      }),
      {} as never,
      createLoggerSpy(),
    );
    const fileTree = (
      service as unknown as {
        fileTree: FileTreeBrowser;
      }
    ).fileTree;
    const handleFileTreeButton = (
      service as unknown as {
        handleFileTreeButton: (ctx: unknown) => Promise<void>;
      }
    ).handleFileTreeButton.bind(service);
    const rootView = await fileTree.renderRoot();
    const fileButton = rootView.extra.reply_markup.inline_keyboard.flat().find((button) => button.text === "File loose.mp4");

    assert.ok(fileButton);
    assert.ok("callback_data" in fileButton);

    const fileCallback = fileTree.parseCallbackData(fileButton.callback_data);

    assert.ok(fileCallback);
    assert.equal(fileCallback?.action, "select");

    await handleFileTreeButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `file-tree:confirm:${fileCallback.token}`,
        message: {
          message_id: 99,
          chat: { id: 1234 },
          text: "Selected file: loose.mp4",
        },
      },
      telegram: {
        editMessageText: async (_chatId: number, _messageId: number, _inlineMessageId: undefined, message: string, extra?: unknown) => {
          edits.push({ message, extra });
        },
      },
      answerCbQuery: async (message: string) => {
        callbackAnswers.push(message);
      },
    });

    await assert.rejects(stat(filePath));
    assert.equal(callbackAnswers.at(-1), "Item deleted.");
    assert.match(edits.at(-1)?.message ?? "", /Deleted: loose\.mp4/);
    assert.match(edits.at(-1)?.message ?? "", /Files in \//);
  });
});

