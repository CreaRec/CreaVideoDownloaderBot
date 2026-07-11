import type { Message } from "telegraf/types";

export type DownloadableMessage = Message.VideoMessage | Message.DocumentMessage;

export function getSuggestedFileName(message: DownloadableMessage): string | undefined {
  if ("document" in message && message.document.file_name) {
    return message.document.file_name;
  }

  if ("video" in message && "file_name" in message.video && typeof message.video.file_name === "string") {
    return message.video.file_name;
  }

  return undefined;
}

export function getDisplayFileName(message: DownloadableMessage): string {
  return getSuggestedFileName(message) ?? `${"video" in message ? "video" : "document"}-${message.message_id}`;
}

export function getCaption(message: DownloadableMessage): string | undefined {
  if ("caption" in message) {
    return message.caption;
  }

  return undefined;
}
