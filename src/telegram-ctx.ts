import type { Context } from "telegraf";
import type { Logger } from "./logger.js";
import type { Settings } from "./settings.js";
import { isConfiguredUser } from "./settings.js";

export type TelegramStatusMessage = { message_id?: number };
export type ReplyFn = (message: string) => Promise<TelegramStatusMessage>;
export type CallbackMessage = { message_id: number; chat: { id: number }; text?: string };

export const BOT_PRIVATE_MESSAGE = "This bot is private.";
export const BOT_HELP_MESSAGE =
  "I can download Telegram videos and document-style video files. Send one here to start, use /files to browse downloaded files, use /usage for OpenAI usage, or use /restart to restart the service.";

export function isAllowedUser(settings: Settings, userId: number | undefined): userId is number {
  return userId !== undefined && isConfiguredUser(settings, userId);
}

export function getCallbackData(ctx: Context): string | undefined {
  return "callbackQuery" in ctx && ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
}

export function getCallbackMessage(ctx: Context): CallbackMessage | undefined {
  const callbackQuery = "callbackQuery" in ctx ? ctx.callbackQuery : undefined;

  if (!callbackQuery || !("message" in callbackQuery) || !callbackQuery.message) {
    return undefined;
  }

  const message = callbackQuery.message;

  if (!("message_id" in message) || !("chat" in message) || typeof message.message_id !== "number") {
    return undefined;
  }

  const chat = message.chat;

  if (!("id" in chat) || typeof chat.id !== "number") {
    return undefined;
  }

  return {
    message_id: message.message_id,
    chat: { id: chat.id },
    text: "text" in message && typeof message.text === "string" ? message.text : undefined,
  };
}

export function getCommandArgument(ctx: Context): string | undefined {
  if (!("message" in ctx) || !ctx.message || !("text" in ctx.message) || typeof ctx.message.text !== "string") {
    return undefined;
  }

  const [, ...args] = ctx.message.text.trim().split(/\s+/);
  const argument = args.join(" ").trim();
  return argument || undefined;
}

export async function safeReply(reply: ReplyFn, logger: Logger, message: string): Promise<TelegramStatusMessage | undefined> {
  try {
    return await reply(message);
  } catch (error) {
    logger.warn("Failed to send Telegram reply.", error);
    return undefined;
  }
}

export async function answerCallback(ctx: Context, logger: Logger, message: string): Promise<void> {
  try {
    await ctx.answerCbQuery(message);
  } catch (error) {
    logger.warn("Failed to answer Telegram callback query.", error);
  }
}
