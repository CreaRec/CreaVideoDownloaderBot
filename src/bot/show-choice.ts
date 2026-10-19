import { randomBytes } from "node:crypto";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { DeleteButtonReplyMarkup } from "../files/delete-buttons.js";
import type { LibraryTvShow, ShowLibraryResolution } from "../metadata/tv-library-catalog.js";
import { formatDisplayTitle } from "../metadata/media-metadata.js";

export const SHOW_CALLBACK_PREFIX = "dl-show";
export const SHOW_CHOICE_TTL_MS = 10 * 60 * 1000;

export type ShowCallbackAction = "library" | "tmdb";

export interface ShowCallback {
  action: ShowCallbackAction;
  token: string;
  showId?: string;
}

interface PendingShowChoice {
  chatId: number;
  messageId: number;
  classifiedTitle: string;
  candidates: LibraryTvShow[];
  expiresAt: number;
  resolve: (choice: ShowLibraryResolution) => void;
  timeout: NodeJS.Timeout;
}

export class ShowChoicePending {
  private readonly pendingByToken = new Map<string, PendingShowChoice>();

  create(
    input: {
      chatId: number;
      messageId: number;
      classifiedTitle: string;
      candidates: LibraryTvShow[];
    },
    ttlMs = SHOW_CHOICE_TTL_MS,
  ): { token: string; choice: Promise<ShowLibraryResolution> } {
    const token = randomBytes(8).toString("hex");

    let resolveChoice: (choice: ShowLibraryResolution) => void = () => {};
    const choice = new Promise<ShowLibraryResolution>((resolve) => {
      resolveChoice = resolve;
    });

    const timeout = setTimeout(() => {
      this.resolveToken(token, { source: "tmdb" });
    }, ttlMs);
    timeout.unref();

    this.pendingByToken.set(token, {
      chatId: input.chatId,
      messageId: input.messageId,
      classifiedTitle: input.classifiedTitle,
      candidates: input.candidates,
      expiresAt: Date.now() + ttlMs,
      resolve: resolveChoice,
      timeout,
    });

    return { token, choice };
  }

  resolveToken(token: string, choice: ShowLibraryResolution): boolean {
    const pending = this.pendingByToken.get(token);

    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingByToken.delete(token);
    pending.resolve(choice);
    return true;
  }

  get(token: string): PendingShowChoice | undefined {
    const pending = this.pendingByToken.get(token);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.resolveToken(token, { source: "tmdb" });
      return undefined;
    }

    return pending;
  }
}

export function createShowChoiceReplyMarkup(token: string, candidates: LibraryTvShow[]): DeleteButtonReplyMarkup {
  const rows = candidates.map((show) => [
    {
      text: formatDisplayTitle(show.title, show.year),
      callback_data: createShowCallbackData("library", token, show.id),
    },
  ]);

  rows.push([{ text: "New show / search TMDB", callback_data: createShowCallbackData("tmdb", token) }]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    } satisfies InlineKeyboardMarkup,
  };
}

export function createShowAmbiguityPromptMessage(classifiedTitle: string, candidates: LibraryTvShow[]): string {
  const options = candidates.map((show) => `• ${formatDisplayTitle(show.title, show.year)}`).join("\n");
  return `Several TV shows in your library match «${classifiedTitle}».\n\n${options}\n\nWhich folder should I use?`;
}

export function parseShowCallbackData(data: string | undefined): ShowCallback | undefined {
  if (!data) {
    return undefined;
  }

  const parts = data.split(":");

  if (parts.length < 3 || parts[0] !== SHOW_CALLBACK_PREFIX) {
    return undefined;
  }

  const action = parts[1];
  const token = parts[2];
  const showId = parts[3];

  if (!isShowCallbackAction(action) || !token) {
    return undefined;
  }

  if (action === "library" && !showId) {
    return undefined;
  }

  return { action, token, showId };
}

function createShowCallbackData(action: ShowCallbackAction, token: string, showId?: string): string {
  if (action === "library" && showId) {
    return `${SHOW_CALLBACK_PREFIX}:${action}:${token}:${showId}`;
  }

  return `${SHOW_CALLBACK_PREFIX}:${action}:${token}`;
}

function isShowCallbackAction(value: string): value is ShowCallbackAction {
  return value === "library" || value === "tmdb";
}
