import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PlexMetadata } from "./media-metadata.js";
import {
  formatEpisodeTag,
  formatSeasonDir,
  parsePlexIdTags,
  plexIdsOverlap,
  PLEX_MOVIES_DIR,
  PLEX_TV_SHOWS_DIR,
  type PlexIds,
} from "./plex-paths.js";

const MEDIA_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ts",
  ".webm",
  ".wmv",
]);

export async function findDuplicateMedia(
  rootDirectory: string,
  metadata: PlexMetadata,
): Promise<string | undefined> {
  if (!metadata.plexIds || !hasLookupIds(metadata.plexIds)) {
    return undefined;
  }

  if (metadata.kind === "film") {
    return findDuplicateMovie(rootDirectory, metadata.plexIds);
  }

  if (
    metadata.kind === "tv_show" &&
    metadata.season !== undefined &&
    metadata.episode !== undefined
  ) {
    return findDuplicateTvEpisode(rootDirectory, metadata.plexIds, metadata.season, metadata.episode);
  }

  return undefined;
}

async function findDuplicateMovie(rootDirectory: string, plexIds: PlexIds): Promise<string | undefined> {
  const moviesDirectory = path.join(rootDirectory, PLEX_MOVIES_DIR);
  const movieFolders = await listDirectoryNames(moviesDirectory);

  for (const folderName of movieFolders) {
    if (!plexIdsOverlap(plexIds, parsePlexIdTags(folderName))) {
      continue;
    }

    const mediaPath = await findFirstMediaFile(path.join(moviesDirectory, folderName));

    if (mediaPath) {
      return mediaPath;
    }
  }

  return undefined;
}

async function findDuplicateTvEpisode(
  rootDirectory: string,
  plexIds: PlexIds,
  season: number,
  episode: number,
): Promise<string | undefined> {
  const tvShowsDirectory = path.join(rootDirectory, PLEX_TV_SHOWS_DIR);
  const showFolders = await listDirectoryNames(tvShowsDirectory);
  const episodeTag = formatEpisodeTag(season, episode).toLowerCase();
  const seasonDirName = formatSeasonDir(season);

  for (const folderName of showFolders) {
    if (!plexIdsOverlap(plexIds, parsePlexIdTags(folderName))) {
      continue;
    }

    const seasonDirectory = path.join(tvShowsDirectory, folderName, seasonDirName);
    const episodeFiles = await listDirectoryNames(seasonDirectory);

    for (const fileName of episodeFiles) {
      if (!isMediaFileName(fileName)) {
        continue;
      }

      if (fileName.toLowerCase().includes(episodeTag)) {
        return path.join(seasonDirectory, fileName);
      }
    }
  }

  return undefined;
}

function hasLookupIds(plexIds: PlexIds): boolean {
  return Boolean(plexIds.imdb || plexIds.tmdb !== undefined || plexIds.tvdb !== undefined);
}

async function listDirectoryNames(directoryPath: string): Promise<string[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.filter((entry) => !entry.name.startsWith(".")).map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function findFirstMediaFile(directoryPath: string): Promise<string | undefined> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const fileNames = entries
      .filter((entry) => entry.isFile() && isMediaFileName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    if (fileNames[0]) {
      return path.join(directoryPath, fileNames[0]);
    }

    return undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function isMediaFileName(fileName: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
