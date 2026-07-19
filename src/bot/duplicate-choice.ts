import { randomBytes } from "node:crypto";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { DeleteButtonReplyMarkup } from "../files/delete-buttons.js";
import type { DuplicateChoice } from "../download/downloader.js";

export const DUPLICATE_CALLBACK_PREFIX = "dl-dup";
export const DUPLICATE_CHOICE_TTL_MS = 10 * 60 * 1000;

export type DuplicateCallbackAction = DuplicateChoice;

export interface DuplicateCallback {
  action: DuplicateCallbackAction;
  token: string;
}

interface PendingDuplicateChoice {
  chatId: number;
  messageId: number;
  existingPath: string;
  expiresAt: number;
  resolve: (choice: DuplicateChoice) => void;
  timeout: NodeJS.Timeout;
}

export class DuplicateChoicePending {
  private readonly pendingByToken = new Map<string, PendingDuplicateChoice>();

  create(
    input: { chatId: number; messageId: number; existingPath: string },
    ttlMs = DUPLICATE_CHOICE_TTL_MS,
  ): { token: string; choice: Promise<DuplicateChoice> } {
    const token = randomBytes(8).toString("hex");

    let resolveChoice: (choice: DuplicateChoice) => void = () => {};
    const choice = new Promise<DuplicateChoice>((resolve) => {
      resolveChoice = resolve;
    });

    const timeout = setTimeout(() => {
      this.resolveToken(token, "skip");
    }, ttlMs);
    timeout.unref();

    this.pendingByToken.set(token, {
      chatId: input.chatId,
      messageId: input.messageId,
      existingPath: input.existingPath,
      expiresAt: Date.now() + ttlMs,
      resolve: resolveChoice,
      timeout,
    });

    return { token, choice };
  }

  resolveToken(token: string, choice: DuplicateChoice): boolean {
    const pending = this.pendingByToken.get(token);

    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingByToken.delete(token);
    pending.resolve(choice);
    return true;
  }

  get(token: string): PendingDuplicateChoice | undefined {
    const pending = this.pendingByToken.get(token);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.resolveToken(token, "skip");
      return undefined;
    }

    return pending;
  }
}

export function createDuplicateChoiceReplyMarkup(token: string): DeleteButtonReplyMarkup {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Replace", callback_data: createDuplicateCallbackData("replace", token) },
          { text: "Keep both", callback_data: createDuplicateCallbackData("keep", token) },
          { text: "Skip", callback_data: createDuplicateCallbackData("skip", token) },
        ],
      ],
    } satisfies InlineKeyboardMarkup,
  };
}

export function createDuplicatePromptMessage(existingPath: string): string {
  return `Already exists:\n${existingPath}\n\nReplace, keep both, or skip?`;
}

export function createDuplicateSkippedMessage(fileName: string, existingPath: string): string {
  return `Skipped (duplicate): ${fileName}\nExisting: ${existingPath}`;
}

export function parseDuplicateCallbackData(data: string | undefined): DuplicateCallback | undefined {
  if (!data) {
    return undefined;
  }

  const parts = data.split(":");

  if (parts.length !== 3 || parts[0] !== DUPLICATE_CALLBACK_PREFIX) {
    return undefined;
  }

  const action = parts[1];
  const token = parts[2];

  if (!isDuplicateCallbackAction(action) || !token) {
    return undefined;
  }

  return { action, token };
}

function createDuplicateCallbackData(action: DuplicateCallbackAction, token: string): string {
  return `${DUPLICATE_CALLBACK_PREFIX}:${action}:${token}`;
}

function isDuplicateCallbackAction(value: string): value is DuplicateCallbackAction {
  return value === "replace" || value === "keep" || value === "skip";
}
