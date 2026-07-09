import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";
import { MediaClassifier } from "./media-classifier.js";
import {
  buildMetadataFromLegacyPath,
  formatDisplayTitle,
  MediaMetadataService,
  type PlexMetadata,
} from "./media-metadata.js";
import type { Settings } from "./settings.js";
import { TmdbResolver } from "./tmdb-resolver.js";

export const MIGRATION_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".m4v",
  ".mov",
  ".webm",
  ".ts",
  ".wmv",
  ".mpg",
  ".mpeg",
]);

export interface LegacyTvPathInfo {
  showKey: string;
  showName: string;
  season: number;
  episode: number;
}

export interface LegacyFilmPathInfo {
  cacheKey: string;
  fileName: string;
  titleHint: string;
}

export function isMigrationVideoFile(filePath: string): boolean {
  const baseName = path.basename(filePath);

  if (!baseName || baseName.startsWith(".")) {
    return false;
  }

  return MIGRATION_VIDEO_EXTENSIONS.has(path.extname(baseName).toLowerCase());
}

export function parseLegacyTvPath(relativePath: string): LegacyTvPathInfo | undefined {
  const parts = normalizeRelativePath(relativePath);

  if (parts[0] !== "TVShow" || parts.length < 4) {
    return undefined;
  }

  const seasonMatch = parts[2].match(/^Season_(\d+)$/i);
  const episodeMatch = path.basename(parts[3]).match(/^(\d+)/);
  const season = seasonMatch ? Number.parseInt(seasonMatch[1], 10) : undefined;
  const episode = episodeMatch ? Number.parseInt(episodeMatch[1], 10) : undefined;

  if (!season || !episode) {
    return undefined;
  }

  return {
    showKey: `${parts[0]}/${parts[1]}`,
    showName: humanizeLegacyName(parts[1]),
    season,
    episode,
  };
}

export function parseLegacyFilmPath(relativePath: string): LegacyFilmPathInfo | undefined {
  const parts = normalizeRelativePath(relativePath);

  if (parts[0] !== "Film" || parts.length < 2) {
    return undefined;
  }

  const fileName = parts[parts.length - 1];
  const titleHint = humanizeLegacyName(fileName.replace(path.extname(fileName), ""));

  return {
    cacheKey: `${parts[0]}/${fileName}`,
    fileName,
    titleHint,
  };
}

export function buildFilmMigrationHints(film: LegacyFilmPathInfo) {
  return {
    fileName: film.fileName,
    description: [
      `Legacy movie file titled "${film.titleHint}".`,
      "Determine the correct Plex movie title and theatrical release year.",
      "Prefer the most common international release matching a Russian download title.",
    ].join(" "),
  };
}

export function buildTvShowMigrationHints(showName: string) {
  return {
    fileName: "series.mkv",
    description: [
      `Television series stored in folder "${showName}".`,
      "Identify the correct show title and first-air year only.",
      "This is a Russian or international TV series library entry.",
    ].join(" "),
  };
}

interface CachedTvShow {
  title: string;
  year?: number;
  plexIds?: PlexMetadata["plexIds"];
}

const migrationProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getMigrationInstructionsPath(): string {
  return path.resolve(migrationProjectRoot, "config", "media-migration-instructions.md");
}

export function createMigrationMetadataService(settings: Settings, logger: Logger) {
  const tmdbResolver = new TmdbResolver(settings, logger);
  const metadataService = new MediaMetadataService(
    settings,
    logger,
    new MediaClassifier(settings, logger, getMigrationInstructionsPath()),
    tmdbResolver,
  );
  const migrationResolver = new LegacyMigrationResolver(metadataService, tmdbResolver, logger);

  return { metadataService, migrationResolver };
}

export class LegacyMigrationResolver {
  private readonly filmCache = new Map<string, PlexMetadata>();
  private readonly tvShowCache = new Map<string, CachedTvShow>();

  constructor(
    private readonly metadataService: MediaMetadataService,
    private readonly tmdbResolver: TmdbResolver,
    private readonly logger: Logger,
  ) {}

  async resolve(relativePath: string, noEnrich: boolean): Promise<PlexMetadata> {
    if (noEnrich) {
      return buildMetadataFromLegacyPath(relativePath);
    }

    const tvPath = parseLegacyTvPath(relativePath);
    if (tvPath) {
      return this.resolveTvEpisode(tvPath);
    }

    const filmPath = parseLegacyFilmPath(relativePath);
    if (filmPath) {
      return this.resolveFilm(filmPath);
    }

    return buildMetadataFromLegacyPath(relativePath);
  }

  private async resolveFilm(film: LegacyFilmPathInfo): Promise<PlexMetadata> {
    const cached = this.filmCache.get(film.cacheKey);

    if (cached) {
      return cached;
    }

    const metadata = await this.metadataService.resolveMetadata(buildFilmMigrationHints(film));
    const resolved = metadata.kind === "film" ? metadata : buildMetadataFromLegacyPath(`Film/${film.fileName}`);
    this.filmCache.set(film.cacheKey, resolved);
    return resolved;
  }

  private async resolveTvEpisode(tvPath: LegacyTvPathInfo): Promise<PlexMetadata> {
    const series = await this.getTvShow(tvPath.showKey, tvPath.showName);
    const episodeTitle = series.plexIds?.tmdb
      ? await this.tmdbResolver.getEpisodeTitle(series.plexIds.tmdb, tvPath.season, tvPath.episode)
      : undefined;

    return {
      kind: "tv_show",
      title: series.title,
      displayTitle: formatDisplayTitle(series.title, series.year),
      year: series.year,
      season: tvPath.season,
      episode: tvPath.episode,
      episodeTitle,
      plexIds: series.plexIds,
    };
  }

  private async getTvShow(showKey: string, showName: string): Promise<CachedTvShow> {
    const cached = this.tvShowCache.get(showKey);

    if (cached) {
      return cached;
    }

    const identity = await this.metadataService.resolveShowIdentity(buildTvShowMigrationHints(showName));
    const tmdbSeries = await this.tmdbResolver.resolveTvSeries({
      title: identity?.title ?? showName,
      year: identity?.year,
      originalTitle: showName,
    });

    const resolved: CachedTvShow = tmdbSeries
      ? {
          title: tmdbSeries.title,
          year: tmdbSeries.year,
          plexIds: tmdbSeries.plexIds,
        }
      : {
          title: identity?.title ?? showName,
          year: identity?.year,
          plexIds: undefined,
        };

    this.logger.info(`Resolved legacy TV show ${showKey} as ${formatDisplayTitle(resolved.title, resolved.year)}`, resolved);
    this.tvShowCache.set(showKey, resolved);
    return resolved;
  }
}

function normalizeRelativePath(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function humanizeLegacyName(value: string): string {
  return value.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}
