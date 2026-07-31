import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InlineKeyboardMarkup } from "telegraf/types";
import { isPathInsideDirectory, pruneEmptyParentDirectories } from "../download/download-paths.js";
import {
  buildKidsTargetRelativePath,
  canMoveRelativePathToKids,
  movePathToKids,
  resolveLibraryItemRelativePath,
} from "./kids-move.js";

export { isPathInsideDirectory } from "../download/download-paths.js";

const CALLBACK_PREFIX = "file-delete";

const DELETE_CONFIRMATION_MARKER = "\n\nDelete this downloaded file?";
const MOVE_CONFIRMATION_MARKER = "\n\nMove this to Kids?";

export type DeleteButtonAction = "ask" | "confirm" | "cancel" | "ask-move" | "confirm-move";
export type MoveDownloadedToKidsOutcome = "moved" | "missing" | "protected" | "target-exists";

export interface DeleteButtonRecord {
  token: string;
  chatId: number;
  messageId: number;
  filePath: string;
  originalText: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface DeleteButtonStateFile {
  records: DeleteButtonRecord[];
}

export interface DeleteButtonReplyMarkup {
  reply_markup: InlineKeyboardMarkup;
}

export interface DeleteButtonCallback {
  action: DeleteButtonAction;
  token: string;
}

export class DeleteButtonState {
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, DeleteButtonRecord>();

  constructor(private readonly statePath: string) {}

  static forStateDirectory(stateDirectory: string): DeleteButtonState {
    return new DeleteButtonState(path.join(stateDirectory, "delete-buttons.json"));
  }

  async upsertForStatus(input: {
    chatId: number;
    messageId: number;
    filePath: string;
    originalText: string;
  }): Promise<DeleteButtonRecord> {
    await this.load();

    const existing = [...this.records.values()].find(
      (record) =>
        record.chatId === input.chatId &&
        record.messageId === input.messageId &&
        record.filePath === input.filePath &&
        !record.deletedAt,
    );
    const now = new Date().toISOString();

    if (existing) {
      existing.originalText = input.originalText;
      existing.updatedAt = now;
      await this.save();
      return existing;
    }

    const record: DeleteButtonRecord = {
      token: this.createUniqueToken(),
      chatId: input.chatId,
      messageId: input.messageId,
      filePath: input.filePath,
      originalText: input.originalText,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(record.token, record);
    await this.save();
    return record;
  }

  async get(token: string): Promise<DeleteButtonRecord | undefined> {
    await this.load();
    return this.records.get(token);
  }

  getCached(token: string): DeleteButtonRecord | undefined {
    return this.records.get(token);
  }

  async updateOriginalText(token: string, originalText: string): Promise<DeleteButtonRecord | undefined> {
    await this.load();

    const record = this.records.get(token);

    if (!record) {
      return undefined;
    }

    record.originalText = originalText;
    record.updatedAt = new Date().toISOString();
    await this.save();
    return record;
  }

  async markDeleted(token: string): Promise<DeleteButtonRecord | undefined> {
    await this.load();

    const record = this.records.get(token);

    if (!record) {
      return undefined;
    }

    const now = new Date().toISOString();
    record.deletedAt = now;
    record.updatedAt = now;
    await this.save();
    return record;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    let rawState: string;

    try {
      rawState = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.loaded = true;
        return;
      }

      throw error;
    }

    const parsed = JSON.parse(rawState) as DeleteButtonStateFile;

    for (const record of parsed.records ?? []) {
      this.records.set(record.token, record);
    }

    this.loaded = true;
  }

  private async save(): Promise<void> {
    this.saveQueue = this.saveQueue.then(() => this.writeStateFile());
    await this.saveQueue;
  }

  private async writeStateFile(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });

