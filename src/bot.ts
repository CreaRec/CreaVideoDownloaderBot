import { randomBytes } from "node:crypto";
import path from "node:path";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import type { InlineKeyboardMarkup, Message } from "telegraf/types";
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
import { MediaClassifier } from "./media-classifier.js";
import { MetadataFixHintParser } from "./metadata-fix-hint.js";
import { MetadataFixRenamer } from "./metadata-fix-renamer.js";
import { OpenAIUsageService, type OpenAIUsageReporter } from "./openai-usage.js";
import { DownloadSemaphore } from "./download-semaphore.js";
import type { Settings } from "./settings.js";
import { isConfiguredUser } from "./settings.js";
import { StatusEditScheduler, type StatusReplyFn } from "./status-edit-scheduler.js";
import type { TmdbCandidate } from "./tmdb-resolver.js";
import { TmdbResolver } from "./tmdb-resolver.js";

type DownloadableMessage = Message.VideoMessage | Message.DocumentMessage;
type TelegramStatusMessage = { message_id?: number };
type ReplyFn = (message: string) => Promise<TelegramStatusMessage>;
type CallbackMessage = { message_id: number; chat: { id: number }; text?: string };
type RestartServiceFn = () => void;

const DEFAULT_PROGRESS_PERCENT_STEP = 10;
const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 10_000;
const RESTART_DELAY_MS = 1_000;
const METADATA_FIX_TTL_MS = 15 * 60 * 1000;
const FIX_META_CALLBACK_PREFIX = "fix-meta";

interface PendingFixHint {
  relativePath: string;
  expiresAt: number;
}

interface PendingFixPick {
  relativePath: string;
  kind: "film" | "tv_show";
  candidates: TmdbCandidate[];
  expiresAt: number;
}

export class BotService {
  private readonly bot: Telegraf;
  private readonly deleteButtons: DeleteButtonState;
  private readonly fileTree: FileTreeBrowser;
  private readonly fileTreeMessageIdByChat = new Map<number, number>();
  private readonly activeDownloadsByDeleteToken = new Map<string, AbortController>();
  private readonly pendingFixHintByUserId = new Map<number, PendingFixHint>();
  private readonly pendingFixPickByToken = new Map<string, PendingFixPick>();
  private readonly pendingFixPickTokenByUserId = new Map<number, string>();
  private readonly statusScheduler: StatusEditScheduler;
  private readonly downloadSemaphore: DownloadSemaphore;
  private readonly progressMinIntervalMs: number;
  private readonly progressPercentStep: number;
  private readonly metadataFixHintParser: MetadataFixHintParser;
  private readonly metadataFixRenamer: MetadataFixRenamer;
  private readonly tmdbResolver: TmdbResolver;

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
    this.tmdbResolver = new TmdbResolver(settings, logger);
    this.metadataFixHintParser = new MetadataFixHintParser(settings, logger);
    this.metadataFixRenamer = new MetadataFixRenamer(
      settings,
      logger,
      this.tmdbResolver,
      new MediaClassifier(settings, logger),
    );
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
      if (await this.tryHandleMetadataFixDocument(ctx)) {
        return;
      }

