import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isProtectedRoot } from "../download/download-paths.js";

export const KIDS_ROOT_NAME = "Kids";

/** Library folders that can be moved into Kids (not Kids itself). */
export const LIBRARY_SOURCE_ROOT_NAMES = new Set(["Movies", "TV Shows", "Undefined"]);

export function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath === ".") {
    return "";
  }

  const normalizedPath = path.normalize(relativePath);

  if (normalizedPath === ".") {
    return "";
  }

  return normalizedPath;
}

/** True for nested paths under Movies / TV Shows / Undefined (not protected roots, not Kids). */
export function canMoveRelativePathToKids(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);

  if (normalizedPath === "" || isProtectedRoot(normalizedPath)) {
    return false;
  }

  const topLevelName = normalizedPath.split(path.sep)[0] ?? "";

  return LIBRARY_SOURCE_ROOT_NAMES.has(topLevelName);
}

export function buildKidsTargetRelativePath(sourceRelativePath: string): string {
  const normalizedSource = normalizeRelativePath(sourceRelativePath);

  if (!canMoveRelativePathToKids(normalizedSource)) {
    throw new Error("This path cannot be moved to Kids.");
  }

  return path.join(KIDS_ROOT_NAME, normalizedSource);
}

/**
 * Move source to target. Never overwrites an existing target.
 * Uses rename; on EXDEV falls back to recursive copy + remove.
 */
export async function movePathToKids(sourceAbsolutePath: string, targetAbsolutePath: string): Promise<void> {
  const sourcePath = path.resolve(sourceAbsolutePath);
  const targetPath = path.resolve(targetAbsolutePath);

  if (sourcePath === targetPath) {
    throw new Error("Source and target paths are the same.");
  }

  let targetExists = true;

  try {
    await stat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      targetExists = false;
    } else {
      throw error;
    }
  }

  if (targetExists) {
    throw new Error("Target already exists. Refusing to overwrite.");
  }

  await mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EXDEV") {
      await cp(sourcePath, targetPath, { recursive: true });
      await rm(sourcePath, { recursive: true, force: true });
      return;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
