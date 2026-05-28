import { Telegraf } from "telegraf";
import type { Message } from "telegraf/types";
import type { DownloadProgress, DownloadResult } from "./downloader.js";
import type { TelegramDownloader } from "./downloader.js";
import type { Logger } from "./logger.js";
import type { Settings } from "./settings.js";

type DownloadableMessage = Message.VideoMessage | Message.DocumentMessage;
type TelegramStatusMessage = { message_id?: number };
type ReplyFn = (message: string) => Promise<TelegramStatusMessage>;
type EditStatusFn = (messageId: number, message: string) => Promise<unknown>;

const PROGRESS_PERCENT_STEP = 5;
const PROGRESS_MIN_INTERVAL_MS = 3_000;

export class BotService {
  private readonly bot: Telegraf;
  private readonly allowedUserIds: Set<number>;

  constructor(
    private readonly settings: Settings,
    private readonly downloader: TelegramDownloader,
    private readonly logger: Logger,
  ) {
    this.bot = new Telegraf(settings.telegram.botToken);
    this.allowedUserIds = new Set(settings.telegram.allowedUserIds);
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.bot.launch();
    this.logger.info("Telegram bot started.");
  }

  async stop(reason = "shutdown"): Promise<void> {
    this.bot.stop(reason);
    this.logger.info("Telegram bot stopped.");
  }

  private registerHandlers(): void {
    this.bot.start(async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) {
        await ctx.reply("This bot is private.");
        return;
      }

      await ctx.reply("Send or forward a video/document here and I will download it to the configured directory.");
    });

    this.bot.on("video", async (ctx) => {
      await this.handleDownloadableMessage(
        ctx.from?.id,
        ctx.message,
        (message) => ctx.reply(message),
        (messageId, message) => ctx.telegram.editMessageText(ctx.message.chat.id, messageId, undefined, message),
      );
    });

    this.bot.on("document", async (ctx) => {
      await this.handleDownloadableMessage(
        ctx.from?.id,
        ctx.message,
        (message) => ctx.reply(message),
        (messageId, message) => ctx.telegram.editMessageText(ctx.message.chat.id, messageId, undefined, message),
      );
    });

    this.bot.on("message", async (ctx) => {
      if (this.isAllowed(ctx.from?.id)) {
        await ctx.reply("I can download Telegram videos and document-style video files. Send one here to start.");
      }
    });

    this.bot.catch((error, ctx) => {
      this.logger.error(`Bot error while handling update ${ctx.update.update_id}`, error);
    });
  }

  private async handleDownloadableMessage(
    fromUserId: number | undefined,
    message: DownloadableMessage,
    reply: ReplyFn,
    editStatus: EditStatusFn,
  ): Promise<void> {
    if (!this.isAllowed(fromUserId)) {
      this.logger.warn(`Ignored message ${message.message_id} from unauthorized user ${fromUserId ?? "unknown"}.`);
      return;
    }

    const fileName = getDisplayFileName(message);
    const statusMessage = await this.safeReply(reply, `Download started: ${fileName}`);
    void this.downloadAndNotify(message, reply, editStatus, statusMessage?.message_id);
  }

  private async downloadAndNotify(
    message: DownloadableMessage,
    reply: ReplyFn,
    editStatus: EditStatusFn,
    statusMessageId: number | undefined,
  ): Promise<void> {
    const fileName = getDisplayFileName(message);
    const progressReporter = createProgressReporter({
      editStatus,
      fileName,
      logger: this.logger,
      messageId: message.message_id,
      statusMessageId,
    });

    try {
      const suggestedFileName = getSuggestedFileName(message);
      const result = await this.downloader.downloadFromBotMessage({
        botMessageId: message.message_id,
        mediaKind: "video" in message ? "video" : "document",
        suggestedFileName,
        receivedAt: message.date,
        caption: getCaption(message),
        onProgress: progressReporter.report,
      });

      this.logger.info(`Saved Telegram media to ${result.outputPath}`, {
        bytes: result.bytes,
      });
      await progressReporter.complete(result, reply);
    } catch (error) {
      this.logger.error(`Failed to download Telegram message ${message.message_id}.`, error);
      await progressReporter.fail(reply);
    }
  }

  private isAllowed(userId: number | undefined): boolean {
    return userId !== undefined && this.allowedUserIds.has(userId);
  }

  private async safeReply(reply: ReplyFn, message: string): Promise<TelegramStatusMessage | undefined> {
    try {
      return await reply(message);
    } catch (error) {
      this.logger.warn("Failed to send Telegram reply.", error);
      return undefined;
    }
  }
}

