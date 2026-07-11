import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Context } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { FileTreeBrowser } from "../files/file-tree.js";
import type { Logger } from "../config/logger.js";
import type { MetadataFixHintParser } from "../metadata/metadata-fix-hint.js";
import type { MetadataFixRenamer } from "../metadata/metadata-fix-renamer.js";
import type { Settings } from "../config/settings.js";
import {
  answerCallback as answerCallbackQuery,
  BOT_HELP_MESSAGE,
  BOT_PRIVATE_MESSAGE,
  createMainReplyKeyboard,
  getCallbackData,
  getCallbackMessage,
  isAllowedUser,
  isFilesButtonText,
} from "../telegram/telegram-ctx.js";
import type { TmdbCandidate, TmdbResolver } from "../metadata/tmdb-resolver.js";

const METADATA_FIX_TTL_MS = 15 * 60 * 1000;
export const FIX_META_CALLBACK_PREFIX = "fix-meta";

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

export type FixMetaCallback =
  | { action: "pick"; token: string; tmdbId: number }
  | { action: "cancel"; token: string };

export class MetadataFixHandlers {
  private readonly pendingFixHintByUserId = new Map<number, PendingFixHint>();
  private readonly pendingFixPickByToken = new Map<string, PendingFixPick>();
  private readonly pendingFixPickTokenByUserId = new Map<number, string>();

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly fileTree: FileTreeBrowser,
    private readonly tmdbResolver: TmdbResolver,
    private readonly metadataFixHintParser: MetadataFixHintParser,
    private readonly metadataFixRenamer: MetadataFixRenamer,
  ) {}

  async startMetadataFix(ctx: Context, token: string): Promise<void> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId)) {
      await this.answerCallback(ctx, BOT_PRIVATE_MESSAGE);
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

  async tryHandleMetadataFixText(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId) || !("message" in ctx) || !ctx.message || !("text" in ctx.message)) {
      return false;
    }

    const pending = this.getPendingFixHint(userId);

    if (!pending) {
      return false;
    }

    const text = ctx.message.text.trim();

    if (!text || text.startsWith("/") || isFilesButtonText(text)) {
      return false;
    }

    this.pendingFixHintByUserId.delete(userId);
    await this.processMetadataFixHint(ctx, pending.relativePath, { text });
    return true;
  }

  async handleMetadataFixPhoto(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId)) {
      return;
    }

    const pending = this.getPendingFixHint(userId);

    if (!pending) {
      await ctx.reply(BOT_HELP_MESSAGE, createMainReplyKeyboard());
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

  async tryHandleMetadataFixDocument(ctx: Context): Promise<boolean> {
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

  async handleMetadataFixButton(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx.from?.id)) {
      await this.answerCallback(ctx, BOT_PRIVATE_MESSAGE);
      return;
    }

    const callback = parseFixMetaCallbackData(getCallbackData(ctx));

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

  /** Test helper: seed a pending hint session. */
  setPendingFixHintForTests(userId: number, relativePath: string, expiresAt = Date.now() + METADATA_FIX_TTL_MS): void {
    this.pendingFixHintByUserId.set(userId, { relativePath, expiresAt });
  }

  /** Test helper: read pending hint after TTL checks. */
  getPendingFixHintForTests(userId: number): PendingFixHint | undefined {
    return this.getPendingFixHint(userId);
  }

  /** Test helper: seed a pending pick session. */
  setPendingFixPickForTests(
    userId: number,
    token: string,
    pending: Omit<PendingFixPick, "expiresAt"> & { expiresAt?: number },
  ): void {
    this.pendingFixPickByToken.set(token, {
      ...pending,
      expiresAt: pending.expiresAt ?? Date.now() + METADATA_FIX_TTL_MS,
    });
    this.pendingFixPickTokenByUserId.set(userId, token);
  }

  /** Test helper: read pending pick after TTL checks. */
  getPendingFixPickForTests(token: string): PendingFixPick | undefined {
    return this.getPendingFixPick(token);
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
    return isAllowedUser(this.settings, userId);
  }

  private async answerCallback(ctx: Context, message: string): Promise<void> {
    await answerCallbackQuery(ctx, this.logger, message);
  }
}

export function parseFixMetaCallbackData(data: string | undefined): FixMetaCallback | undefined {
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

export function createCandidateReplyMarkup(token: string, candidates: TmdbCandidate[]): { reply_markup: InlineKeyboardMarkup } {
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

export function formatCandidateLabel(candidate: TmdbCandidate): string {
  const year = candidate.year ? ` (${candidate.year})` : "";
  const kind = candidate.kind === "film" ? "Film" : "TV";
  const label = `${kind}: ${candidate.title}${year}`;

  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

function formatRelativePath(relativePath: string): string {
  return relativePath ? relativePath.split(path.sep).join("/") : "/";
}

function createFixPickToken(): string {
  return randomBytes(9).toString("base64url");
}
