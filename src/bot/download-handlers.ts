import path from "node:path";
import { context, trace } from "@opentelemetry/api";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { Context } from "telegraf";
import {
  createStatusActionReplyMarkup,
  type DeleteButtonState,
} from "../files/delete-buttons.js";
import {
  createDuplicateChoiceReplyMarkup,
  createDuplicatePromptMessage,
  createDuplicateSkippedMessage,
  DuplicateChoicePending,
  parseDuplicateCallbackData,
} from "./duplicate-choice.js";
import {
  createShowAmbiguityPromptMessage,
  createShowChoiceReplyMarkup,
  parseShowCallbackData,
  ShowChoicePending,
} from "./show-choice.js";
import { QueueDrainNotifier, type QueueItemOutcome } from "../download/queue-drain-notifier.js";
import type { LibraryTvShow, ShowLibraryResolution } from "../metadata/tv-library-catalog.js";
import {
  isDownloadCanceled,
  type DuplicateChoice,
  type TelegramDownloader,
} from "../download/downloader.js";
import type { ActiveDownloads } from "../download/active-downloads.js";
import type { Logger } from "../config/logger.js";
import { truncateForLog } from "../config/logger.js";
import { createProgressReporter } from "../download/progress-reporter.js";
import type { Settings } from "../config/settings.js";
import type { StatusEditScheduler } from "../download/status-edit-scheduler.js";
import type { MetadataFixHandlers } from "./metadata-fix-handlers.js";
import {
  answerCallback,
  BOT_PRIVATE_MESSAGE,
  getCallbackData,
  isAllowedUser,
  safeReply,
  type ReplyFn,
} from "../telegram/telegram-ctx.js";
import {
  getCaption,
  getDisplayFileName,
  getSuggestedFileName,
  type DownloadableMessage,
} from "../telegram/telegram-message.js";

export type DownloadHandleOptions = {
  /** Active OTEL context from the Telegram update (for fire-and-forget downloads). */
  parentContext?: OtelContext;
  onAuthSkipped?: () => void;
};

export class DownloadHandlers {
  private readonly duplicateChoices = new DuplicateChoicePending();
  private readonly showChoices = new ShowChoicePending();
  private readonly queueDrainByUser = new Map<number, QueueDrainNotifier>();
  private readonly tvShowChoiceCacheByUser = new Map<number, Map<string, ShowLibraryResolution>>();

  constructor(
    private readonly settings: Settings,
    private readonly downloader: TelegramDownloader,
    private readonly logger: Logger,
    private readonly deleteButtons: DeleteButtonState,
    private readonly activeDownloads: ActiveDownloads,
    private readonly statusScheduler: StatusEditScheduler,
    private readonly progressMinIntervalMs: number,
    private readonly progressPercentStep: number,
    private readonly metadataFix?: MetadataFixHandlers,
  ) {}

  async handleDownloadableMessage(
    fromUserId: number | undefined,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
    options: DownloadHandleOptions = {},
  ): Promise<void> {
    if (!isAllowedUser(this.settings, fromUserId)) {
      options.onAuthSkipped?.();
      this.logger.warn("[download] ignored unauthorized message", {
        component: "download",
        handler: "auth",
        result: "skipped",
        step: "auth_reject",
        bot_message_id: message.message_id,
      });
      return;
    }

    const fileName = getDisplayFileName(message);
    const mediaKind = "video" in message ? "video" : "document";
    const caption = getCaption(message);

    this.logger.info("[download] request accepted", {
      component: "download",
      handler: "download",
      step: "accepted",
      media_kind: mediaKind,
      file_name: fileName,
      bot_message_id: message.message_id,
      ...(caption ? { user_text: truncateForLog(caption) } : {}),
    });

    const statusMessage = await safeReply(reply, this.logger, `Download started: ${fileName}`);
    const parentContext = options.parentContext ?? context.active();
    void context.with(parentContext, () =>
      this.downloadAndNotify(fromUserId, message, chatId, reply, statusMessage?.message_id, options),
    );
  }

  async downloadAndNotify(
    fromUserId: number,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
    statusMessageId: number | undefined,
    options: DownloadHandleOptions = {},
  ): Promise<void> {
    const fileName = getDisplayFileName(message);
    const mediaKind = ("video" in message ? "video" : "document") as "video" | "document";
    const tracer = trace.getTracer("crea-video-downloader");
    const started = process.hrtime.bigint();

    const queueDrain = this.getQueueDrainNotifier(fromUserId);
    queueDrain.begin();
    let queueOutcome: QueueItemOutcome | undefined;

    await tracer.startActiveSpan("download.run", async (span) => {
      span.setAttribute("handler", "download");
      span.setAttribute("media.kind", mediaKind);
      span.setAttribute("bot.message_id", message.message_id);

      let deleteToken: string | undefined;
      let downloadComplete = false;
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
          const record = deleteToken ? this.deleteButtons.getCached(deleteToken) : undefined;

          if (!record || record.deletedAt) {
            return undefined;
          }

          return createStatusActionReplyMarkup(
            record.token,
            record.filePath,
            this.settings.download.directory,
            { downloadComplete },
          );
        },
        isDeleted: () => (deleteToken ? this.deleteButtons.getCached(deleteToken)?.deletedAt !== undefined : false),
      });

