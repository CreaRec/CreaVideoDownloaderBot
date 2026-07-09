import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import type { Message } from "telegraf/types";
import {
  createDeleteButtonReplyMarkup,
  createDeleteConfirmationReplyMarkup,
  createDeleteConfirmationStatusMessage,
  createDeleteFailedStatusMessage,
  createDeletedStatusMessage,
  deleteDownloadedFile,
  DeleteButtonState,
  parseDeleteCallbackData,
  type DeleteButtonReplyMarkup,
} from "./delete-buttons.js";
import { isDownloadCanceled, type DownloadProgress, type DownloadResult } from "./downloader.js";
import type { TelegramDownloader } from "./downloader.js";
import { FileTreeBrowser } from "./file-tree.js";
import type { Logger } from "./logger.js";
import { OpenAIUsageService, type OpenAIUsageReporter } from "./openai-usage.js";
import { DownloadSemaphore } from "./download-semaphore.js";
import type { Settings } from "./settings.js";
import { isConfiguredUser } from "./settings.js";
import { StatusEditScheduler, type StatusReplyFn } from "./status-edit-scheduler.js";

type DownloadableMessage = Message.VideoMessage | Message.DocumentMessage;
type TelegramStatusMessage = { message_id?: number };
type ReplyFn = (message: string) => Promise<TelegramStatusMessage>;
type CallbackMessage = { message_id: number; chat: { id: number }; text?: string };
type RestartServiceFn = () => void;

const DEFAULT_PROGRESS_PERCENT_STEP = 10;
const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 10_000;
const RESTART_DELAY_MS = 1_000;

export class BotService {
  private readonly bot: Telegraf;
  private readonly deleteButtons: DeleteButtonState;
  private readonly fileTree: FileTreeBrowser;
  private readonly fileTreeMessageIdByChat = new Map<number, number>();
  private readonly activeDownloadsByDeleteToken = new Map<string, AbortController>();
  private readonly statusScheduler: StatusEditScheduler;
  private readonly downloadSemaphore: DownloadSemaphore;
  private readonly progressMinIntervalMs: number;
  private readonly progressPercentStep: number;

  constructor(
    private readonly settings: Settings,
    private readonly downloader: TelegramDownloader,
    private readonly logger: Logger,
    private readonly openAIUsage: OpenAIUsageReporter = new OpenAIUsageService(settings, logger),
    private readonly restartService: RestartServiceFn = defaultRestartService,
    private readonly restartDelayMs = RESTART_DELAY_MS,
  ) {
    this.bot = new Telegraf(settings.telegram.botToken);
    this.deleteButtons = DeleteButtonState.forStateDirectory(settings.app.stateDirectory);
    this.fileTree = new FileTreeBrowser(settings.download.directory);
    this.statusScheduler = new StatusEditScheduler(
      (chatId, messageId, message, extra) => this.bot.telegram.editMessageText(chatId, messageId, undefined, message, extra),
      logger,
      settings.app.statusEditMinGapMs,
    );
    this.downloadSemaphore = new DownloadSemaphore(settings.download.maxConcurrent);
    this.progressMinIntervalMs = settings.app.statusUpdateMinIntervalMs;
    this.progressPercentStep = settings.app.statusUpdatePercentStep;
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

    this.bot.command("files", async (ctx) => {
      await this.handleFilesCommand(ctx);
    });

    this.bot.command("usage", async (ctx) => {
      await this.handleUsageCommand(ctx);
    });

    this.bot.command("restart", async (ctx) => {
      await this.handleRestartCommand(ctx);
    });

    this.bot.on("video", async (ctx) => {
      await this.handleDownloadableMessage(
        ctx.from?.id,
        ctx.message,
        ctx.message.chat.id,
        (message) => ctx.reply(message),
      );
    });

    this.bot.on("document", async (ctx) => {
      await this.handleDownloadableMessage(
        ctx.from?.id,
        ctx.message,
        ctx.message.chat.id,
        (message) => ctx.reply(message),
      );
    });

    this.bot.action(/^file-delete:/, async (ctx) => {
      await this.handleDeleteButton(ctx);
    });

    this.bot.action(/^file-tree:/, async (ctx) => {
      await this.handleFileTreeButton(ctx);
    });

    this.bot.on("message", async (ctx) => {
      if (this.isAllowed(ctx.from?.id)) {
        await ctx.reply(
          "I can download Telegram videos and document-style video files. Send one here to start, use /files to browse downloaded files, use /usage for OpenAI usage, or use /restart to restart the service.",
        );
      }
    });

    this.bot.catch((error, ctx) => {
      this.logger.error(`Bot error while handling update ${ctx.update.update_id}`, error);
    });
  }

