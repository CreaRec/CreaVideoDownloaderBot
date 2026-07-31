import type { Context } from "telegraf";
import path from "node:path";
import {
  createDeleteConfirmationReplyMarkup,
  createDeleteConfirmationStatusMessage,
  createDeleteFailedStatusMessage,
  createDeletedStatusMessage,
  createMoveToKidsConfirmationReplyMarkup,
  createMoveToKidsConfirmationStatusMessage,
  createMoveToKidsFailedStatusMessage,
  createMovedToKidsStatusMessage,
  createStatusActionReplyMarkup,
  deleteDownloadedFile,
  moveDownloadedPathToKids,
  parseDeleteCallbackData,
  resolveMoveToKidsPaths,
  stripStatusConfirmationSuffix,
  type DeleteButtonState,
} from "../files/delete-buttons.js";
import type { ActiveDownloads } from "../download/active-downloads.js";
import type { Logger } from "../config/logger.js";
import type { Settings } from "../config/settings.js";
import {
  answerCallback,
  BOT_PRIVATE_MESSAGE,
  getCallbackData,
  getCallbackMessage,
  isAllowedUser,
} from "../telegram/telegram-ctx.js";

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

    const originalText = message.text
      ? stripStatusConfirmationSuffix(message.text)
      : record.originalText;
    await this.deleteButtons.updateOriginalText(record.token, originalText);

    const statusMarkup = () =>
      createStatusActionReplyMarkup(record.token, record.filePath, this.settings.download.directory);

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

    if (callback.action === "ask-move") {
      const paths = resolveMoveToKidsPaths(record.filePath, this.settings.download.directory);

      if (!paths) {
        await answerCallback(ctx, this.logger, "This download cannot be moved to Kids.");
        return;
      }

      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        createMoveToKidsConfirmationStatusMessage(
          originalText,
          paths.sourceRelativePath,
          paths.targetRelativePath,
        ),
        createMoveToKidsConfirmationReplyMarkup(record.token),
      );
      await answerCallback(ctx, this.logger, "Confirm move to Kids.");
      return;
    }

    if (callback.action === "cancel") {
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        originalText,
        statusMarkup(),
      );
      await answerCallback(ctx, this.logger, "Cancelled.");
      return;
    }

    if (callback.action === "confirm-move") {
      try {
        this.activeDownloads.abort(record.token);
        const { outcome, sourceRelativePath, targetRelativePath } = await moveDownloadedPathToKids(
          record.filePath,
          this.settings.download.directory,
        );

        if (outcome === "protected") {
          await answerCallback(ctx, this.logger, "This download cannot be moved to Kids.");
          return;
        }

        if (outcome === "target-exists") {
          await ctx.telegram.editMessageText(
            record.chatId,
            record.messageId,
            undefined,
            createMoveToKidsFailedStatusMessage(originalText, "Target already exists. Refusing to overwrite."),
            statusMarkup(),
          );
          await answerCallback(ctx, this.logger, "Target already exists. Refusing to overwrite.");
          return;
        }

        await this.deleteButtons.markDeleted(record.token);
        await ctx.telegram.editMessageText(
          record.chatId,
          record.messageId,
          undefined,
          createMovedToKidsStatusMessage(
            originalText,
            sourceRelativePath ?? "",
            targetRelativePath ?? "",
          ),
        );
        await answerCallback(
          ctx,
          this.logger,
          outcome === "missing" ? "Item was already missing." : "Moved to Kids.",
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.exception("[delete] failed to move to Kids", error, {
          component: "delete",
          handler: "delete",
          step: "move_to_kids",
          result: "error",
          file_name: path.basename(record.filePath),
        });
        await ctx.telegram.editMessageText(
          record.chatId,
          record.messageId,
          undefined,
          createMoveToKidsFailedStatusMessage(originalText, reason),
          statusMarkup(),
        );
        await answerCallback(ctx, this.logger, "Could not move to Kids.");
      }
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
      this.logger.exception("[delete] failed to delete file", error, {
        component: "delete",
        handler: "delete",
        step: "delete_file",
        result: "error",
        file_name: path.basename(record.filePath),
      });
      await ctx.telegram.editMessageText(
        record.chatId,
        record.messageId,
        undefined,
        createDeleteFailedStatusMessage(originalText, record.filePath, reason),
        statusMarkup(),
      );
      await answerCallback(ctx, this.logger, "Could not delete file.");
    }
  }
}