      try {
        const suggestedFileName = getSuggestedFileName(message);
        const caption = getCaption(message);
        const request = {
          botMessageId: message.message_id,
          telegramUserId: fromUserId,
          mediaKind,
          suggestedFileName,
          receivedAt: message.date,
          caption,
          signal: abortController.signal,
          onOutputPath: async (outputPath: string) => {
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
            this.activeDownloads.register(record.token, abortController);
            await progressReporter.refresh();
          },
          onProgress: progressReporter.report,
          metadataContext: this.createMetadataContext(fromUserId, chatId, statusMessageId, reply),
        };

        this.logger.info("[download] prepare started", {
          component: "download",
          handler: "download",
          step: "prepare",
          media_kind: mediaKind,
          file_name: fileName,
          bot_message_id: message.message_id,
          ...(caption ? { user_text: truncateForLog(caption) } : {}),
        });

        const prepared = await this.downloader.prepareDownload(request);
        let choice: DuplicateChoice | undefined;

        this.logger.info("[download] prepare finished", {
          component: "download",
          handler: "download",
          step: "prepared",
          media_kind: mediaKind,
          file_name: fileName,
          bot_message_id: message.message_id,
          metadata_kind: prepared.metadata.kind,
          has_duplicate: Boolean(prepared.existingPath),
          output_name: path.basename(prepared.canonicalPath),
        });

        if (prepared.existingPath) {
          if (!statusMessageId) {
            this.logger.warn("[download] duplicate found without status message; keeping both", {
              component: "download",
              handler: "download",
              step: "duplicate",
              bot_message_id: message.message_id,
              result: "keep",
            });
            choice = "keep";
          } else {
            const pending = this.duplicateChoices.create({
              chatId,
              messageId: statusMessageId,
              existingPath: prepared.existingPath,
            });

            this.logger.info("[download] waiting for duplicate choice", {
              component: "download",
              handler: "download",
              step: "duplicate_prompt",
              bot_message_id: message.message_id,
              existing_name: path.basename(prepared.existingPath),
            });

            await this.statusScheduler.scheduleTerminal(
              chatId,
              statusMessageId,
              createDuplicatePromptMessage(prepared.existingPath),
              createDuplicateChoiceReplyMarkup(pending.token),
              reply,
            );

            choice = await pending.choice;

            this.logger.info("[download] duplicate choice received", {
              component: "download",
              handler: "download",
              step: "duplicate_choice",
              bot_message_id: message.message_id,
              result: choice,
            });

            if (choice === "skip") {
              await this.statusScheduler.scheduleTerminal(
                chatId,
                statusMessageId,
                createDuplicateSkippedMessage(fileName, prepared.existingPath),
                undefined,
                reply,
              );
              span.setAttribute("result", "skipped");
              queueOutcome = "skipped";
              return;
            }
          }
        }

        if (statusMessageId !== undefined && this.downloader.isMediaDownloadBusy(fromUserId)) {
          this.logger.info("[download] queued behind in-flight media download", {
            component: "download",
            handler: "download",
            step: "queued",
            bot_message_id: message.message_id,
            file_name: fileName,
          });
          await this.statusScheduler.scheduleTerminal(
            chatId,
            statusMessageId,
            `Queued: ${fileName}`,
            undefined,
            reply,
          );
        }

        this.logger.info("[download] media transfer started", {
          component: "download",
          handler: "download",
          step: "transfer",
          media_kind: mediaKind,
          file_name: fileName,
          bot_message_id: message.message_id,
          ...(choice ? { duplicate_choice: choice } : {}),
        });

        const result = await this.downloader.downloadPrepared(prepared, request, choice);
        const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);

        this.logger.info("[download] saved", {
          component: "download",
          handler: "download",
          step: "saved",
          result: "success",
          media_kind: mediaKind,
          file_name: fileName,
          bot_message_id: message.message_id,
          output_name: path.basename(result.outputPath),
          bytes: result.bytes,
          duration_ms: durationMs,
        });
        span.setAttribute("result", "success");
        downloadComplete = true;
        queueOutcome = "success";
        await progressReporter.complete(result, reply);

