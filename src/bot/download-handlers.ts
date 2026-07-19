import type { Context } from "telegraf";
import {
  createDeleteButtonReplyMarkup,
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
  isDownloadCanceled,
  type DuplicateChoice,
  type TelegramDownloader,
} from "../download/downloader.js";
import type { ActiveDownloads } from "../download/active-downloads.js";
import type { DownloadSemaphore } from "../download/download-semaphore.js";
import type { Logger } from "../config/logger.js";
import { createProgressReporter } from "../download/progress-reporter.js";
import type { Settings } from "../config/settings.js";
import type { StatusEditScheduler } from "../download/status-edit-scheduler.js";
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

export class DownloadHandlers {
  private readonly duplicateChoices = new DuplicateChoicePending();

  constructor(
    private readonly settings: Settings,
    private readonly downloader: TelegramDownloader,
    private readonly logger: Logger,
    private readonly deleteButtons: DeleteButtonState,
    private readonly activeDownloads: ActiveDownloads,
    private readonly statusScheduler: StatusEditScheduler,
    private readonly downloadSemaphore: DownloadSemaphore,
    private readonly progressMinIntervalMs: number,
    private readonly progressPercentStep: number,
  ) {}

  async handleDownloadableMessage(
    fromUserId: number | undefined,
    message: DownloadableMessage,
    chatId: number,
    reply: ReplyFn,
  ): Promise<void> {
    if (!isAllowedUser(this.settings, fromUserId)) {
      this.logger.warn(`Ignored message ${message.message_id} from unauthorized user ${fromUserId ?? "unknown"}.`);
      return;
    }

    const fileName = getDisplayFileName(message);
    const statusMessage = await safeReply(reply, this.logger, `Download started: ${fileName}`);
    void this.runDownloadWithConcurrency(fromUserId, message, chatId, reply, statusMessage?.message_id);
  }

  async runDownloadWithConcurrency(
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

  async downloadAndNotify(
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
      const request = {
        botMessageId: message.message_id,
        telegramUserId: fromUserId,
        mediaKind: ("video" in message ? "video" : "document") as "video" | "document",
        suggestedFileName,
        receivedAt: message.date,
        caption: getCaption(message),
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
      };

      const prepared = await this.downloader.prepareDownload(request);
      let choice: DuplicateChoice | undefined;

      if (prepared.existingPath) {
        if (!statusMessageId) {
          this.logger.warn(
            `Duplicate found for message ${message.message_id} but status message is missing; keeping both.`,
          );
          choice = "keep";
        } else {
          const pending = this.duplicateChoices.create({
            chatId,
            messageId: statusMessageId,
            existingPath: prepared.existingPath,
          });

          await this.statusScheduler.scheduleTerminal(
            chatId,
            statusMessageId,
            createDuplicatePromptMessage(prepared.existingPath),
            createDuplicateChoiceReplyMarkup(pending.token),
            reply,
          );

          choice = await pending.choice;

          if (choice === "skip") {
            await this.statusScheduler.scheduleTerminal(
              chatId,
              statusMessageId,
              createDuplicateSkippedMessage(fileName, prepared.existingPath),
              undefined,
              reply,
            );
            return;
          }
        }
      }

      const result = await this.downloader.downloadPrepared(prepared, request, choice);

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
      if (deleteToken) {
        this.activeDownloads.clear(deleteToken, abortController);
      }
    }
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
