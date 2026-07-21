import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { Logger } from "../config/logger.js";
import { deleteDownloadedFile } from "../files/delete-buttons.js";
import { findDuplicateMedia } from "../metadata/duplicate-scanner.js";
import {
  buildLegacyFallbackFileName,
  MediaMetadataService,
  type PlexMetadata,
} from "../metadata/media-metadata.js";
import { getConfiguredUserSessions, getUserSession, type Settings } from "../config/settings.js";

export type DuplicateChoice = "replace" | "keep" | "skip";

export interface DownloadRequest {
  botMessageId: number;
  telegramUserId: number;
  suggestedFileName?: string;
  mediaKind: "video" | "document";
  receivedAt?: number;
  caption?: string;
  signal?: AbortSignal;
  onOutputPath?: (outputPath: string) => void | Promise<void>;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadResult {
  outputPath: string;
  bytes?: number;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface PreparedDownload {
  metadata: PlexMetadata;
  canonicalPath: string;
  existingPath?: string;
  /** Opaque GramJS message handle used by downloadPrepared. */
  message: unknown;
}

export class DownloadCanceledError extends Error {
  constructor() {
    super("Telegram download was canceled.");
    this.name = "DownloadCanceledError";
  }
}

export function isDownloadCanceled(error: unknown): error is DownloadCanceledError {
  return error instanceof DownloadCanceledError;
}

interface UserDownloadClient {
  client: TelegramClient;
  botEntity: unknown;
}

export class TelegramDownloader {
  private readonly userClients = new Map<number, UserDownloadClient>();
  /** GramJS is not safe for concurrent downloadMedia on one client; serialize per user. */
  private readonly mediaDownloadTails = new Map<number, Promise<unknown>>();

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly mediaMetadataService: MediaMetadataService,
  ) {}

  async start(): Promise<void> {
    const configuredSessions = getConfiguredUserSessions(this.settings);

    if (configuredSessions.length === 0) {
      throw new Error(
        "No GramJS user sessions configured. Run npm run login -- --user-id <telegram_user_id> for each user.",
      );
    }

    await mkdir(this.settings.download.directory, { recursive: true });

    for (const { userId, session } of configuredSessions) {
      const client = new TelegramClient(
        new StringSession(session),
        this.settings.telegram.apiId,
        this.settings.telegram.apiHash,
        { connectionRetries: 5 },
      );

      await client.connect();
      const botEntity = await client.getEntity(`@${this.settings.telegram.botUsername}`);
      this.userClients.set(userId, { client, botEntity });
      this.logger.info(`GramJS client connected for user ${userId}.`);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.userClients.values()].map(async ({ client }) => {
        await client.disconnect();
      }),
    );
    this.userClients.clear();
    this.mediaDownloadTails.clear();
    this.logger.info("GramJS clients disconnected.");
  }

  async prepareDownload(request: DownloadRequest): Promise<PreparedDownload> {
    const userClient = this.getUserClient(request.telegramUserId);

    throwIfDownloadCanceled(request.signal);

    const message = await this.getDownloadableBotMessage(userClient, request);

    if (!hasDownloadableMedia(message)) {
      throw new Error(`Telegram message ${request.botMessageId} does not contain downloadable media.`);
    }

    throwIfDownloadCanceled(request.signal);

    const { metadata, canonicalPath } = await this.resolveCanonicalPath(request);
    const existingPath = await findDuplicateMedia(this.settings.download.directory, metadata);

    return {
      message,
      metadata,
      canonicalPath,
      existingPath,
    };
  }

