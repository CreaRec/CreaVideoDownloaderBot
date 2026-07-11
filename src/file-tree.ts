import { randomBytes } from "node:crypto";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { InlineKeyboardMarkup } from "telegraf/types";
import { isPathInsideDirectory, isProtectedRoot, pruneEmptyParentDirectories } from "./download-paths.js";

export { isPathInsideDirectory } from "./download-paths.js";

const CALLBACK_PREFIX = "file-tree";

export type FileTreeAction = "open" | "select" | "delete" | "confirm" | "cancel" | "refresh" | "fix";

export interface FileTreeCallback {
  action: FileTreeAction;
  token: string;
}

export interface FileTreeReplyMarkup {
  reply_markup: InlineKeyboardMarkup;
}

export interface FileTreeView {
  message: string;
  extra: FileTreeReplyMarkup;
}

interface TreeEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
}

interface TokenRecord {
  token: string;
  relativePath: string;
}

export class FileTreeBrowser {
  private readonly rootDirectory: string;
  private readonly tokenByPath = new Map<string, string>();
  private readonly recordsByToken = new Map<string, TokenRecord>();

  constructor(downloadDirectory: string) {
    this.rootDirectory = path.resolve(downloadDirectory);
    this.getOrCreateToken("");
  }

  parseCallbackData(data: string | undefined): FileTreeCallback | undefined {
    if (!data) {
      return undefined;
    }

    const [prefix, action, token] = data.split(":");

    if (prefix !== CALLBACK_PREFIX || !isFileTreeAction(action) || !token) {
      return undefined;
    }

    return { action, token };
  }

  reset(): void {
    this.tokenByPath.clear();
    this.recordsByToken.clear();
  }

  async renderRoot(): Promise<FileTreeView> {
    return this.renderDirectory("");
  }

  async renderDirectoryToken(token: string): Promise<FileTreeView> {
    const relativePath = this.getRelativePathForToken(token);

    return this.renderDirectory(relativePath);
  }

  async renderSelectedToken(token: string): Promise<FileTreeView> {
    const relativePath = this.getRelativePathForToken(token);
    const itemPath = this.resolvePath(relativePath);
    const itemStat = await stat(itemPath);
    const parentPath = getParentRelativePath(relativePath);
    const canFix = itemStat.isDirectory() && this.canFixMetadata(relativePath);
    const rows = [
      ...(itemStat.isDirectory()
        ? [[button("Open", createCallbackData("open", this.getOrCreateToken(relativePath)))]]
        : []),
      ...(canFix ? [[button("Fix metadata", createCallbackData("fix", this.getOrCreateToken(relativePath)))]] : []),
      ...(this.canDelete(relativePath)
        ? [[button("Delete", createCallbackData("delete", this.getOrCreateToken(relativePath)))]]
        : []),
      [
        button("Back", createCallbackData("open", this.getOrCreateToken(parentPath))),
        button("Refresh", createCallbackData("refresh", this.getOrCreateToken(relativePath))),
      ],
    ];

    return {
      message: [
        `Selected ${itemStat.isDirectory() ? "folder" : "file"}: ${formatRelativePath(relativePath)}`,
        `Size: ${itemStat.isDirectory() ? "folder" : formatBytes(itemStat.size)}`,
        this.canDelete(relativePath) || canFix
          ? "Choose an action."
          : "This item cannot be deleted from the bot.",
      ].join("\n"),
      extra: { reply_markup: { inline_keyboard: rows } },
    };
  }

  canFixMetadata(relativePath: string): boolean {
    return relativePath !== "" && !isProtectedRoot(relativePath);
  }

  resolveAbsolutePath(relativePath: string): string {
    return this.resolvePath(relativePath);
  }

  async renderDeleteConfirmationToken(token: string): Promise<FileTreeView> {
    const relativePath = this.getRelativePathForToken(token);
    const itemStat = await stat(this.resolvePath(relativePath));

    if (!this.canDelete(relativePath)) {
      return this.renderSelectedToken(token);
    }

    return {
      message: `Delete this ${itemStat.isDirectory() ? "folder and all of its contents" : "file"}?\n${formatRelativePath(relativePath)}`,
      extra: {
        reply_markup: {
          inline_keyboard: [
            [
              button("Confirm delete", createCallbackData("confirm", token)),
              button("Cancel", createCallbackData("cancel", token)),
            ],
          ],
        },
      },
    };
  }

  async deleteToken(token: string): Promise<"deleted" | "missing" | "protected"> {
    const relativePath = this.getRelativePathForToken(token);

    if (!this.canDelete(relativePath)) {
      return "protected";
    }

    const itemPath = this.resolvePath(relativePath);

    try {
      const itemStat = await stat(itemPath);

      if (itemStat.isDirectory()) {
        await rm(itemPath, { recursive: true });
      } else {
        await unlink(itemPath);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return "missing";
      }

      throw error;
    }

    this.forgetPath(relativePath);

    const removedParentPaths = await pruneEmptyParentDirectories(itemPath, this.rootDirectory);

    for (const removedParentPath of removedParentPaths) {
      this.forgetPath(removedParentPath);
    }

    return "deleted";
  }