  private async handleDownloadableMessage(
    fromUserId: number | undefined,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAllowed(fromUserId)) {
      this.logger.warn(`Ignored message ${message.message_id} from unauthorized user ${fromUserId ?? "unknown"}.`);
      return;
    }

    const fileName = getDisplayFileName(message);
    const statusMessage = await this.safeReply(reply, `Download started: ${fileName}`);
    void this.runDownloadWithConcurrency(fromUserId, message, chatId, reply, statusMessage?.message_id);
  }

  private async runDownloadWithConcurrency(
    fromUserId: number,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
    statusMessageId: number | undefined,
  ): Promise<void> {
    const fileName = getDisplayFileName(message);

    if (statusMessageId !== undefined && this.downloadSemaphore.active >= this.settings.download.maxConcurrent) {
      await this.statusScheduler.scheduleTerminal(
        chatId,
        statusMessageId,
        `Queued: ${fileName} (${this.downloadSemaphore.active} active)`,
        undefined,
        reply,
      );
    }

    await this.downloadSemaphore.acquire();

    try {
      await this.downloadAndNotify(fromUserId, message, chatId, reply, statusMessageId);
    } finally {
      this.downloadSemaphore.release();
    }
  }

  private async downloadAndNotify(
    fromUserId: number,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
    statusMessageId: number | undefined,
  ): Promise<void> {
    const fileName = getDisplayFileName(message);
    let deleteToken: string | undefined;
    const abortController = new AbortController();
    const progressReporter = createProgressReporter({
      scheduler: this.statusScheduler,
      chatId,
      fileName,
      logger: this.logger,
      messageId: message.message_id,
      statusMessageId,
      progressMinIntervalMs: this.progressMinIntervalMs,
      progressPercentStep: this.progressPercentStep,
      getStatusMarkup: () => {
        if (!deleteToken || this.deleteButtons.getCached(deleteToken)?.deletedAt) {
          return undefined;
        }

        return createDeleteButtonReplyMarkup(deleteToken);
      },
      isDeleted: () => (deleteToken ? this.deleteButtons.getCached(deleteToken)?.deletedAt !== undefined : false),
    });

    try {
      const suggestedFileName = getSuggestedFileName(message);
      const result = await this.downloader.downloadFromBotMessage({
        botMessageId: message.message_id,
        telegramUserId: fromUserId,
        mediaKind: "video" in message ? "video" : "document",
        suggestedFileName,
        receivedAt: message.date,
        caption: getCaption(message),
        signal: abortController.signal,
        onOutputPath: async (outputPath) => {
          if (!statusMessageId) {
            return;
          }

          const record = await this.deleteButtons.upsertForStatus({
            chatId,
            messageId: statusMessageId,
            filePath: outputPath,
            originalText: progressReporter.getLastMessage(),
          });
          deleteToken = record.token;
          this.activeDownloadsByDeleteToken.set(record.token, abortController);
          await progressReporter.refresh();
        },
        onProgress: progressReporter.report,
      });

      this.logger.info(`Saved Telegram media to ${result.outputPath}`, {
        bytes: result.bytes,
      });
      await progressReporter.complete(result, reply);
    } catch (error) {
      if (isDownloadCanceled(error)) {
        this.logger.info(`Canceled Telegram download for message ${message.message_id}.`);
        return;
      }

      this.logger.error(`Failed to download Telegram message ${message.message_id}.`, error);
      await progressReporter.fail(reply);
    } finally {
      if (deleteToken && this.activeDownloadsByDeleteToken.get(deleteToken) === abortController) {
        this.activeDownloadsByDeleteToken.delete(deleteToken);
      }
    }
  }

  private async handleDeleteButton(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await this.answerCallback(ctx, "This bot is private.");
      return;
    }

    const data = "callbackQuery" in ctx && ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const callback = parseDeleteCallbackData(data);

    if (!callback) {
      await this.answerCallback(ctx, "Unknown delete action.");
      return;
    }

    const record = await this.deleteButtons.get(callback.token);

    if (!record) {
      await this.answerCallback(ctx, "Delete action is no longer available.");
      return;
    }

    const message = getCallbackMessage(ctx);

    if (!message || message.chat.id !== record.chatId || message.message_id !== record.messageId) {
      await this.answerCallback(ctx, "Delete action does not match this message.");
      return;
    }

    const originalText = message.text && !message.text.includes("\n\nDelete this downloaded file?") ? message.text : record.originalText;
    await this.deleteButtons.updateOriginalText(record.token, originalText);

    if (callback.action === "ask") {
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        createDeleteConfirmationStatusMessage(originalText),
        createDeleteConfirmationReplyMarkup(record.token),
      );
      await this.answerCallback(ctx, "Confirm deletion.");
      return;
    }

    if (callback.action === "cancel") {
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        originalText,
        createDeleteButtonReplyMarkup(record.token),
      );
      await this.answerCallback(ctx, "Deletion cancelled.");
      return;
    }

    try {
      this.activeDownloadsByDeleteToken.get(record.token)?.abort();
      const outcome = await deleteDownloadedFile(record.filePath, this.settings.download.directory);
      await this.deleteButtons.markDeleted(record.token);
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        createDeletedStatusMessage(originalText, record.filePath),
      );
      await this.answerCallback(ctx, outcome === "missing" ? "File was already missing." : "File deleted.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to delete downloaded file ${record.filePath}.`, error);
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        createDeleteFailedStatusMessage(originalText, record.filePath, reason),
        createDeleteButtonReplyMarkup(record.token),
      );
      await this.answerCallback(ctx, "Could not delete file.");
    }
  }

  private async handleFilesCommand(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await ctx.reply("This bot is private.");
      return;
    }

    const chatId = ctx.chat?.id;

    if (chatId === undefined) {
      return;
    }

    this.fileTree.reset();
    const view = await this.fileTree.renderRoot();
    const existingMessageId = this.fileTreeMessageIdByChat.get(chatId);

    if (existingMessageId !== undefined) {
      try {
        await ctx.telegram.editMessageText(chatId, existingMessageId, undefined, view.message, view.extra);
        return;
      } catch (error) {
        this.logger.warn("Could not reset existing file tree message; sending a new one.", error);
        this.fileTreeMessageIdByChat.delete(chatId);
      }
    }

    const message = await ctx.reply(view.message, view.extra);
    this.fileTreeMessageIdByChat.set(chatId, message.message_id);
  }

  private async handleUsageCommand(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await ctx.reply("This bot is private.");
      return;
    }

    await ctx.reply(await this.openAIUsage.createReport(getCommandArgument(ctx)));
  }

  private async handleRestartCommand(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await ctx.reply("This bot is private.");
      return;
    }

    await ctx.reply("Restarting service...");
    this.logger.warn(`Restart requested by Telegram user ${ctx.from?.id}.`);

    const timeout = setTimeout(() => {
      this.restartService();
    }, this.restartDelayMs);
    timeout.unref();
  }

  private async handleFileTreeButton(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await this.answerCallback(ctx, "This bot is private.");
      return;
    }

    const data = "callbackQuery" in ctx && ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const callback = this.fileTree.parseCallbackData(data);

    if (!callback) {
      await this.answerCallback(ctx, "Unknown file action.");
      return;
    }

    const message = getCallbackMessage(ctx);

    if (!message) {
      await this.answerCallback(ctx, "Could not update file tree.");
      return;
    }

    try {
      if (callback.action === "confirm") {
        const relativePath = this.fileTree.getRelativePathForToken(callback.token);
        const parentToken = this.fileTree.getParentToken(callback.token);
        const outcome = await this.fileTree.deleteToken(callback.token);

        if (outcome === "protected") {
          await this.answerCallback(ctx, "This item cannot be deleted.");
          return;
        }

        const view = await this.fileTree.renderDirectoryToken(parentToken);
        await ctx.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          `${outcome === "missing" ? "Item was already missing" : "Deleted"}: ${relativePath}\n\n${view.message}`,
          view.extra,
        );
        await this.answerCallback(ctx, outcome === "missing" ? "Item was already missing." : "Item deleted.");
        return;
      }

      const view =
        callback.action === "open" || callback.action === "refresh"
          ? await this.fileTree.renderDirectoryToken(callback.token)
          : callback.action === "delete"
            ? await this.fileTree.renderDeleteConfirmationToken(callback.token)
            : await this.fileTree.renderSelectedToken(callback.token);

      await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, view.message, view.extra);
      await this.answerCallback(ctx, callback.action === "delete" ? "Confirm deletion." : "File tree updated.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn("Failed to handle file tree action.", error);
      await this.answerCallback(ctx, reason);
    }
  }

  private isAllowed(userId: number | undefined): userId is number {
    return userId !== undefined && isConfiguredUser(this.settings, userId);
  }

  private async safeReply(reply: ReplyFn, message: string): Promise<TelegramStatusMessage | undefined> {
    try {
      return await reply(message);
    } catch (error) {
      this.logger.warn("Failed to send Telegram reply.", error);
      return undefined;
    }
  }

  private async answerCallback(ctx: Context, message: string): Promise<void> {
    try {
      await ctx.answerCbQuery(message);
    } catch (error) {
      this.logger.warn("Failed to answer Telegram callback query.", error);
    }
  }
}

