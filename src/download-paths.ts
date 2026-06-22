import { readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export const PROTECTED_ROOT_NAMES = new Set(["Film", "TVShow", "Undefined"]);

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

    const entries = await readdir(currentDir);
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