  getParentToken(token: string): string {
    return this.getOrCreateToken(getParentRelativePath(this.getRelativePathForToken(token)));
  }

  getRelativePathForToken(token: string): string {
    const record = this.recordsByToken.get(token);

    if (!record) {
      throw new Error("File tree action is no longer available.");
    }

    return record.relativePath;
  }

  private async renderDirectory(relativePath: string): Promise<FileTreeView> {
    const directoryPath = this.resolvePath(relativePath);
    const entries = await this.readEntries(relativePath, directoryPath);
    const rows = entries.map((entry) => [
      button(
        `${entry.isDirectory ? "Folder" : "File"} ${entry.name}`,
        createCallbackData("select", this.getOrCreateToken(entry.relativePath)),
      ),
    ]);

    if (relativePath) {
      rows.push([
        button("Back", createCallbackData("open", this.getOrCreateToken(getParentRelativePath(relativePath)))),
        button("Refresh", createCallbackData("refresh", this.getOrCreateToken(relativePath))),
      ]);
    } else {
      rows.push([button("Refresh", createCallbackData("refresh", this.getOrCreateToken("")))]);
    }

    return {
      message: this.createDirectoryMessage(relativePath, entries),
      extra: { reply_markup: { inline_keyboard: rows } },
    };
  }

  private async readEntries(relativePath: string, directoryPath: string): Promise<TreeEntry[]> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    const entries = await Promise.all(
      directoryEntries
        .filter((entry) => !entry.name.startsWith("."))
        .map(async (entry) => {
          const entryRelativePath = joinRelativePath(relativePath, entry.name);
          const entryPath = this.resolvePath(entryRelativePath);
          const entryStat = await stat(entryPath);

          return {
            name: entry.name,
            relativePath: entryRelativePath,
            isDirectory: entryStat.isDirectory(),
            size: entryStat.isDirectory() ? undefined : entryStat.size,
          };
        }),
    );

    return entries.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }

  private createDirectoryMessage(relativePath: string, entries: TreeEntry[]): string {
    const lines = [`Files in ${formatRelativePath(relativePath)}`];

    if (entries.length === 0) {
      lines.push("(empty)");
      return lines.join("\n");
    }

    for (const entry of entries) {
      const suffix = entry.isDirectory ? "/" : ` (${formatBytes(entry.size ?? 0)})`;
      const protectedLabel = isProtectedRoot(entry.relativePath) ? " [protected]" : "";
      lines.push(`${entry.isDirectory ? "Folder" : "File"} ${entry.name}${suffix}${protectedLabel}`);
    }

    return lines.join("\n");
  }

  private canDelete(relativePath: string): boolean {
    return relativePath !== "" && !isProtectedRoot(relativePath);
  }

  private resolvePath(relativePath: string): string {
    const normalizedPath = normalizeRelativePath(relativePath);
    const resolvedPath = path.resolve(this.rootDirectory, normalizedPath);

    if (!isPathInsideDirectory(resolvedPath, this.rootDirectory)) {
      throw new Error("Refusing to access a path outside the configured download directory.");
    }

    return resolvedPath;
  }

  private getOrCreateToken(relativePath: string): string {
    const normalizedPath = normalizeRelativePath(relativePath);
    const existingToken = this.tokenByPath.get(normalizedPath);

    if (existingToken) {
      return existingToken;
    }

    let token = randomBytes(9).toString("base64url");

    while (this.recordsByToken.has(token)) {
      token = randomBytes(9).toString("base64url");
    }

    this.tokenByPath.set(normalizedPath, token);
    this.recordsByToken.set(token, { token, relativePath: normalizedPath });
    return token;
  }

  private forgetPath(relativePath: string): void {
    const normalizedPath = normalizeRelativePath(relativePath);
    const token = this.tokenByPath.get(normalizedPath);

    if (token) {
      this.tokenByPath.delete(normalizedPath);
      this.recordsByToken.delete(token);
    }
  }
}

function createCallbackData(action: FileTreeAction, token: string): string {
  return `${CALLBACK_PREFIX}:${action}:${token}`;
}

function button(text: string, callbackData: string): { text: string; callback_data: string } {
  return { text, callback_data: callbackData };
}

function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath === ".") {
    return "";
  }

  const normalizedPath = path.normalize(relativePath);

  if (normalizedPath === ".") {
    return "";
  }

  return normalizedPath;
}

function joinRelativePath(basePath: string, name: string): string {
  return basePath ? path.join(basePath, name) : name;
}

function getParentRelativePath(relativePath: string): string {
  if (!relativePath) {
    return "";
  }

  const parentPath = path.dirname(relativePath);

  return parentPath === "." ? "" : parentPath;
}

function formatRelativePath(relativePath: string): string {
  return relativePath ? relativePath.split(path.sep).join("/") : "/";
}

function isFileTreeAction(value: string): value is FileTreeAction {
  return (
    value === "open" ||
    value === "select" ||
    value === "delete" ||
    value === "confirm" ||
    value === "cancel" ||
    value === "refresh" ||
    value === "fix"
  );
}

function formatBytes(bytes: number): string {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
