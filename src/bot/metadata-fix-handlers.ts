import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Context } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { FileTreeBrowser } from "../files/file-tree.js";
import type { Logger } from "../config/logger.js";
import { truncateForLog } from "../config/logger.js";
import { cleanDownloadTitle } from "../metadata/filename-title.js";
import {
  buildAutoSearchLabel,
  mergeTmdbCandidates,
  planMetadataFixSearchQueries,
  type MetadataFixSearchQuery,
} from "../metadata/metadata-fix-autosearch.js";
import { parseImdbId } from "../metadata/imdb-id.js";
import type { MetadataFixHintParser } from "../metadata/metadata-fix-hint.js";
import { parseSeasonEpisode, type MetadataFixRenamer } from "../metadata/metadata-fix-renamer.js";
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
  type ReplyFn,
} from "../telegram/telegram-ctx.js";
import type { TmdbCandidate, TmdbResolvedTitle, TmdbResolver } from "../metadata/tmdb-resolver.js";
import {
  findDeterministicLibraryMatches,
  findLibraryShowById,
  TvLibraryCatalog,
} from "../metadata/tv-library-catalog.js";
import { formatDisplayTitle } from "../metadata/media-metadata.js";
import type { PlexMetadata } from "../metadata/media-metadata.js";

const METADATA_FIX_TTL_MS = 15 * 60 * 1000;
export const FIX_META_CALLBACK_PREFIX = "fix-meta";
export const CHOOSE_TMDB_BUTTON_TEXT = "Выбрать в TMDB";

interface PendingFixHint {
  relativePath: string;
  expiresAt: number;
}

interface PendingFixPick {
  relativePath: string;
  candidates: TmdbCandidate[];
  expiresAt: number;
}

interface PendingFixStart {
  relativePath: string;
  searchQuery: string;
  expiresAt: number;
}

interface PendingFixEpisode {
  relativePath: string;
  resolved: TmdbResolvedTitle;
  expiresAt: number;
}

export type FixMetaCallback =
  | { action: "pick"; token: string; tmdbId: number }
  | { action: "cancel"; token: string }
  | { action: "manual"; token: string }
  | { action: "start"; token: string };