  async downloadPrepared(
    prepared: PreparedDownload,
    request: DownloadRequest,
    choice?: DuplicateChoice,
  ): Promise<DownloadResult> {
    if (choice === "skip") {
      throw new Error("Cannot download after skip choice.");
    }

    const userClient = this.getUserClient(request.telegramUserId);
    throwIfDownloadCanceled(request.signal);

    const outputPath = await this.resolveDownloadOutputPath(prepared, choice);

    if (choice === "replace" && prepared.existingPath) {
      await deleteDownloadedFile(prepared.existingPath, this.settings.download.directory);
    }

    this.logger.info(`Downloading Telegram message ${request.botMessageId} to ${outputPath}`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await request.onOutputPath?.(outputPath);
    throwIfDownloadCanceled(request.signal);

    await this.withExclusiveMediaDownload(request.telegramUserId, async () => {
      throwIfDownloadCanceled(request.signal);

      await userClient.client.downloadMedia(prepared.message as never, {
        outputFile: outputPath,
        progressCallback: (downloaded: unknown, total: unknown) => {
          throwIfDownloadCanceled(request.signal);
          request.onProgress?.(toDownloadProgress(downloaded, total));
          throwIfDownloadCanceled(request.signal);
        },
      } as never);
    });

    throwIfDownloadCanceled(request.signal);

    const fileStat = await stat(outputPath);

    return {
      outputPath,
      bytes: fileStat.size,
    };
  }

  private async withExclusiveMediaDownload<T>(telegramUserId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.mediaDownloadTails.get(telegramUserId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.mediaDownloadTails.set(
      telegramUserId,
      previous.catch(() => undefined).then(() => gate),
    );

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
    }
  }

  async downloadFromBotMessage(request: DownloadRequest): Promise<DownloadResult> {
    const prepared = await this.prepareDownload(request);
    return this.downloadPrepared(prepared, request);
  }

  private async resolveDownloadOutputPath(
    prepared: PreparedDownload,
    choice: DuplicateChoice | undefined,
  ): Promise<string> {
    if (choice === "replace") {
      return prepared.canonicalPath;
    }

    if (choice === "keep") {
      return getAvailablePath(prepared.canonicalPath);
    }

    if (this.settings.download.overwriteExisting) {
      return prepared.canonicalPath;
    }

    return getAvailablePath(prepared.canonicalPath);
  }

  private async resolveCanonicalPath(
    request: DownloadRequest,
  ): Promise<{ metadata: PlexMetadata; canonicalPath: string }> {
    const fallbackName = `${request.mediaKind}-${request.botMessageId}${request.mediaKind === "video" ? ".mp4" : ".bin"}`;
    const originalName = request.suggestedFileName || fallbackName;
    const safeName = buildLegacyFallbackFileName(originalName);
    const extension = path.extname(safeName) || (request.mediaKind === "video" ? ".mp4" : ".bin");
    const metadata = await this.mediaMetadataService.resolveMetadata({
      fileName: request.suggestedFileName,
      description: request.caption,
    });
    const canonicalPath = this.mediaMetadataService.buildOutputPath(
      metadata,
      this.settings.download.directory,
      safeName,
      extension,
    );

    this.logger.info(`Classified Telegram message ${request.botMessageId} as ${metadata.kind}.`, metadata);

    return { metadata, canonicalPath };
  }

  private getUserClient(telegramUserId: number): UserDownloadClient {
    const userClient = this.userClients.get(telegramUserId);

    if (!userClient) {
      if (!getUserSession(this.settings, telegramUserId)) {
        throw new Error(
          `No GramJS session for user ${telegramUserId}. Run: npm run login -- --user-id ${telegramUserId}`,
        );
      }

      throw new Error("Downloader has not been started.");
    }

    return userClient;
  }

  private async getDownloadableBotMessage(
    userClient: UserDownloadClient,
    request: DownloadRequest,
  ): Promise<GramMessage | undefined> {
    const directMessage = await this.getBotMessage(userClient, request.botMessageId);

    if (hasDownloadableMedia(directMessage)) {
      return directMessage;
    }

    this.logger.debug(`Telegram message ${request.botMessageId} was not downloadable by direct ID lookup.`, {
      message: summarizeGramMessage(directMessage),
    });

    return this.findRecentOutgoingBotMedia(userClient, request);
  }

  private async getBotMessage(userClient: UserDownloadClient, messageId: number): Promise<GramMessage | undefined> {
    const result = await userClient.client.getMessages(userClient.botEntity as never, {
      ids: messageId,
    } as never);

    if (Array.isArray(result)) {
      return result[0] as GramMessage | undefined;
    }

    return result as GramMessage | undefined;
  }

  private async findRecentOutgoingBotMedia(
    userClient: UserDownloadClient,
    request: DownloadRequest,
  ): Promise<GramMessage | undefined> {
    let fallback: GramMessage | undefined;

    for await (const candidate of userClient.client.iterMessages(userClient.botEntity as never, {
      fromUser: "me",
      limit: 25,
    } as never)) {
      const message = candidate as GramMessage;

      if (!hasDownloadableMedia(message)) {
        continue;
      }

      if (!isNearReceivedTime(message, request.receivedAt)) {
        continue;
      }

      if (request.caption && normalizeCaption(message.message) === normalizeCaption(request.caption)) {
        return message;
      }

      fallback ??= message;
    }

    if (fallback) {
      this.logger.debug(`Using recent outgoing Telegram media ${fallback.id} for bot message ${request.botMessageId}.`, {
        message: summarizeGramMessage(fallback),
      });
    }

    return fallback;
  }
}

interface GramMessage {
  id?: number;
  media?: unknown;
  date?: number;
  out?: boolean;
  message?: string;
}

function hasDownloadableMedia(message: GramMessage | undefined): boolean {
  const mediaClassName = getClassName(message?.media);

  return mediaClassName === "MessageMediaDocument" || mediaClassName === "MessageMediaPhoto";
}

function isNearReceivedTime(message: GramMessage, receivedAt: number | undefined): boolean {
  if (!receivedAt || !message.date) {
    return true;
  }

  return Math.abs(message.date - receivedAt) <= 10 * 60;
}

function normalizeCaption(caption: string | undefined): string {
  return (caption ?? "").replace(/\s+/g, " ").trim();
}

function summarizeGramMessage(message: GramMessage | undefined): Record<string, unknown> | undefined {
  if (!message) {
    return undefined;
  }

  return {
    id: message.id,
    date: message.date,
    out: message.out,
    media: getClassName(message.media),
    caption: message.message,
  };
}

function getClassName(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "className" in value) {
    return String(value.className);
  }

  return undefined;
}

function toDownloadProgress(downloaded: unknown, total: unknown): DownloadProgress {
  const downloadedBytes = toByteCount(downloaded) ?? 0;
  const totalBytes = toByteCount(total);
  const percent = totalBytes && totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : undefined;

  return {
    downloadedBytes,
    totalBytes,
    percent,
  };
}

function toByteCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object" && value !== null && "toJSNumber" in value && typeof value.toJSNumber === "function") {
    return value.toJSNumber() as number;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function throwIfDownloadCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DownloadCanceledError();
  }
}

export async function getAvailablePath(filePath: string): Promise<string> {
  if (!(await exists(filePath))) {
    return filePath;
  }

  const parsed = path.parse(filePath);

  for (let index = 1; index < 10_000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);

    if (!(await exists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Could not find an available filename for ${filePath}.`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