    const state: DeleteButtonStateFile = {
      records: [...this.records.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
    const tempPath = `${this.statePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }

  private createUniqueToken(): string {
    let token = randomBytes(12).toString("base64url");

    while (this.records.has(token)) {
      token = randomBytes(12).toString("base64url");
    }

    return token;
  }
}

export function createDeleteButtonReplyMarkup(
  token: string,
  options: { includeMoveToKids?: boolean } = {},
): DeleteButtonReplyMarkup {
  const rows = [[{ text: "Delete file", callback_data: createDeleteCallbackData("ask", token) }]];

  if (options.includeMoveToKids) {
    rows.push([{ text: "Move to Kids", callback_data: createDeleteCallbackData("ask-move", token) }]);
  }

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

export function createStatusActionReplyMarkup(
  token: string,
  filePath: string,
  downloadDirectory: string,
): DeleteButtonReplyMarkup {
  return createDeleteButtonReplyMarkup(token, {
    includeMoveToKids: canMoveDownloadedPathToKids(filePath, downloadDirectory),
  });
}

export function createDeleteConfirmationReplyMarkup(token: string): DeleteButtonReplyMarkup {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Confirm delete", callback_data: createDeleteCallbackData("confirm", token) },
          { text: "Cancel", callback_data: createDeleteCallbackData("cancel", token) },
        ],
      ],
    },
  };
}

export function createMoveToKidsConfirmationReplyMarkup(token: string): DeleteButtonReplyMarkup {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Confirm move", callback_data: createDeleteCallbackData("confirm-move", token) },
          { text: "Cancel", callback_data: createDeleteCallbackData("cancel", token) },
        ],
      ],
    },
  };
}

export function parseDeleteCallbackData(data: string | undefined): DeleteButtonCallback | undefined {
  if (!data) {
    return undefined;
  }

  const [prefix, action, token] = data.split(":");

  if (prefix !== CALLBACK_PREFIX || !isDeleteButtonAction(action) || !token) {
    return undefined;
  }

  return { action, token };
}

export function createDeletedStatusMessage(originalText: string, filePath: string): string {
  return `${originalText}\n\nDeleted file: ${filePath}`;
}

export function createDeleteFailedStatusMessage(originalText: string, filePath: string, reason: string): string {
  return `${originalText}\n\nCould not delete file: ${filePath}\n${reason}`;
}

export function createDeleteConfirmationStatusMessage(originalText: string): string {
  return `${originalText}${DELETE_CONFIRMATION_MARKER}`;
}

export function createMoveToKidsConfirmationStatusMessage(
  originalText: string,
  sourceRelativePath: string,
  targetRelativePath: string,
): string {
  return `${originalText}${MOVE_CONFIRMATION_MARKER}\n${formatRelativePath(sourceRelativePath)}\n→\n${formatRelativePath(targetRelativePath)}`;
}

export function createMovedToKidsStatusMessage(
  originalText: string,
  sourceRelativePath: string,
  targetRelativePath: string,
): string {
  return `${originalText}\n\nMoved to Kids: ${formatRelativePath(sourceRelativePath)} → ${formatRelativePath(targetRelativePath)}`;
}

export function createMoveToKidsFailedStatusMessage(originalText: string, reason: string): string {
  return `${originalText}\n\nCould not move to Kids.\n${reason}`;
}

export function stripStatusConfirmationSuffix(text: string): string {
  for (const marker of [DELETE_CONFIRMATION_MARKER, MOVE_CONFIRMATION_MARKER]) {
    const index = text.indexOf(marker);

    if (index !== -1) {
      return text.slice(0, index);
    }
  }

  return text;
}

export function canMoveDownloadedPathToKids(filePath: string, downloadDirectory: string): boolean {
  if (!isPathInsideDirectory(filePath, downloadDirectory)) {
    return false;
  }

  const relativePath = path.relative(path.resolve(downloadDirectory), path.resolve(filePath));
  const libraryItemPath = resolveLibraryItemRelativePath(relativePath);

  return libraryItemPath !== undefined && canMoveRelativePathToKids(libraryItemPath);
}

export function resolveMoveToKidsPaths(
  filePath: string,
  downloadDirectory: string,
): { sourceRelativePath: string; targetRelativePath: string } | undefined {
  if (!isPathInsideDirectory(filePath, downloadDirectory)) {
    return undefined;
  }

  const relativePath = path.relative(path.resolve(downloadDirectory), path.resolve(filePath));
  const sourceRelativePath = resolveLibraryItemRelativePath(relativePath);

  if (!sourceRelativePath) {
    return undefined;
  }

  return {
    sourceRelativePath,
    targetRelativePath: buildKidsTargetRelativePath(sourceRelativePath),
  };
}

export async function deleteDownloadedFile(filePath: string, downloadDirectory: string): Promise<"deleted" | "missing"> {
  if (!isPathInsideDirectory(filePath, downloadDirectory)) {
    throw new Error("Refusing to delete a file outside the configured download directory.");
  }

  try {
    await unlink(filePath);
    await pruneEmptyParentDirectories(filePath, downloadDirectory);
    return "deleted";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }

    throw error;
  }
}

export async function moveDownloadedPathToKids(
  filePath: string,
  downloadDirectory: string,
): Promise<{
  outcome: MoveDownloadedToKidsOutcome;
  sourceRelativePath?: string;
  targetRelativePath?: string;
}> {
  if (!isPathInsideDirectory(filePath, downloadDirectory)) {
    throw new Error("Refusing to move a path outside the configured download directory.");
  }

  const paths = resolveMoveToKidsPaths(filePath, downloadDirectory);

  if (!paths) {
    return { outcome: "protected" };
  }

  const rootDirectory = path.resolve(downloadDirectory);
  const sourceAbsolutePath = path.join(rootDirectory, paths.sourceRelativePath);
  const targetAbsolutePath = path.join(rootDirectory, paths.targetRelativePath);

  try {
    await stat(sourceAbsolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { outcome: "missing", ...paths };
    }

    throw error;
  }

  try {
    await movePathToKids(sourceAbsolutePath, targetAbsolutePath);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Target already exists")) {
      return { outcome: "target-exists", ...paths };
    }

    throw error;
  }

  await pruneEmptyParentDirectories(sourceAbsolutePath, downloadDirectory);

  return { outcome: "moved", ...paths };
}

function createDeleteCallbackData(action: DeleteButtonAction, token: string): string {
  return `${CALLBACK_PREFIX}:${action}:${token}`;
}

function isDeleteButtonAction(value: string): value is DeleteButtonAction {
  return (
    value === "ask" ||
    value === "confirm" ||
    value === "cancel" ||
    value === "ask-move" ||
    value === "confirm-move"
  );
}

function formatRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
