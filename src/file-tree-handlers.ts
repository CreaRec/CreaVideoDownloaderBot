import type { Context } from "telegraf";
import type { FileTreeBrowser } from "./file-tree.js";
import type { Logger } from "./logger.js";
import type { MetadataFixHandlers } from "./metadata-fix-handlers.js";
import type { Settings } from "./settings.js";
import {
  answerCallback,
  BOT_PRIVATE_MESSAGE,
  getCallbackData,
  getCallbackMessage,
  isAllowedUser,
} from "./telegram-ctx.js";

export class FileTreeHandlers {
  private readonly fileTreeMessageIdByChat = new Map<number, number>();

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