      await this.handleDownloadableMessage(
        ctx.from?.id,
        ctx.message,
        ctx.message.chat.id,
        (message) => ctx.reply(message),
      );
    });

    this.bot.on("photo", async (ctx) => {
      await this.handleMetadataFixPhoto(ctx);
    });

    this.bot.on("text", async (ctx) => {
      if (await this.tryHandleMetadataFixText(ctx)) {
        return;
      }

      if (this.isAllowed(ctx.from?.id)) {
        await ctx.reply(
          "I can download Telegram videos and document-style video files. Send one here to start, use /files to browse downloaded files, use /usage for OpenAI usage, or use /restart to restart the service.",
        );
      }
    });

    this.bot.action(/^file-delete:/, async (ctx) => {
      await this.handleDeleteButton(ctx);
    });

    this.bot.action(/^file-tree:/, async (ctx) => {
      await this.handleFileTreeButton(ctx);
    });

    this.bot.action(/^fix-meta:/, async (ctx) => {
      await this.handleMetadataFixButton(ctx);
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

      if (callback.action === "fix") {
        await this.startMetadataFix(ctx, callback.token);
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

  private async startMetadataFix(ctx: Context, token: string): Promise<void> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId)) {
      await this.answerCallback(ctx, "This bot is private.");
      return;
    }

    const relativePath = this.fileTree.getRelativePathForToken(token);

    if (!this.fileTree.canFixMetadata(relativePath)) {
      await this.answerCallback(ctx, "This folder cannot be fixed.");
      return;
    }

    this.clearPendingFixPick(userId);
    this.pendingFixHintByUserId.set(userId, {
      relativePath,
      expiresAt: Date.now() + METADATA_FIX_TTL_MS,
    });

    await ctx.reply(
      [
        `Fix metadata for folder: ${formatRelativePath(relativePath)}`,
        "Send the correct title as text and/or a screenshot.",
        "I will show TMDB matches for you to choose from.",
      ].join("\n"),
    );
    await this.answerCallback(ctx, "Send a correction hint.");
  }

  private async tryHandleMetadataFixText(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId) || !("message" in ctx) || !ctx.message || !("text" in ctx.message)) {
      return false;
    }

    const pending = this.getPendingFixHint(userId);

    if (!pending) {
      return false;
    }

    const text = ctx.message.text.trim();

    if (!text || text.startsWith("/")) {
      return false;
    }

    this.pendingFixHintByUserId.delete(userId);
    await this.processMetadataFixHint(ctx, pending.relativePath, { text });
    return true;
  }

  private async handleMetadataFixPhoto(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId)) {
      return;
    }

    const pending = this.getPendingFixHint(userId);

    if (!pending) {
      await ctx.reply(
        "I can download Telegram videos and document-style video files. Send one here to start, use /files to browse downloaded files, use /usage for OpenAI usage, or use /restart to restart the service.",
      );
      return;
    }

    if (!("message" in ctx) || !ctx.message || !("photo" in ctx.message) || !ctx.message.photo?.length) {
      return;
    }

    this.pendingFixHintByUserId.delete(userId);
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const image = await this.downloadTelegramFile(ctx, photo.file_id, "image/jpeg");
    const caption = "caption" in ctx.message && typeof ctx.message.caption === "string" ? ctx.message.caption : undefined;
    await this.processMetadataFixHint(ctx, pending.relativePath, { text: caption, image });
  }

  private async tryHandleMetadataFixDocument(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId) || !("message" in ctx) || !ctx.message || !("document" in ctx.message)) {
      return false;
    }

    const pending = this.getPendingFixHint(userId);
    const document = ctx.message.document;
    const mimeType = document.mime_type ?? "";

    if (!pending || !mimeType.startsWith("image/")) {
      return false;
    }

    this.pendingFixHintByUserId.delete(userId);
    const image = await this.downloadTelegramFile(ctx, document.file_id, mimeType);
    const caption = "caption" in ctx.message && typeof ctx.message.caption === "string" ? ctx.message.caption : undefined;
    await this.processMetadataFixHint(ctx, pending.relativePath, { text: caption, image });
    return true;
  }

  private async processMetadataFixHint(
    ctx: Context,
    relativePath: string,
    input: { text?: string; image?: { mimeType: string; data: Buffer } },
  ): Promise<void> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId)) {
      return;
    }

    await ctx.reply("Looking up TMDB matches...");

    const folderName = path.basename(relativePath) || relativePath;
    const hint = await this.metadataFixHintParser.parse({
      folderName,
      text: input.text,
      image: input.image,
    });

    if (hint.kind === "undefined") {
      await ctx.reply(`Could not understand the correction: ${hint.reason}\nUse /files and try Fix metadata again.`);
      return;
    }

    const candidates = await this.tmdbResolver.searchCandidates({
      kind: hint.kind,
      title: hint.title,
      year: hint.year,
      limit: 5,
    });

    if (candidates.length === 0) {
      await ctx.reply(
        `No TMDB matches found for ${hint.kind === "film" ? "film" : "TV show"} "${hint.title}"${hint.year ? ` (${hint.year})` : ""}.`,
      );
      return;
    }

    this.clearPendingFixPick(userId);
    const token = createFixPickToken();
    this.pendingFixPickByToken.set(token, {
      relativePath,
      kind: hint.kind,
      candidates,
      expiresAt: Date.now() + METADATA_FIX_TTL_MS,
    });
    this.pendingFixPickTokenByUserId.set(userId, token);

    await ctx.reply(
      [
        `Choose the correct ${hint.kind === "film" ? "film" : "TV show"} for: ${formatRelativePath(relativePath)}`,
        `Search: ${hint.title}${hint.year ? ` (${hint.year})` : ""}`,
        "Even a single match must be confirmed.",
      ].join("\n"),
      createCandidateReplyMarkup(token, candidates),
    );
  }

  private async handleMetadataFixButton(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await this.answerCallback(ctx, "This bot is private.");
      return;
    }

    const data = "callbackQuery" in ctx && ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const callback = parseFixMetaCallbackData(data);

    if (!callback) {
      await this.answerCallback(ctx, "Unknown fix action.");
      return;
    }

    const pending = this.getPendingFixPick(callback.token);

    if (!pending) {
      await this.answerCallback(ctx, "Fix selection is no longer available.");
      return;
    }

    const message = getCallbackMessage(ctx);

    if (callback.action === "cancel") {
      this.clearPendingFixPick(ctx.from.id, callback.token);
      if (message) {
        await ctx.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          "Metadata fix cancelled.",
        );
      }
      await this.answerCallback(ctx, "Cancelled.");
      return;
    }

    const candidate = pending.candidates.find((entry) => entry.tmdbId === callback.tmdbId);

    if (!candidate || candidate.kind !== pending.kind) {
      await this.answerCallback(ctx, "Selected match is not available.");
      return;
    }

    await this.answerCallback(ctx, "Applying metadata...");
    this.clearPendingFixPick(ctx.from.id, callback.token);

    const resolved = await this.tmdbResolver.resolveCandidateById(pending.kind, candidate.tmdbId);

    if (!resolved) {
      if (message) {
        await ctx.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          "Could not load the selected TMDB title. Try again.",
        );
      }
      return;
    }

    try {
      const folderPath = this.fileTree.resolveAbsolutePath(pending.relativePath);
      const result = await this.metadataFixRenamer.renameFolder(folderPath, resolved);
      const summary = [
        `Applied ${resolved.kind === "film" ? "film" : "TV show"}: ${resolved.title}${resolved.year ? ` (${resolved.year})` : ""}`,
        `Renamed: ${result.renamed.length}`,
        `Skipped: ${result.skipped.length}`,
        ...result.renamed.slice(0, 10).map((entry) => `✓ ${path.basename(entry.from)} → ${entry.to}`),
        ...result.skipped.slice(0, 10).map((entry) => `• ${path.basename(entry.path)}: ${entry.reason}`),
      ].join("\n");

      if (message) {
        await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, summary);
      } else {
        await ctx.reply(summary);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn("Failed to apply metadata fix rename.", error);
      if (message) {
        await ctx.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          `Failed to rename files: ${reason}`,
        );
      }
    }
  }

  private getPendingFixHint(userId: number): PendingFixHint | undefined {
    const pending = this.pendingFixHintByUserId.get(userId);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingFixHintByUserId.delete(userId);
      return undefined;
    }

    return pending;
  }

  private getPendingFixPick(token: string): PendingFixPick | undefined {
    const pending = this.pendingFixPickByToken.get(token);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingFixPickByToken.delete(token);
      return undefined;
    }

    return pending;
  }

  private clearPendingFixPick(userId: number, token?: string): void {
    const existingToken = token ?? this.pendingFixPickTokenByUserId.get(userId);

    if (existingToken) {
      this.pendingFixPickByToken.delete(existingToken);
    }

    if (!token || this.pendingFixPickTokenByUserId.get(userId) === token) {
      this.pendingFixPickTokenByUserId.delete(userId);
    }
  }

  private async downloadTelegramFile(
    ctx: Context,
    fileId: string,
    mimeType: string,
  ): Promise<{ mimeType: string; data: Buffer }> {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(link.href);

    if (!response.ok) {
      throw new Error(`Failed to download Telegram file (${response.status}).`);
    }

    return {
      mimeType,
      data: Buffer.from(await response.arrayBuffer()),
    };
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

function formatRelativePath(relativePath: string): string {
  return relativePath ? relativePath.split(path.sep).join("/") : "/";
}

function createFixPickToken(): string {
  return randomBytes(9).toString("base64url");
}

function parseFixMetaCallbackData(
  data: string | undefined,
): { action: "pick"; token: string; tmdbId: number } | { action: "cancel"; token: string } | undefined {
  if (!data) {
    return undefined;
  }

  const [prefix, action, token, tmdbIdRaw] = data.split(":");

  if (prefix !== FIX_META_CALLBACK_PREFIX || !token) {
    return undefined;
  }

  if (action === "cancel") {
    return { action: "cancel", token };
  }

  if (action === "pick" && tmdbIdRaw) {
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);

    if (Number.isFinite(tmdbId)) {
      return { action: "pick", token, tmdbId };
    }
  }

  return undefined;
}

function createCandidateReplyMarkup(token: string, candidates: TmdbCandidate[]): { reply_markup: InlineKeyboardMarkup } {
  const rows = candidates.map((candidate) => [
    {
      text: formatCandidateLabel(candidate),
      callback_data: `${FIX_META_CALLBACK_PREFIX}:pick:${token}:${candidate.tmdbId}`,
    },
  ]);

  rows.push([
    {
      text: "Cancel",
      callback_data: `${FIX_META_CALLBACK_PREFIX}:cancel:${token}`,
    },
  ]);

  return { reply_markup: { inline_keyboard: rows } };
}

function formatCandidateLabel(candidate: TmdbCandidate): string {
  const year = candidate.year ? ` (${candidate.year})` : "";
  const kind = candidate.kind === "film" ? "Film" : "TV";
  const label = `${kind}: ${candidate.title}${year}`;

  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

