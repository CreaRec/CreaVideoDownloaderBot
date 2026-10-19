import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../config/logger.js";
import type { Settings } from "../config/settings.js";
import { parsePlexIdTags, PLEX_TV_SHOWS_DIR, type PlexIds } from "./plex-paths.js";
import { normalizeMediaTitle, parseTitleAndYearFromFolderDisplayName } from "./title-normalize.js";

const DEFAULT_CACHE_TTL_MS = 60_000;

export interface LibraryTvShow {
  folderName: string;
  title: string;
  year?: number;
  plexIds: PlexIds;
  /** Stable id for LLM prompts and inline buttons (e.g. tvdb-75760, tmdb-85267). */
  id: string;
}

export interface LibraryTvShowSummary {
  id: string;
  title: string;
  year?: number;
}

export type ShowLibraryResolution = { source: "library"; showId: string } | { source: "tmdb" };

export function buildLibraryShowId(folderName: string, plexIds: PlexIds, title: string, year?: number): string {
  if (plexIds.tvdb !== undefined) {
    return `tvdb-${plexIds.tvdb}`;
  }

  if (plexIds.tmdb !== undefined) {
    return `tmdb-${plexIds.tmdb}`;
  }

  const normalized = normalizeMediaTitle(title);
  return year ? `folder-${normalized}-${year}` : `folder-${normalized}`;
}

export function parseTvShowFolderName(folderName: string): LibraryTvShow | undefined {
  const plexIds = parsePlexIdTags(folderName);
  const { title, year } = parseTitleAndYearFromFolderDisplayName(folderName);

  if (!title) {
    return undefined;
  }

  return {
    folderName,
    title,
    year,
    plexIds,
    id: buildLibraryShowId(folderName, plexIds, title, year),
  };
}

export function findDeterministicLibraryMatches(showTitle: string, library: LibraryTvShow[]): LibraryTvShow[] {
  const normalizedNeedle = normalizeMediaTitle(showTitle);

  if (!normalizedNeedle) {
    return [];
  }

  return library.filter((show) => {
    const normalizedHaystack = normalizeMediaTitle(show.title);
    return normalizedHaystack === normalizedNeedle;
  });
}

export function findLibraryShowById(library: LibraryTvShow[], showId: string): LibraryTvShow | undefined {
  const trimmed = showId.trim();
  return library.find((show) => show.id === trimmed);
}

export function toLibraryShowSummaries(library: LibraryTvShow[]): LibraryTvShowSummary[] {
  return library.map((show) => ({
    id: show.id,
    title: show.title,
    year: show.year,
  }));
}

export class TvLibraryCatalog {
  private cachedShows: LibraryTvShow[] | undefined;
  private cachedAt = 0;
  private loadPromise: Promise<LibraryTvShow[]> | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  invalidate(): void {
    this.cachedShows = undefined;
    this.cachedAt = 0;
    this.loadPromise = undefined;
  }

  async listShows(forceRefresh = false): Promise<LibraryTvShow[]> {
    if (!forceRefresh && this.cachedShows && Date.now() - this.cachedAt < this.cacheTtlMs) {
      return this.cachedShows;
    }

    if (!forceRefresh && this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this.loadShowsFromDisk();

    try {
      const shows = await this.loadPromise;
      this.cachedShows = shows;
      this.cachedAt = Date.now();
      return shows;
    } finally {
      this.loadPromise = undefined;
    }
  }

  private async loadShowsFromDisk(): Promise<LibraryTvShow[]> {
    const tvShowsDirectory = path.join(this.settings.download.directory, PLEX_TV_SHOWS_DIR);
    const started = Date.now();

    try {
      const entries = await readdir(tvShowsDirectory, { withFileTypes: true });
      const shows: LibraryTvShow[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }

        const parsed = parseTvShowFolderName(entry.name);

        if (parsed) {
          shows.push(parsed);
        }
      }

      this.logger.debug("[tv-library] listed show folders", {
        component: "tv_library",
        step: "list",
        show_count: shows.length,
        duration_ms: Date.now() - started,
      });

      return shows.sort((left, right) => left.title.localeCompare(right.title, "ru"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      this.logger.exception("[tv-library] failed to list show folders", error, {
        component: "tv_library",
        step: "list",
        error_type: "filesystem",
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
