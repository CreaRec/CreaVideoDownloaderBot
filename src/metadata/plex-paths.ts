import path from "node:path";

export const PLEX_MOVIES_DIR = "Movies";
export const PLEX_TV_SHOWS_DIR = "TV Shows";
export const PLEX_UNDEFINED_DIR = "Undefined";

export interface PlexIds {
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

export interface PlexMoviePathInput {
  rootDirectory: string;
  title: string;
  year?: number;
  extension: string;
  plexIds?: PlexIds;
}

export interface PlexTvShowPathInput {
  rootDirectory: string;
  title: string;
  year?: number;
  season: number;
  episode: number;
  episodeTitle?: string;
  extension: string;
  plexIds?: PlexIds;
}

export function sanitizePlexName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "Unknown";
  }

  return cleaned;
}

export function sanitizeLegacyFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `telegram-video-${Date.now()}.bin`;
  }

  return cleaned;
}

export function formatPlexTitle(title: string, year?: number): string {
  const safeTitle = sanitizePlexName(title);

  if (year) {
    return `${safeTitle} (${year})`;
  }

  return safeTitle;
}

export function formatSeasonDir(season: number): string {
  return `Season ${String(season).padStart(2, "0")}`;
}

export function formatEpisodeTag(season: number, episode: number): string {
  return `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`;
}

export function formatPlexIdTags(plexIds: PlexIds | undefined, kind: "film" | "tv_show"): string {
  if (!plexIds) {
    return "";
  }

  const tags: string[] = [];

  if (kind === "film") {
    if (plexIds.imdb) {
      tags.push(`{imdb-${plexIds.imdb}}`);
    } else if (plexIds.tmdb) {
      tags.push(`{tmdb-${plexIds.tmdb}}`);
    }
  } else if (plexIds.tvdb) {
    tags.push(`{tvdb-${plexIds.tvdb}}`);
  } else if (plexIds.tmdb) {
    tags.push(`{tmdb-${plexIds.tmdb}}`);
  }

  return tags.length > 0 ? ` ${tags.join(" ")}` : "";
}

const PLEX_ID_TAG_PATTERN = /\{(imdb|tmdb|tvdb)-([^}]+)\}/gi;

export function parsePlexIdTags(name: string): PlexIds {
  const plexIds: PlexIds = {};

  for (const match of name.matchAll(PLEX_ID_TAG_PATTERN)) {
    const provider = match[1]?.toLowerCase();
    const rawValue = match[2]?.trim();

    if (!provider || !rawValue) {
      continue;
    }

    if (provider === "imdb") {
      plexIds.imdb = normalizeImdbId(rawValue);
      continue;
    }

    const numericId = Number(rawValue);

    if (!Number.isInteger(numericId) || numericId <= 0) {
      continue;
    }

    if (provider === "tmdb") {
      plexIds.tmdb = numericId;
    } else if (provider === "tvdb") {
      plexIds.tvdb = numericId;
    }
  }

  return plexIds;
}

export function normalizeImdbId(imdbId: string): string {
  const trimmed = imdbId.trim().toLowerCase();

  if (trimmed.startsWith("tt")) {
    return trimmed;
  }

  return `tt${trimmed}`;
}

export function plexIdsOverlap(left: PlexIds | undefined, right: PlexIds | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  if (left.imdb && right.imdb && normalizeImdbId(left.imdb) === normalizeImdbId(right.imdb)) {
    return true;
  }

  if (left.tmdb !== undefined && right.tmdb !== undefined && left.tmdb === right.tmdb) {
    return true;
  }

  if (left.tvdb !== undefined && right.tvdb !== undefined && left.tvdb === right.tvdb) {
    return true;
  }

  return false;
}

export function buildMoviePath(input: PlexMoviePathInput): string {
  const displayTitle = formatPlexTitle(input.title, input.year);
  const idTags = formatPlexIdTags(input.plexIds, "film");
  const folderName = sanitizePlexName(`${displayTitle}${idTags}`);
  const fileName = sanitizePlexName(`${displayTitle}${idTags}${input.extension}`);

  return path.join(input.rootDirectory, PLEX_MOVIES_DIR, folderName, fileName);
}

export function buildTvShowPath(input: PlexTvShowPathInput): string {
  const displayTitle = formatPlexTitle(input.title, input.year);
  const idTags = formatPlexIdTags(input.plexIds, "tv_show");
  const showFolder = sanitizePlexName(`${displayTitle}${idTags}`);
  const episodeTag = formatEpisodeTag(input.season, input.episode);
  const episodeTitlePart = input.episodeTitle ? ` - ${sanitizePlexName(input.episodeTitle)}` : "";
  const fileName = sanitizePlexName(`${displayTitle} - ${episodeTag}${episodeTitlePart}${input.extension}`);

  return path.join(
    input.rootDirectory,
    PLEX_TV_SHOWS_DIR,
    showFolder,
    formatSeasonDir(input.season),
    fileName,
  );
}

export function buildUndefinedPath(rootDirectory: string, fallbackFileName: string): string {
  return path.join(rootDirectory, PLEX_UNDEFINED_DIR, fallbackFileName);
}
