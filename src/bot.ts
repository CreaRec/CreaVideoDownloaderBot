import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { ActiveDownloads } from "./active-downloads.js";
import { DeleteButtonState } from "./delete-buttons.js";
import { DeleteHandlers } from "./delete-handlers.js";
import type { TelegramDownloader } from "./downloader.js";
import { DownloadHandlers } from "./download-handlers.js";
import { DownloadSemaphore } from "./download-semaphore.js";
import { FileTreeBrowser } from "./file-tree.js";
import { FileTreeHandlers } from "./file-tree-handlers.js";
import type { Logger } from "./logger.js";
import { MediaClassifier } from "./media-classifier.js";
import { MetadataFixHandlers } from "./metadata-fix-handlers.js";
import { MetadataFixHintParser } from "./metadata-fix-hint.js";
import { MetadataFixRenamer } from "./metadata-fix-renamer.js";
import { OpenAIUsageService, type OpenAIUsageReporter } from "./openai-usage.js";
import type { Settings } from "./settings.js";
import { StatusEditScheduler } from "./status-edit-scheduler.js";
import {
  BOT_HELP_MESSAGE,
  BOT_PRIVATE_MESSAGE,
  getCommandArgument,
  isAllowedUser,
  type ReplyFn,
} from "./telegram-ctx.js";
import type { DownloadableMessage } from "./telegram-message.js";
import { TmdbResolver } from "./tmdb-resolver.js";

type RestartServiceFn = () => void;

const RESTART_DELAY_MS = 1_000;

export class BotService {
  private readonly bot: Telegraf;
  private readonly fileTree: FileTreeBrowser;
  private readonly metadataFix: MetadataFixHandlers;
  private readonly downloadHandlers: DownloadHandlers;
  private readonly deleteHandlers: DeleteHandlers;
  private readonly fileTreeHandlers: FileTreeHandlers;

  constructor(
    private readonly settings: Settings,
    private readonly downloader: TelegramDownloader,
    private readonly logger: Logger,
    private readonly openAIUsage: OpenAIUsageReporter = new OpenAIUsageService(settings, logger),
    private readonly restartService: RestartServiceFn = defaultRestartService,
    private readonly restartDelayMs = RESTART_DELAY_MS,
  ) {
    this.bot = new Telegraf(settings.telegram.botToken);
    const deleteButtons = DeleteButtonState.forStateDirectory(settings.app.stateDirectory);
    this.fileTree = new FileTreeBrowser(settings.download.directory);
    const activeDownloads = new ActiveDownloads();
    const statusScheduler = new StatusEditScheduler(
      (chatId, messageId, message, extra) => this.bot.telegram.editMessageText(chatId, messageId, undefined, message, extra),
      logger,
      settings.app.statusEditMinGapMs,
    );
    const downloadSemaphore = new DownloadSemaphore(settings.download.maxConcurrent);
    const tmdbResolver = new TmdbResolver(settings, logger);
    this.metadataFix = new MetadataFixHandlers(
      settings,
      logger,
      this.fileTree,
      tmdbResolver,
      new MetadataFixHintParser(settings, logger),
      new MetadataFixRenamer(settings, logger, tmdbResolver, new MediaClassifier(settings, logger)),
    );
    this.downloadHandlers = new DownloadHandlers(
      settings,
      downloader,
      logger,
      deleteButtons,
      activeDownloads,
      statusScheduler,
      downloadSemaphore,
      settings.app.statusUpdateMinIntervalMs,
      settings.app.statusUpdatePercentStep,
    );
    this.deleteHandlers = new DeleteHandlers(settings, logger, deleteButtons, activeDownloads);
    this.fileTreeHandlers = new FileTreeHandlers(settings, logger, this.fileTree, this.metadataFix);
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
        await ctx.reply(BOT_PRIVATE_MESSAGE);
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
      if (await this.metadataFix.tryHandleMetadataFixDocument(ctx)) {
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
      await this.metadataFix.handleMetadataFixPhoto(ctx);
    });

    this.bot.on("text", async (ctx) => {
      if (await this.metadataFix.tryHandleMetadataFixText(ctx)) {
        return;
      }

      if (this.isAllowed(ctx.from?.id)) {
        await ctx.reply(BOT_HELP_MESSAGE);
      }
    });

    this.bot.action(/^file-delete:/, async (ctx) => {
      await this.handleDeleteButton(ctx);
    });

    this.bot.action(/^file-tree:/, async (ctx) => {
      await this.handleFileTreeButton(ctx);
    });

    this.bot.action(/^fix-meta:/, async (ctx) => {
      await this.metadataFix.handleMetadataFixButton(ctx);
    });

    this.bot.on("message", async (ctx) => {
      if (this.isAllowed(ctx.from?.id)) {
        await ctx.reply(BOT_HELP_MESSAGE);
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
    await this.downloadHandlers.handleDownloadableMessage(fromUserId, message, chatId, reply);
  }

  private async downloadAndNotify(
    fromUserId: number,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
    statusMessageId: number | undefined,
  ): Promise<void> {
    await this.downloadHandlers.downloadAndNotify(fromUserId, message, chatId, reply, statusMessageId);
  }

  private async handleDeleteButton(ctx: Context): Promise<void> {
    await this.deleteHandlers.handleDeleteButton(ctx);
  }

  private async handleFilesCommand(ctx: Context): Promise<void> {
    await this.fileTreeHandlers.handleFilesCommand(ctx);
  }

  private async handleFileTreeButton(ctx: Context): Promise<void> {
    await this.fileTreeHandlers.handleFileTreeButton(ctx);
  }

  private async handleUsageCommand(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await ctx.reply(BOT_PRIVATE_MESSAGE);
      return;
    }

    await ctx.reply(await this.openAIUsage.createReport(getCommandArgument(ctx)));
  }

  private async handleRestartCommand(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await ctx.reply(BOT_PRIVATE_MESSAGE);
      return;
    }

    await ctx.reply("Restarting service...");
    this.logger.warn(`Restart requested by Telegram user ${ctx.from?.id}.`);

    const timeout = setTimeout(() => {
      this.restartService();
    }, this.restartDelayMs);
    timeout.unref();
  }

  private isAllowed(userId: number | undefined): userId is number {
    return isAllowedUser(this.settings, userId);
  }
}

function defaultRestartService(): void {
  process.exit(1);
}