function defaultRestartService(): void {
  process.exit(1);
}

interface ProgressReporterOptions {
  scheduler: StatusEditScheduler;
  chatId: number;
  fileName: string;
  logger: Logger;
  messageId: number;
  statusMessageId?: number;
  progressMinIntervalMs?: number;
  progressPercentStep?: number;
  getStatusMarkup?: () => DeleteButtonReplyMarkup | undefined;
  isDeleted?: () => boolean;
}

export function createProgressReporter(options: ProgressReporterOptions): {
  report: (progress: DownloadProgress) => void;
  complete: (result: DownloadResult, reply: ReplyFn) => Promise<void>;
  fail: (reply: ReplyFn) => Promise<void>;
  refresh: () => Promise<void>;
  getLastMessage: () => string;
} {
  const progressMinIntervalMs = options.progressMinIntervalMs ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS;
  const progressPercentStep = options.progressPercentStep ?? DEFAULT_PROGRESS_PERCENT_STEP;
  let lastPercent = -1;
  let lastUpdateAt = 0;
  let lastMessage = `Download started: ${options.fileName}`;

  const sendProgress = (message: string): void => {
    if (!options.statusMessageId || options.isDeleted?.()) {
      return;
    }

    lastMessage = message;
    options.scheduler.scheduleProgress(
      options.chatId,
      options.statusMessageId,
      message,
      options.getStatusMarkup?.(),
    );
  };

  const sendTerminal = async (message: string, reply?: StatusReplyFn): Promise<void> => {
    if (!options.statusMessageId || options.isDeleted?.()) {
      return;
    }

    lastMessage = message;
    await options.scheduler.scheduleTerminal(
      options.chatId,
      options.statusMessageId,
      message,
      options.getStatusMarkup?.(),
      reply,
    );
  };

  const report = (progress: DownloadProgress): void => {
    const percent = progress.percent;
    const now = Date.now();

    if (percent === undefined) {
      if (now - lastUpdateAt < progressMinIntervalMs) {
        return;
      }

      lastUpdateAt = now;
      options.logger.info(`Downloading Telegram message ${options.messageId}: ${formatBytes(progress.downloadedBytes)} downloaded`);
      sendProgress(`Downloading ${options.fileName}: ${formatBytes(progress.downloadedBytes)} downloaded`);
      return;
    }

    const steppedPercent = Math.floor(percent / progressPercentStep) * progressPercentStep;

    if (steppedPercent <= lastPercent && now - lastUpdateAt < progressMinIntervalMs) {
      return;
    }

    lastPercent = steppedPercent;
    lastUpdateAt = now;
    options.logger.info(`Downloading Telegram message ${options.messageId}: ${percent}%`);
    sendProgress(
      `Downloading ${options.fileName}: ${percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)})`,
    );
  };

  const complete = async (result: DownloadResult, reply: ReplyFn): Promise<void> => {
    const message = `Saved ${options.fileName} to ${result.outputPath} (${formatBytes(result.bytes)})`;

    if (options.isDeleted?.()) {
      return;
    }

    if (options.statusMessageId) {
      await sendTerminal(message, reply);
      return;
    }

    await safeStandaloneReply(reply, options.logger, message);
  };

  const fail = async (reply: ReplyFn): Promise<void> => {
    const message = `Failed to download ${options.fileName}. Check the logs for details.`;

    if (options.isDeleted?.()) {
      return;
    }

    if (options.statusMessageId) {
      await sendTerminal(message, reply);
      return;
    }

    await safeStandaloneReply(reply, options.logger, message);
  };

  const refresh = async (): Promise<void> => {
    await sendTerminal(lastMessage);
  };

  return { report, complete, fail, refresh, getLastMessage: () => lastMessage };
}

