import type { Context } from "telegraf";
import type { FileTreeBrowser } from "../files/file-tree.js";
import type { Logger } from "../config/logger.js";
import type { MetadataFixHandlers } from "./metadata-fix-handlers.js";
import type { Settings } from "../config/settings.js";
import {
  answerCallback,
  BOT_PRIVATE_MESSAGE,
  getCallbackData,
  getCallbackMessage,
  isAllowedUser,
} from "../telegram/telegram-ctx.js";

export class FileTreeHandlers {
  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly fileTree: FileTreeBrowser,
    private readonly metadataFix: MetadataFixHandlers,
  ) {}

  async handleFilesCommand(ctx: Context): Promise<void> {
    if (!isAllowedUser(this.settings, ctx.from?.id)) {
      await ctx.reply(BOT_PRIVATE_MESSAGE);
      return;
    }

    this.fileTree.reset();
    const view = await this.fileTree.renderRoot();
    await ctx.reply(view.message, view.extra);
  }

  async handleFileTreeButton(ctx: Context): Promise<void> {
    if (!isAllowedUser(this.settings, ctx.from?.id)) {
      await answerCallback(ctx, this.logger, BOT_PRIVATE_MESSAGE);
      return;
    }

    const callback = this.fileTree.parseCallbackData(getCallbackData(ctx));

    if (!callback) {
      await answerCallback(ctx, this.logger, "Unknown file action.");
      return;
    }

    const message = getCallbackMessage(ctx);

    if (!message) {
      await answerCallback(ctx, this.logger, "Could not update file tree.");
      return;
    }

    try {
      if (callback.action === "confirm") {
        const relativePath = this.fileTree.getRelativePathForToken(callback.token);
        const parentToken = this.fileTree.getParentToken(callback.token);
        const outcome = await this.fileTree.deleteToken(callback.token);

        if (outcome === "protected") {
          await answerCallback(ctx, this.logger, "This item cannot be deleted.");
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
        await answerCallback(ctx, this.logger, outcome === "missing" ? "Item was already missing." : "Item deleted.");
        return;
      }

      if (callback.action === "fix") {
        await this.metadataFix.startMetadataFix(ctx, callback.token);
        return;
      }

      const view =
        callback.action === "open" || callback.action === "refresh"
          ? await this.fileTree.renderDirectoryToken(callback.token)
          : callback.action === "delete"
            ? await this.fileTree.renderDeleteConfirmationToken(callback.token)
            : await this.fileTree.renderSelectedToken(callback.token);

      await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, view.message, view.extra);
      await answerCallback(ctx, this.logger, callback.action === "delete" ? "Confirm deletion." : "File tree updated.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn("Failed to handle file tree action.", error);
      await answerCallback(ctx, this.logger, reason);
    }
  }
}
