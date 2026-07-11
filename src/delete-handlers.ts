import type { Context } from "telegraf";
import {
  createDeleteButtonReplyMarkup,
  createDeleteConfirmationReplyMarkup,
  createDeleteConfirmationStatusMessage,
  createDeleteFailedStatusMessage,
  createDeletedStatusMessage,
  deleteDownloadedFile,
  parseDeleteCallbackData,
  type DeleteButtonState,
} from "./delete-buttons.js";
import type { ActiveDownloads } from "./active-downloads.js";
import type { Logger } from "./logger.js";
import type { Settings } from "./settings.js";
import {
  answerCallback,
  BOT_PRIVATE_MESSAGE,
  getCallbackData,
  getCallbackMessage,
  isAllowedUser,
} from "./telegram-ctx.js";

export class DeleteHandlers {
  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly deleteButtons: DeleteButtonState,
    private readonly activeDownloads: ActiveDownloads,
  ) {}

  async handleDeleteButton(ctx: Context): Promise<void> {
    if (!isAllowedUser(this.settings, ctx.from?.id)) {
      await answerCallback(ctx, this.logger, BOT_PRIVATE_MESSAGE);
      return;
    }

    const callback = parseDeleteCallbackData(getCallbackData(ctx));

    if (!callback) {
      await answerCallback(ctx, this.logger, "Unknown delete action.");
      return;
    }

    const record = await this.deleteButtons.get(callback.token);

    if (!record) {
      await answerCallback(ctx, this.logger, "Delete action is no longer available.");
      return;
    }

    const message = getCallbackMessage(ctx);

    if (!message || message.chat.id !== record.chatId || message.message_id !== record.messageId) {
      await answerCallback(ctx, this.logger, "Delete action does not match this message.");
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
      await answerCallback(ctx, this.logger, "Confirm deletion.");
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
      await answerCallback(ctx, this.logger, "Deletion cancelled.");
      return;
    }

    try {
      this.activeDownloads.abort(record.token);
      const outcome = await deleteDownloadedFile(record.filePath, this.settings.download.directory);
      await this.deleteButtons.markDeleted(record.token);
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        createDeletedStatusMessage(originalText, record.filePath),
      );
      await answerCallback(ctx, this.logger, outcome === "missing" ? "File was already missing." : "File deleted.");
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
      await answerCallback(ctx, this.logger, "Could not delete file.");
    }
  }
}
