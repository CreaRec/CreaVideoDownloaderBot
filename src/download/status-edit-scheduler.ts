import type { DeleteButtonReplyMarkup } from "../files/delete-buttons.js";
import type { Logger } from "../config/logger.js";

export type StatusReplyFn = (message: string) => Promise<{ message_id?: number }>;

interface PendingProgress {
  chatId: number;
  messageId: number;
  text: string;
  markup?: DeleteButtonReplyMarkup;
}

interface TerminalJob {
  chatId: number;
  messageId: number;
  text: string;
  markup?: DeleteButtonReplyMarkup;
  reply?: StatusReplyFn;
  resolve: () => void;
}

type EditStatusFn = (
  chatId: number,
  messageId: number,
  text: string,
  markup?: DeleteButtonReplyMarkup,
) => Promise<unknown>;

export function getRetryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }

  const response = (error as { response?: { parameters?: { retry_after?: number } } }).response;
  const retryAfter = response?.parameters?.retry_after;

  if (typeof retryAfter !== "number" || retryAfter <= 0) {
    return undefined;
  }

  return retryAfter;
}

export class StatusEditScheduler {
  private blockedUntil = 0;
  private lastEditAt = 0;
  private workerRunning = false;
  private pumpScheduled = false;
  private readonly pendingProgress = new Map<string, PendingProgress>();
  private readonly terminalQueue: TerminalJob[] = [];

  constructor(
    private readonly editStatus: EditStatusFn,
    private readonly logger: Logger,
    private readonly minGapMs: number,
    private readonly maxTerminalRetries = 5,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  ) {}

  scheduleProgress(chatId: number, messageId: number, text: string, markup?: DeleteButtonReplyMarkup): void {
    this.pendingProgress.set(this.messageKey(chatId, messageId), { chatId, messageId, text, markup });
    this.requestPump();
  }

  scheduleTerminal(
    chatId: number,
    messageId: number,
    text: string,
    markup?: DeleteButtonReplyMarkup,
    reply?: StatusReplyFn,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.terminalQueue.push({ chatId, messageId, text, markup, reply, resolve });
      this.requestPump();
    });
  }

  async whenIdle(): Promise<void> {
    while (this.pumpScheduled || this.workerRunning || this.hasWork()) {
      await this.sleep(0);
    }
  }

  private messageKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  private hasWork(): boolean {
    return this.terminalQueue.length > 0 || this.pendingProgress.size > 0;
  }

  private requestPump(): void {
    if (this.pumpScheduled || this.workerRunning) {
      return;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.workerRunning) {
      return;
    }

    this.workerRunning = true;

    try {
      while (this.hasWork()) {
        if (this.terminalQueue.length > 0) {
          const job = this.terminalQueue.shift();

          if (job) {
            await this.executeTerminal(job);
          }

          continue;
        }

        const nextProgress = this.pendingProgress.entries().next();

        if (nextProgress.done) {
          break;
        }

        const [key, job] = nextProgress.value;
        this.pendingProgress.delete(key);
        await this.executeProgress(job);
      }
    } finally {
      this.workerRunning = false;

      if (this.hasWork()) {
        this.requestPump();
      }
    }
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const waitUntil = Math.max(this.blockedUntil, this.lastEditAt + this.minGapMs);

    if (now < waitUntil) {
      await this.sleep(waitUntil - now);
    }
  }

  private async executeEdit(
    chatId: number,
    messageId: number,
    text: string,
    markup?: DeleteButtonReplyMarkup,
  ): Promise<void> {
    await this.waitForSlot();

    try {
      await this.editStatus(chatId, messageId, text, markup);
      this.lastEditAt = Date.now();
    } catch (error) {
      const retryAfter = getRetryAfterSeconds(error);

      if (retryAfter !== undefined) {
        this.blockedUntil = Date.now() + retryAfter * 1_000;
      }

      throw error;
    }
  }

  private async executeProgress(job: PendingProgress): Promise<void> {
    try {
      await this.executeEdit(job.chatId, job.messageId, job.text, job.markup);
    } catch (error) {
      this.logger.warn("Failed to edit Telegram progress message.", error);
    }
  }

  private async executeTerminal(job: TerminalJob): Promise<void> {
    for (let attempt = 0; attempt < this.maxTerminalRetries; attempt += 1) {
      try {
        await this.executeEdit(job.chatId, job.messageId, job.text, job.markup);
        job.resolve();
        return;
      } catch (error) {
        this.logger.warn("Failed to edit Telegram progress message.", error);

        if (attempt >= this.maxTerminalRetries - 1) {
          break;
        }

        const retryAfter = getRetryAfterSeconds(error);

        if (retryAfter !== undefined) {
          await this.sleep(retryAfter * 1_000);
          this.blockedUntil = Date.now();
        } else {
          await this.sleep(1_000);
        }
      }
    }

    if (job.reply) {
      try {
        await job.reply(job.text);
        job.resolve();
        return;
      } catch (error) {
        this.logger.warn("Failed to send Telegram reply.", error);
      }
    }

    job.resolve();
  }
}