interface ProgressReporterOptions {
  editStatus: EditStatusFn;
  fileName: string;
  logger: Logger;
  messageId: number;
  statusMessageId?: number;
}

function createProgressReporter(options: ProgressReporterOptions): {
  report: (progress: DownloadProgress) => void;
  complete: (result: DownloadResult, reply: ReplyFn) => Promise<void>;
  fail: (reply: ReplyFn) => Promise<void>;
} {
  let lastPercent = -1;
  let lastUpdateAt = 0;
  let editQueue = Promise.resolve();

  const sendStatus = (message: string): void => {
    if (!options.statusMessageId) {
      return;
    }

    editQueue = editQueue
      .then(async () => {
        await options.editStatus(options.statusMessageId as number, message);
      })
      .catch((error: unknown) => {
        options.logger.warn("Failed to edit Telegram progress message.", error);
      });
  };

  const report = (progress: DownloadProgress): void => {
    const percent = progress.percent;
    const now = Date.now();

    if (percent === undefined) {
      if (now - lastUpdateAt < PROGRESS_MIN_INTERVAL_MS) {
        return;
      }

      lastUpdateAt = now;
      options.logger.info(`Downloading Telegram message ${options.messageId}: ${formatBytes(progress.downloadedBytes)} downloaded`);
      sendStatus(`Downloading ${options.fileName}: ${formatBytes(progress.downloadedBytes)} downloaded`);
      return;
    }

    const steppedPercent = Math.floor(percent / PROGRESS_PERCENT_STEP) * PROGRESS_PERCENT_STEP;

    if (steppedPercent <= lastPercent && now - lastUpdateAt < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastPercent = steppedPercent;
    lastUpdateAt = now;
    options.logger.info(`Downloading Telegram message ${options.messageId}: ${percent}%`);
    sendStatus(
      `Downloading ${options.fileName}: ${percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)})`,
    );
  };

  const complete = async (result: DownloadResult, reply: ReplyFn): Promise<void> => {
    const message = `Saved ${options.fileName} to ${result.outputPath} (${formatBytes(result.bytes)})`;

    if (options.statusMessageId) {
      sendStatus(message);
      await editQueue;
      return;
    }

    await safeStandaloneReply(reply, options.logger, message);
  };

  const fail = async (reply: ReplyFn): Promise<void> => {
    const message = `Failed to download ${options.fileName}. Check the logs for details.`;

    if (options.statusMessageId) {
      sendStatus(message);
      await editQueue;
      return;
    }

    await safeStandaloneReply(reply, options.logger, message);
  };

  return { report, complete, fail };
}

async function safeStandaloneReply(reply: ReplyFn, logger: Logger, message: string): Promise<void> {
  try {
    await reply(message);
  } catch (error) {
    logger.warn("Failed to send Telegram reply.", error);
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return "unknown size";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function getSuggestedFileName(message: DownloadableMessage): string | undefined {
  if ("document" in message && message.document.file_name) {
    return message.document.file_name;
  }

  if ("video" in message && "file_name" in message.video && typeof message.video.file_name === "string") {
    return message.video.file_name;
  }

  return undefined;
}

function getDisplayFileName(message: DownloadableMessage): string {
  return getSuggestedFileName(message) ?? `${"video" in message ? "video" : "document"}-${message.message_id}`;
}

function getCaption(message: DownloadableMessage): string | undefined {
  if ("caption" in message) {
    return message.caption;
  }

  return undefined;
}