function getCallbackMessage(ctx: Context): CallbackMessage | undefined {
  const callbackQuery = "callbackQuery" in ctx ? ctx.callbackQuery : undefined;

  if (!callbackQuery || !("message" in callbackQuery) || !callbackQuery.message) {
    return undefined;
  }

  const message = callbackQuery.message;

  if (!("message_id" in message) || !("chat" in message) || typeof message.message_id !== "number") {
    return undefined;
  }

  const chat = message.chat;

  if (!("id" in chat) || typeof chat.id !== "number") {
    return undefined;
  }

  return {
    message_id: message.message_id,
    chat: { id: chat.id },
    text: "text" in message && typeof message.text === "string" ? message.text : undefined,
  };
}

function getCommandArgument(ctx: Context): string | undefined {
  if (!("message" in ctx) || !ctx.message || !("text" in ctx.message) || typeof ctx.message.text !== "string") {
    return undefined;
  }

  const [, ...args] = ctx.message.text.trim().split(/\s+/);
  const argument = args.join(" ").trim();
  return argument || undefined;
}

async function safeStandaloneReply(reply: ReplyFn, logger: Logger, message: string): Promise<void> {
  try {
    await reply(message);
  } catch (error) {
    logger.warn("Failed to send Telegram reply.", error);
  }
}

export function formatBytes(bytes: number | undefined): string {
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

export function getSuggestedFileName(message: DownloadableMessage): string | undefined {
  if ("document" in message && message.document.file_name) {
    return message.document.file_name;
  }

  if ("video" in message && "file_name" in message.video && typeof message.video.file_name === "string") {
    return message.video.file_name;
  }

  return undefined;
}

export function getDisplayFileName(message: DownloadableMessage): string {
  return getSuggestedFileName(message) ?? `${"video" in message ? "video" : "document"}-${message.message_id}`;
}

export function getCaption(message: DownloadableMessage): string | undefined {
  if ("caption" in message) {
    return message.caption;
  }

  return undefined;
}
