import { readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export const PROTECTED_ROOT_NAMES = new Set(["Movies", "TV Shows", "Undefined"]);

export function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedDirectory = path.resolve(directory);
  const relativePath = path.relative(resolvedDirectory, resolvedFilePath);

  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isProtectedRoot(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);

  return !normalizedPath.includes(path.sep) && PROTECTED_ROOT_NAMES.has(normalizedPath);
}

/** Empty path (virtual root) or any path under a configured media root folder. */
export function isAllowedBrowsePath(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);

  if (normalizedPath === "") {
    return true;
  }

  const topLevelName = normalizedPath.split(path.sep)[0] ?? "";

  return PROTECTED_ROOT_NAMES.has(topLevelName);
}

export async function pruneEmptyParentDirectories(
  deletedPath: string,
  downloadDirectory: string,
): Promise<string[]> {
  const rootDirectory = path.resolve(downloadDirectory);
  const removedRelativePaths: string[] = [];
  let currentDir = path.dirname(path.resolve(deletedPath));

  while (isPathInsideDirectory(currentDir, rootDirectory) && currentDir !== rootDirectory) {
    const relativePath = path.relative(rootDirectory, currentDir);

    if (isProtectedRoot(relativePath)) {
      break;
    }

    let entries: string[];

    try {
      entries = await readdir(currentDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        break;
      }

      throw error;
    }

    const visibleEntries = entries.filter((entry) => !entry.startsWith("."));

    if (visibleEntries.length > 0) {
      break;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) {
        await unlink(path.join(currentDir, entry));
      }
    }

    await rmdir(currentDir);
    removedRelativePaths.push(relativePath);
    currentDir = path.dirname(currentDir);
  }

  return removedRelativePaths;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