        if (prepared.metadata.kind === "unrecognized" && this.metadataFix) {
          const relativePath = path.relative(this.settings.download.directory, result.outputPath);
          await this.metadataFix.notifyUnrecognizedDownload(reply, relativePath, prepared.metadata);
        }
      } catch (error) {
        if (isDownloadCanceled(error)) {
          this.logger.info("[download] canceled", {
            component: "download",
            handler: "download",
            step: "canceled",
            result: "skipped",
            bot_message_id: message.message_id,
            file_name: fileName,
          });
          span.setAttribute("result", "canceled");
          queueOutcome = "skipped";
          return;
        }

        if (error instanceof Error) {
          span.recordException(error);
        }
        span.setStatus({ code: 2, message: "download_failed" });
        span.setAttribute("result", "error");
        queueOutcome = "failed";
        this.logger.exception("[download] failed", error, {
          component: "download",
          handler: "download",
          step: "failed",
          result: "error",
          bot_message_id: message.message_id,
          file_name: fileName,
          media_kind: mediaKind,
        });
        await progressReporter.fail(reply);
      } finally {
        if (deleteToken) {
          this.activeDownloads.clear(deleteToken, abortController);
        }
        span.end();
      }
    });

    if (queueOutcome) {
      const summary = queueDrain.complete(queueOutcome, fileName);
      await queueDrain.notifyIfDrained(reply, summary);

      if (summary) {
        this.tvShowChoiceCacheByUser.delete(fromUserId);
        this.downloader.invalidateTvLibraryCache?.();
        this.logger.info("[download] queue drained", {
          component: "download",
          handler: "download",
          step: "queue_drained",
          result: "success",
          succeeded: summary.succeeded,
          failed: summary.failed,
          skipped: summary.skipped,
        });
      }
    }
  }

  private getQueueDrainNotifier(userId: number): QueueDrainNotifier {
    let notifier = this.queueDrainByUser.get(userId);

    if (!notifier) {
      notifier = new QueueDrainNotifier();
      this.queueDrainByUser.set(userId, notifier);
    }

    return notifier;
  }

  private getTvShowChoiceCache(userId: number): Map<string, ShowLibraryResolution> {
    let cache = this.tvShowChoiceCacheByUser.get(userId);

    if (!cache) {
      cache = new Map();
      this.tvShowChoiceCacheByUser.set(userId, cache);
    }

    return cache;
  }

  private createMetadataContext(
    userId: number,
    chatId: number,
    statusMessageId: number | undefined,
    reply: ReplyFn,
  ) {
    const choiceCache = this.getTvShowChoiceCache(userId);

    return {
      getCachedTvShowChoice: (normalizedTitle: string) => choiceCache.get(normalizedTitle),
      rememberTvShowChoice: (normalizedTitle: string, choice: ShowLibraryResolution) => {
        choiceCache.set(normalizedTitle, choice);
      },
      resolveAmbiguousTvShow: async (input: { classifiedTitle: string; candidates: LibraryTvShow[] }) => {
        if (!statusMessageId) {
          this.logger.warn("[download] ambiguous TV show without status message; using TMDB", {
            component: "download",
            handler: "download",
            step: "show_prompt",
            result: "tmdb",
            match_count: input.candidates.length,
          });
          return { source: "tmdb" as const };
        }

        const pending = this.showChoices.create({
          chatId,
          messageId: statusMessageId,
          classifiedTitle: input.classifiedTitle,
          candidates: input.candidates,
        });

        await this.statusScheduler.scheduleTerminal(
          chatId,
          statusMessageId,
          createShowAmbiguityPromptMessage(input.classifiedTitle, input.candidates),
          createShowChoiceReplyMarkup(pending.token, input.candidates),
          reply,
        );

        const choice = await pending.choice;

        if (choice.source === "library") {
          return choice;
        }

        return { source: "tmdb" as const };
      },
    };
  }

  async handleShowChoiceButton(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!isAllowedUser(this.settings, userId)) {
      await answerCallback(ctx, this.logger, BOT_PRIVATE_MESSAGE);
      return;
    }

    const callback = parseShowCallbackData(getCallbackData(ctx));

    if (!callback) {
      await answerCallback(ctx, this.logger, "Unknown action.");
      return;
    }

    const resolution =
      callback.action === "library" && callback.showId
        ? { source: "library" as const, showId: callback.showId }
        : { source: "tmdb" as const };

    const resolved = this.showChoices.resolveToken(callback.token, resolution);

    if (!resolved) {
      await answerCallback(ctx, this.logger, "This choice expired.");
      return;
    }

    this.logger.info("[download] show choice button", {
      component: "download",
      handler: "show_choice",
      step: "callback",
      result: callback.action,
    });

    await answerCallback(
      ctx,
      this.logger,
      callback.action === "library" ? "Using selected library show…" : "Searching TMDB…",
    );
  }

  async handleDuplicateChoiceButton(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!isAllowedUser(this.settings, userId)) {
      await answerCallback(ctx, this.logger, BOT_PRIVATE_MESSAGE);
      return;
    }

    const callback = parseDuplicateCallbackData(getCallbackData(ctx));

    if (!callback) {
      await answerCallback(ctx, this.logger, "Unknown action.");
      return;
    }

    const resolved = this.duplicateChoices.resolveToken(callback.token, callback.action);

    if (!resolved) {
      await answerCallback(ctx, this.logger, "This choice expired.");
      return;
    }

    this.logger.info("[download] duplicate choice button", {
      component: "download",
      handler: "duplicate_choice",
      step: "callback",
      result: callback.action,
    });

    await answerCallback(
      ctx,
      this.logger,
      callback.action === "replace"
        ? "Replacing existing file…"
        : callback.action === "keep"
          ? "Keeping both…"
          : "Skipped.",
    );
  }
}