export class MetadataFixHandlers {
  private readonly pendingFixHintByUserId = new Map<number, PendingFixHint>();
  private readonly pendingFixPickByToken = new Map<string, PendingFixPick>();
  private readonly pendingFixPickTokenByUserId = new Map<number, string>();
  private readonly pendingFixStartByToken = new Map<string, PendingFixStart>();
  private readonly pendingFixEpisodeByUserId = new Map<number, PendingFixEpisode>();
  private readonly tvLibraryCatalog: TvLibraryCatalog;

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly fileTree: FileTreeBrowser,
    private readonly tmdbResolver: TmdbResolver,
    private readonly metadataFixHintParser: MetadataFixHintParser,
    private readonly metadataFixRenamer: MetadataFixRenamer,
    tvLibraryCatalog?: TvLibraryCatalog,
  ) {
    this.tvLibraryCatalog = tvLibraryCatalog ?? new TvLibraryCatalog(settings, logger);
  }

  async startMetadataFix(ctx: Context, token: string): Promise<void> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId)) {
      await this.answerCallback(ctx, BOT_PRIVATE_MESSAGE);
      return;
    }

    const relativePath = this.fileTree.getRelativePathForToken(token);

    if (!this.fileTree.canFixMetadata(relativePath)) {
      await this.answerCallback(ctx, "Для этого файла нельзя исправить метаданные.");
      return;
    }

    this.clearPendingFixPick(userId);

    this.logger.info("[metadata_fix] session started", {
      component: "metadata_fix",
      handler: "metadata_fix",
      step: "start",
      folder_name: formatRelativePath(relativePath),
    });

    await this.answerCallback(ctx, "Ищу в TMDB…");
    await this.beginMetadataFixSession(ctx, userId, relativePath);
  }

  async notifyUnrecognizedDownload(
    reply: ReplyFn,
    relativePath: string,
    metadata: PlexMetadata,
  ): Promise<void> {
    if (metadata.kind !== "unrecognized") {
      return;
    }

    const cleaned = metadata.displayName ?? path.basename(relativePath);
    const token = createFixPickToken();
    this.pendingFixStartByToken.set(token, {
      relativePath,
      searchQuery: cleaned,
      expiresAt: Date.now() + METADATA_FIX_TTL_MS,
    });

    const reason = metadata.reason ?? metadata.classificationReason ?? "неизвестная причина";

    await reply(
      [
        "Не удалось автоматически определить фильм или сериал.",
        `Причина: ${reason}`,
        `Файл сохранён в библиотеке «Фильмы» как «${cleaned}».`,
        "Нажмите кнопку ниже, чтобы выбрать правильный тайтл в TMDB.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: CHOOSE_TMDB_BUTTON_TEXT,
                callback_data: `${FIX_META_CALLBACK_PREFIX}:start:${token}`,
              },
            ],
          ],
        },
      },
    );
  }

  async tryHandleMetadataFixText(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;

    if (!this.isAllowed(userId) || !("message" in ctx) || !ctx.message || !("text" in ctx.message)) {
      return false;
    }

    const text = ctx.message.text.trim();

    if (!text || text.startsWith("/") || isFilesButtonText(text)) {
      return false;
    }

    const pendingEpisode = this.getPendingFixEpisode(userId);

    if (pendingEpisode) {
      const episode = parseSeasonEpisode(text);

      if (!episode) {
        await ctx.reply("Укажите сезон и серию, например S01E05 или 1x5.");
        return true;
      }

      this.pendingFixEpisodeByUserId.delete(userId);
      await this.applyResolvedMetadata(ctx, pendingEpisode.relativePath, pendingEpisode.resolved, episode);
      return true;
    }

    const pending = this.getPendingFixHint(userId);

    if (!pending) {
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
      await this.answerCallback(ctx, "Неизвестное действие.");
      return;
    }

    const message = getCallbackMessage(ctx);

    if (callback.action === "start") {
      const pendingStart = this.getPendingFixStart(callback.token);

      if (!pendingStart) {
        await this.answerCallback(ctx, "Сессия выбора истекла.");
        return;
      }

      await this.answerCallback(ctx, "Ищу в TMDB…");
      await this.beginMetadataFixSession(ctx, ctx.from!.id, pendingStart.relativePath, pendingStart.searchQuery);
      return;
    }

    if (callback.action === "manual") {
      const pending = this.getPendingFixPick(callback.token);

      if (!pending) {
        await this.answerCallback(ctx, "Сессия выбора истекла.");
        return;
      }

      this.pendingFixHintByUserId.set(ctx.from!.id, {
        relativePath: pending.relativePath,
        expiresAt: Date.now() + METADATA_FIX_TTL_MS,
      });
      await this.answerCallback(ctx, "Введите название для поиска.");
      if (message) {
        await ctx.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          `Введите название для поиска в TMDB по файлу ${formatRelativePath(pending.relativePath)}.`,
        );
      }
      return;
    }

    const pending = this.getPendingFixPick(callback.token);

    if (!pending) {
      await this.answerCallback(ctx, "Сессия выбора истекла.");
      return;
    }

    if (callback.action === "cancel") {
      this.clearPendingFixPick(ctx.from.id, callback.token);
      if (message) {
        await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, "Исправление метаданных отменено.");
      }
      await this.answerCallback(ctx, "Отменено.");
      return;
    }

    const candidate = pending.candidates.find((entry) => entry.tmdbId === callback.tmdbId);

    if (!candidate) {
      await this.answerCallback(ctx, "Этот вариант недоступен.");
      return;
    }

    await this.answerCallback(ctx, "Применяю…");
    this.clearPendingFixPick(ctx.from.id, callback.token);

    const resolved = await this.tmdbResolver.resolveCandidateById(candidate.kind, candidate.tmdbId);

    if (!resolved) {
      if (message) {
        await ctx.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          "Не удалось загрузить выбранный тайтл из TMDB. Попробуйте снова.",
        );
      }
      return;
    }

    if (resolved.kind === "tv_show") {
      const itemPath = this.fileTree.resolveAbsolutePath(pending.relativePath);
      const episode =
        parseSeasonEpisode(path.basename(itemPath)) ??
        parseSeasonEpisode(path.basename(path.dirname(itemPath)));

      if (!episode) {
        this.pendingFixEpisodeByUserId.set(ctx.from.id, {
          relativePath: pending.relativePath,
          resolved,
          expiresAt: Date.now() + METADATA_FIX_TTL_MS,
        });
        const prompt = `Сериал: ${formatDisplayTitle(resolved.title, resolved.year)}.\nУкажите сезон и серию (например S02E07).`;
        if (message) {
          await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, prompt);
        } else {
          await ctx.reply(prompt);
        }
        return;
      }

      await this.applyResolvedMetadata(ctx, pending.relativePath, resolved, episode, message);
      return;
    }

    await this.applyResolvedMetadata(ctx, pending.relativePath, resolved, undefined, message);
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

  private async applyResolvedMetadata(
    ctx: Context,
    relativePath: string,
    resolved: TmdbResolvedTitle,
    episode?: { season: number; episode: number },
    message?: ReturnType<typeof getCallbackMessage>,
  ): Promise<void> {
    try {
      const libraryResolved = await this.applyLibraryMatchIfNeeded(resolved);
      const itemPath = this.fileTree.resolveAbsolutePath(relativePath);
      const result = await this.metadataFixRenamer.renameItem(itemPath, libraryResolved, episode);
      const target = result.renamed[0]?.to;
      const display =
        libraryResolved.kind === "film"
          ? formatDisplayTitle(libraryResolved.title, libraryResolved.year)
          : `${formatDisplayTitle(libraryResolved.title, libraryResolved.year)} S${String(episode?.season ?? 0).padStart(2, "0")}E${String(episode?.episode ?? 0).padStart(2, "0")}`;

      const summary = target
        ? `Перенёс в ${formatRelativePath(path.relative(this.settings.download.directory, path.dirname(target)))} как ${display}.`
        : [
            `Тайтл: ${display}`,
            `Переименовано: ${result.renamed.length}`,
            `Пропущено: ${result.skipped.length}`,
            ...result.skipped.slice(0, 3).map((entry) => `• ${path.basename(entry.path)}: ${entry.reason}`),
          ].join("\n");

      if (message) {
        await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, summary);
      } else {
        await ctx.reply(summary);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.exception("[metadata_fix] failed to apply rename", error, {
        component: "metadata_fix",
        handler: "metadata_fix",
        step: "rename",
        result: "error",
      });
      const text = `Не удалось переместить файл: ${reason}`;
      if (message) {
        await ctx.telegram.editMessageText(message.chat.id, message.message_id, undefined, text);
      } else {
        await ctx.reply(text);
      }
    }
  }

  private async applyLibraryMatchIfNeeded(resolved: TmdbResolvedTitle): Promise<TmdbResolvedTitle> {
    if (resolved.kind !== "tv_show") {
      return resolved;
    }

    const libraryShows = await this.tvLibraryCatalog.listShows();
    const matches = findDeterministicLibraryMatches(resolved.title, libraryShows);

    if (matches.length !== 1) {
      return resolved;
    }

    const show = findLibraryShowById(libraryShows, matches[0].id);

    if (!show) {
      return resolved;
    }

    const tmdbId = show.plexIds.tmdb ?? resolved.plexIds.tmdb;

    if (tmdbId === undefined) {
      return resolved;
    }

    return {
      kind: "tv_show",
      title: show.title,
      year: show.year ?? resolved.year,
      plexIds: {
        ...resolved.plexIds,
        ...show.plexIds,
        tmdb: tmdbId,
      },
    };
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

    this.logger.info("[metadata_fix] hint received", {
      component: "metadata_fix",
      handler: "metadata_fix",
      step: "hint",
      folder_name: formatRelativePath(relativePath),
      has_image: Boolean(input.image),
      ...(input.text ? { user_text: truncateForLog(input.text) } : {}),
    });

    await ctx.reply("Ищу варианты в TMDB…");

    const imdbId = parseImdbId(input.text);

    if (imdbId) {
      const candidates = await this.tmdbResolver.findCandidatesByImdbId(imdbId);

      if (candidates.length === 0) {
        await ctx.reply(`В TMDB нет совпадений для IMDb ID ${imdbId}.`);
        return;
      }

      await this.presentCandidates(ctx, userId, relativePath, candidates, `IMDb: ${imdbId}`);
      return;
    }

    const folderName = path.basename(relativePath) || relativePath;
    const hint = await this.metadataFixHintParser.parse({
      folderName,
      text: input.text,
      image: input.image,
    });

    if (hint.kind === "undefined") {
      if (input.text?.trim()) {
        await this.searchAndPresentMixed(ctx, userId, relativePath, input.text.trim());
        return;
      }

      await ctx.reply(`Не понял подсказку: ${hint.reason}\nОткройте /files и попробуйте снова.`);
      return;
    }

    const candidates = await this.tmdbResolver.searchMixedCandidates({
      query: hint.title,
      year: hint.year,
      limit: 5,
    });

    if (candidates.length === 0) {
      await ctx.reply(`В TMDB ничего не найдено по запросу «${hint.title}».`);
      return;
    }

    await this.presentCandidates(
      ctx,
      userId,
      relativePath,
      candidates,
      `Поиск: ${hint.title}${hint.year ? ` (${hint.year})` : ""}`,
    );
  }

  private async searchAndPresentMixed(
    ctx: Context,
    userId: number,
    relativePath: string,
    query: string,
  ): Promise<void> {
    const search = await this.collectAutoSearchCandidates(relativePath, query);

    if (search.candidates.length === 0) {
      await ctx.reply(`В TMDB ничего не найдено по запросу «${query}».`);
      return;
    }

    await this.presentCandidates(ctx, userId, relativePath, search.candidates, search.searchLabel);
  }

  private async beginMetadataFixSession(
    ctx: Context,
    userId: number,
    relativePath: string,
    extraQuery?: string,
  ): Promise<void> {
    await ctx.reply(`Исправление метаданных: ${formatRelativePath(relativePath)}\nИщу варианты в TMDB…`);

    const search = await this.collectAutoSearchCandidates(relativePath, extraQuery);

    if (search.candidates.length > 0) {
      await this.presentCandidates(ctx, userId, relativePath, search.candidates, search.searchLabel);
      return;
    }

    this.pendingFixHintByUserId.set(userId, {
      relativePath,
      expiresAt: Date.now() + METADATA_FIX_TTL_MS,
    });

    const tried = search.triedQueries.join("», «");

    await ctx.reply(
      [
        tried
          ? `В TMDB ничего не найдено по названию из файла («${tried}»).`
          : "В TMDB ничего не найдено по названию из файла.",
        "Отправьте правильное название текстом, скриншот или ссылку/ID IMDb.",
        "Покажу варианты из TMDB для выбора.",
      ].join("\n"),
    );
  }

  private async collectAutoSearchCandidates(
    relativePath: string,
    extraQuery?: string,
  ): Promise<{ candidates: TmdbCandidate[]; searchLabel: string; triedQueries: string[] }> {
    const fileName = path.basename(relativePath);
    const queries = planMetadataFixSearchQueries(fileName, extraQuery);
    const guessed = await this.metadataFixHintParser.guessTitleFromFilename(fileName);

    if (guessed?.title) {
      const guessLabel = `${guessed.title}${guessed.year ? ` (${guessed.year})` : ""}`;
      const alreadyPlanned = queries.some(
        (entry) => entry.query.toLowerCase() === guessed.title.toLowerCase() && entry.year === guessed.year,
      );

      if (!alreadyPlanned) {
        queries.unshift({
          query: guessed.title,
          year: guessed.year,
          label: `Угадывание: ${guessLabel}`,
        });
      }
    }

    const batches: TmdbCandidate[][] = [];
    const usedQueries: MetadataFixSearchQuery[] = [];

    for (const planned of queries) {
      const cleaned = cleanDownloadTitle(planned.query);
      const batch = await this.tmdbResolver.searchMixedCandidates({
        query: cleaned.query || planned.query,
        year: planned.year ?? cleaned.year,
        limit: 5,
      });

      if (batch.length > 0) {
        batches.push(batch);
        usedQueries.push(planned);
      }
    }

    const candidates = mergeTmdbCandidates(batches);

    this.logger.info("[metadata_fix] auto search finished", {
      component: "metadata_fix",
      handler: "metadata_fix",
      step: "auto_search",
      candidate_count: candidates.length,
      query_count: queries.length,
      folder_name: formatRelativePath(relativePath),
    });

    return {
      candidates,
      searchLabel: buildAutoSearchLabel(usedQueries),
      triedQueries: queries.map((entry) => entry.label),
    };
  }

  private async presentCandidates(
    ctx: Context,
    userId: number,
    relativePath: string,
    candidates: TmdbCandidate[],
    searchLabel: string,
  ): Promise<void> {
    this.clearPendingFixPick(userId);
    const token = createFixPickToken();
    this.pendingFixPickByToken.set(token, {
      relativePath,
      candidates,
      expiresAt: Date.now() + METADATA_FIX_TTL_MS,
    });
    this.pendingFixPickTokenByUserId.set(userId, token);

    this.logger.info("[metadata_fix] presenting candidates", {
      component: "metadata_fix",
      handler: "metadata_fix",
      step: "present",
      candidate_count: candidates.length,
      search_label: searchLabel,
      folder_name: formatRelativePath(relativePath),
    });

    await ctx.reply(
      [
        `Выберите правильный тайтл для: ${formatRelativePath(relativePath)}`,
        searchLabel,
        "Даже один вариант нужно подтвердить кнопкой.",
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

  private getPendingFixEpisode(userId: number): PendingFixEpisode | undefined {
    const pending = this.pendingFixEpisodeByUserId.get(userId);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingFixEpisodeByUserId.delete(userId);
      return undefined;
    }

    return pending;
  }

  private getPendingFixStart(token: string): PendingFixStart | undefined {
    const pending = this.pendingFixStartByToken.get(token);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingFixStartByToken.delete(token);
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

  if (action === "cancel" || action === "manual" || action === "start") {
    return { action, token };
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
      text: "Ввести название",
      callback_data: `${FIX_META_CALLBACK_PREFIX}:manual:${token}`,
    },
  ]);

  rows.push([
    {
      text: "Отмена",
      callback_data: `${FIX_META_CALLBACK_PREFIX}:cancel:${token}`,
    },
  ]);

  return { reply_markup: { inline_keyboard: rows } };
}

export function formatCandidateLabel(candidate: TmdbCandidate): string {
  const year = candidate.year ? ` (${candidate.year})` : "";
  const kind = candidate.kind === "film" ? "Фильм" : "Сериал";
  const label = `${kind}: ${candidate.title}${year}`;

  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

function formatRelativePath(relativePath: string): string {
  return relativePath ? relativePath.split(path.sep).join("/") : "/";
}

function createFixPickToken(): string {
  return randomBytes(9).toString("base64url");
}
