import type { DeleteButtonReplyMarkup } from "../files/delete-buttons.js";
import type { DownloadProgress, DownloadResult } from "./downloader.js";
import type { Logger } from "../config/logger.js";
import type { StatusEditScheduler, StatusReplyFn } from "./status-edit-scheduler.js";
import type { ReplyFn } from "../telegram/telegram-ctx.js";

export const DEFAULT_PROGRESS_PERCENT_STEP = 10;
export const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 10_000;

interface ProgressReporterOptions {
  scheduler: StatusEditScheduler;
  chatId: number;
  fileName: string;
  logger: Logger;
  messageId: number;
  statusMessageId?: number;
  progressMinIntervalMs?: number;
  progressPercentStep?: number;
  getStatusMarkup?: () => DeleteButtonReplyMarkup | undefined;
  isDeleted?: () => boolean;
}

export function createProgressReporter(options: ProgressReporterOptions): {
  report: (progress: DownloadProgress) => void;
  complete: (result: DownloadResult, reply: ReplyFn) => Promise<void>;
  fail: (reply: ReplyFn) => Promise<void>;
  refresh: () => Promise<void>;
  getLastMessage: () => string;
} {
  const progressMinIntervalMs = options.progressMinIntervalMs ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS;
  const progressPercentStep = options.progressPercentStep ?? DEFAULT_PROGRESS_PERCENT_STEP;
  let lastPercent = -1;
  let lastUpdateAt = 0;
  let lastMessage = `Download started: ${options.fileName}`;

  const sendProgress = (message: string): void => {
    if (!options.statusMessageId || options.isDeleted?.()) {
      return;
    }

    lastMessage = message;
    options.scheduler.scheduleProgress(
      options.chatId,
      options.statusMessageId,
      message,
      options.getStatusMarkup?.(),
    );
  };

  const sendTerminal = async (message: string, reply?: StatusReplyFn): Promise<void> => {
    if (!options.statusMessageId || options.isDeleted?.()) {
      return;
    }

    lastMessage = message;
    await options.scheduler.scheduleTerminal(
      options.chatId,
      options.statusMessageId,
      message,
      options.getStatusMarkup?.(),
      reply,
    );
  };

  const report = (progress: DownloadProgress): void => {
    const percent = progress.percent;
    const now = Date.now();

    if (percent === undefined) {
      if (now - lastUpdateAt < progressMinIntervalMs) {
        return;
      }

      lastUpdateAt = now;
      options.logger.info(`Downloading Telegram message ${options.messageId}: ${formatBytes(progress.downloadedBytes)} downloaded`);
      sendProgress(`Downloading ${options.fileName}: ${formatBytes(progress.downloadedBytes)} downloaded`);
      return;
    }

    const steppedPercent = Math.floor(percent / progressPercentStep) * progressPercentStep;

    if (steppedPercent <= lastPercent && now - lastUpdateAt < progressMinIntervalMs) {
      return;
    }

    lastPercent = steppedPercent;
    lastUpdateAt = now;
    options.logger.info(`Downloading Telegram message ${options.messageId}: ${percent}%`);
    sendProgress(
      `Downloading ${options.fileName}: ${percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)})`,
    );
  };

  const complete = async (result: DownloadResult, reply: ReplyFn): Promise<void> => {
    const message = `Saved ${options.fileName} to ${result.outputPath} (${formatBytes(result.bytes)})`;

    if (options.isDeleted?.()) {
      return;
    }

    if (options.statusMessageId) {
      await sendTerminal(message, reply);
      return;
    }

    await safeStandaloneReply(reply, options.logger, message);
  };

  const fail = async (reply: ReplyFn): Promise<void> => {
    const message = `Failed to download ${options.fileName}. Check the logs for details.`;

    if (options.isDeleted?.()) {
      return;
    }

    if (options.statusMessageId) {
      await sendTerminal(message, reply);
      return;
    }

    await safeStandaloneReply(reply, options.logger, message);
  };

  const refresh = async (): Promise<void> => {
    await sendTerminal(lastMessage);
  };

  return { report, complete, fail, refresh, getLastMessage: () => lastMessage };
}

export async function safeStandaloneReply(reply: ReplyFn, logger: Logger, message: string): Promise<void> {
  try {
    await reply(message);
  } catch (error) {
    logger.warn("Failed to send Telegram reply.", error);
  }
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return "unknown size";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
