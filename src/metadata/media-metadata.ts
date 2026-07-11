import type { Logger } from "../config/logger.js";
import type { MediaClassificationInput } from "./media-classifier.js";
import { MediaClassifier } from "./media-classifier.js";
import type { Settings } from "../config/settings.js";
import { buildMoviePath, buildTvShowPath, buildUndefinedPath, sanitizeLegacyFileName, type PlexIds } from "./plex-paths.js";
import { TmdbResolver } from "./tmdb-resolver.js";

export interface PlexMetadata {
  kind: "film" | "tv_show" | "undefined";
  title?: string;
  displayTitle?: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  plexIds?: PlexIds;
  reason?: string;
}

export interface MetadataResolveInput extends MediaClassificationInput {}

export class MediaMetadataService {
  private readonly tmdbResolver: TmdbResolver;

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly mediaClassifier: MediaClassifier = new MediaClassifier(settings, logger),
    tmdbResolver?: TmdbResolver,
  ) {
    this.tmdbResolver = tmdbResolver ?? new TmdbResolver(settings, logger);
  }

  async resolveMetadata(input: MetadataResolveInput): Promise<PlexMetadata> {
    const classification = await this.mediaClassifier.classify(input);

    if (classification.kind === "undefined") {
      return { kind: "undefined", reason: classification.reason };
    }

    const tmdbMatch = await this.tmdbResolver.resolve({
      kind: classification.kind,
      title: classification.title,
      year: classification.year,
      season: classification.kind === "tv_show" ? classification.season : undefined,
      episode: classification.kind === "tv_show" ? classification.episode : undefined,
      episodeTitle: classification.kind === "tv_show" ? classification.episodeTitle : undefined,
    });

    if (classification.kind === "film") {
      const title = tmdbMatch?.kind === "film" ? tmdbMatch.title : classification.title;
      const year = tmdbMatch?.kind === "film" ? tmdbMatch.year ?? classification.year : classification.year;

      return {
        kind: "film",
        title,
        displayTitle: formatDisplayTitle(title, year),
        year,
        plexIds: tmdbMatch?.kind === "film" ? tmdbMatch.plexIds : undefined,
      };
    }

    const title = tmdbMatch?.kind === "tv_show" ? tmdbMatch.title : classification.title;
    const year = tmdbMatch?.kind === "tv_show" ? tmdbMatch.year ?? classification.year : classification.year;

    return {
      kind: "tv_show",
      title,
      displayTitle: formatDisplayTitle(title, year),
      year,
      season: classification.season,
      episode: classification.episode,
      episodeTitle: tmdbMatch?.kind === "tv_show" ? tmdbMatch.episodeTitle ?? classification.episodeTitle : classification.episodeTitle,
      plexIds: tmdbMatch?.kind === "tv_show" ? tmdbMatch.plexIds : undefined,
    };
  }

  buildOutputPath(metadata: PlexMetadata, rootDirectory: string, fallbackFileName: string, extension: string): string {
    if (metadata.kind === "film" && metadata.title) {
      return buildMoviePath({
        rootDirectory,
        title: metadata.title,
        year: metadata.year,
        extension,
        plexIds: metadata.plexIds,
      });
    }

    if (metadata.kind === "tv_show" && metadata.title && metadata.season && metadata.episode) {
      return buildTvShowPath({
        rootDirectory,
        title: metadata.title,
        year: metadata.year,
        season: metadata.season,
        episode: metadata.episode,
        episodeTitle: metadata.episodeTitle,
        extension,
        plexIds: metadata.plexIds,
      });
    }

    return buildUndefinedPath(rootDirectory, fallbackFileName);
  }
}

export function formatDisplayTitle(title: string, year?: number): string {
  return year ? `${title} (${year})` : title;
}

export function buildLegacyFallbackFileName(fileName: string): string {
  return sanitizeLegacyFileName(fileName);
}
