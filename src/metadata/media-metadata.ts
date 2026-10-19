import path from "node:path";
import type { Logger } from "../config/logger.js";
import type { MediaClassificationInput } from "./media-classifier.js";
import { MediaClassifier } from "./media-classifier.js";
import type { Settings } from "../config/settings.js";
import {
  buildMoviePath,
  buildTvShowPath,
  buildUnrecognizedMoviePath,
  sanitizeLegacyFileName,
  type PlexIds,
} from "./plex-paths.js";
import { applyTmdbFallbackWhenNeeded } from "./tmdb-fallback.js";
import { TmdbResolver } from "./tmdb-resolver.js";
import { normalizeMediaTitle } from "./title-normalize.js";
import {
  findDeterministicLibraryMatches,
  findLibraryShowById,
  toLibraryShowSummaries,
  TvLibraryCatalog,
  type LibraryTvShow,
  type ShowLibraryResolution,
} from "./tv-library-catalog.js";

export interface PlexMetadata {
  kind: "film" | "tv_show" | "unrecognized";
  title?: string;
  displayTitle?: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  plexIds?: PlexIds;
  reason?: string;
  displayName?: string;
  classificationReason?: string;
}

export interface MetadataResolveInput extends MediaClassificationInput {}

export interface MetadataResolveContext {
  getCachedTvShowChoice?: (normalizedTitle: string) => ShowLibraryResolution | undefined;
  rememberTvShowChoice?: (normalizedTitle: string, choice: ShowLibraryResolution) => void;
  resolveAmbiguousTvShow?: (input: {
    classifiedTitle: string;
    candidates: LibraryTvShow[];
  }) => Promise<ShowLibraryResolution>;
}

export class MediaMetadataService {
  private readonly tmdbResolver: TmdbResolver;
  private readonly tvLibraryCatalog: TvLibraryCatalog;

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly mediaClassifier: MediaClassifier = new MediaClassifier(settings, logger),
    tmdbResolver?: TmdbResolver,
    tvLibraryCatalog?: TvLibraryCatalog,
  ) {
    this.tmdbResolver = tmdbResolver ?? new TmdbResolver(settings, logger);
    this.tvLibraryCatalog = tvLibraryCatalog ?? new TvLibraryCatalog(settings, logger);
  }

  getTvLibraryCatalog(): TvLibraryCatalog {
    return this.tvLibraryCatalog;
  }

  async resolveMetadata(input: MetadataResolveInput, context: MetadataResolveContext = {}): Promise<PlexMetadata> {
    const libraryShows = await this.tvLibraryCatalog.listShows();
    const existingShows = toLibraryShowSummaries(libraryShows);

    const classification = await this.mediaClassifier.classify({
      ...input,
      existingShows,
    });

    if (classification.kind === "undefined") {
      const fallback = await applyTmdbFallbackWhenNeeded(classification, input, this.tmdbResolver);

      if (fallback.metadata.kind !== "unrecognized") {
        if (fallback.metadata.kind === "tv_show") {
          const libraryMatch = await this.resolveTvShowLibraryMatch(
            {
              title: fallback.metadata.title!,
              year: fallback.metadata.year,
              season: fallback.metadata.season!,
              episode: fallback.metadata.episode!,
              episodeTitle: fallback.metadata.episodeTitle,
            },
            libraryShows,
            context,
          );

          if (libraryMatch) {
            return { ...libraryMatch, classificationReason: fallback.metadata.classificationReason };
          }
        }

        return fallback.metadata;
      }

      return fallback.metadata;
    }

    if (classification.kind === "film") {
      const film = await this.resolveFilmMetadata(classification);
      return { ...film, classificationReason: "classified" };
    }

    const libraryMatch = await this.resolveTvShowLibraryMatch(classification, libraryShows, context);

    if (libraryMatch) {
      return libraryMatch;
    }

    const tmdbMatch = await this.tmdbResolver.resolve({
      kind: "tv_show",
      title: classification.title,
      year: classification.year,
      season: classification.season,
      episode: classification.episode,
      episodeTitle: classification.episodeTitle,
    });

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
      classificationReason: "classified",
    };
  }

  private async resolveFilmMetadata(classification: {
    kind: "film";
    title: string;
    year?: number;
  }): Promise<PlexMetadata> {
    const tmdbMatch = await this.tmdbResolver.resolve({
      kind: "film",
      title: classification.title,
      year: classification.year,
    });

    const title = tmdbMatch?.kind === "film" ? tmdbMatch.title : classification.title;
    const year = tmdbMatch?.kind === "film" ? tmdbMatch.year ?? classification.year : classification.year;

    return {
      kind: "film",
      title,
      displayTitle: formatDisplayTitle(title, year),
      year,
      plexIds: tmdbMatch?.kind === "film" ? tmdbMatch.plexIds : undefined,
      classificationReason: "classified",
    };
  }

  private async resolveTvShowLibraryMatch(
    classification: {
      title: string;
      year?: number;
      season: number;
      episode: number;
      episodeTitle?: string;
      libraryShowId?: string;
    },
    libraryShows: LibraryTvShow[],
    context: MetadataResolveContext,
  ): Promise<PlexMetadata | undefined> {
    const normalizedTitle = normalizeMediaTitle(classification.title);
    const deterministicMatches = findDeterministicLibraryMatches(classification.title, libraryShows);

    let resolution: ShowLibraryResolution | undefined;

    if (deterministicMatches.length === 1) {
      resolution = { source: "library", showId: deterministicMatches[0].id };
      this.logger.info("[classify] matched existing TV library folder", {
        component: "classify",
        handler: "download",
        step: "library_match",
        result: "deterministic",
        match_count: 1,
      });
    } else if (deterministicMatches.length > 1) {
      resolution = await this.resolveAmbiguousTvShow(classification.title, deterministicMatches, normalizedTitle, context);
    } else if (classification.libraryShowId) {
      const llmMatch = findLibraryShowById(libraryShows, classification.libraryShowId);

      if (llmMatch) {
        resolution = { source: "library", showId: llmMatch.id };
        this.logger.info("[classify] matched existing TV library folder", {
          component: "classify",
          handler: "download",
          step: "library_match",
          result: "llm",
          match_count: 1,
        });
      }
    }

    if (!resolution || resolution.source === "tmdb") {
      return undefined;
    }

    const show = findLibraryShowById(libraryShows, resolution.showId);

    if (!show) {
      return undefined;
    }

    context.rememberTvShowChoice?.(normalizedTitle, resolution);

    let episodeTitle = classification.episodeTitle;

    if (show.plexIds.tmdb !== undefined) {
      episodeTitle =
        (await this.tmdbResolver.getEpisodeTitle(show.plexIds.tmdb, classification.season, classification.episode)) ??
        episodeTitle;
    }

    const year = show.year ?? classification.year;

    return {
      kind: "tv_show",
      title: show.title,
      displayTitle: formatDisplayTitle(show.title, year),
      year,
      season: classification.season,
      episode: classification.episode,
      episodeTitle,
      plexIds: show.plexIds,
      classificationReason: "classified",
    };
  }

  private async resolveAmbiguousTvShow(
    classifiedTitle: string,
    candidates: LibraryTvShow[],
    normalizedTitle: string,
    context: MetadataResolveContext,
  ): Promise<ShowLibraryResolution> {
    const cached = context.getCachedTvShowChoice?.(normalizedTitle);

    if (cached) {
      this.logger.info("[classify] reused cached TV library choice", {
        component: "classify",
        handler: "download",
        step: "library_match",
        result: cached.source,
      });
      return cached;
    }

    if (!context.resolveAmbiguousTvShow) {
      this.logger.warn("[classify] ambiguous TV library match without resolver; using TMDB", {
        component: "classify",
        handler: "download",
        step: "library_match",
        result: "ambiguous",
        match_count: candidates.length,
      });
      return { source: "tmdb" };
    }

    const choice = await context.resolveAmbiguousTvShow({
      classifiedTitle,
      candidates,
    });

    context.rememberTvShowChoice?.(normalizedTitle, choice);

    this.logger.info("[classify] resolved ambiguous TV library match", {
      component: "classify",
      handler: "download",
      step: "library_match",
      result: choice.source,
      match_count: candidates.length,
    });

    return choice;
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

    if (metadata.kind === "unrecognized" && metadata.displayName) {
      return buildUnrecognizedMoviePath(rootDirectory, metadata.displayName, path.basename(fallbackFileName));
    }

    return buildUnrecognizedMoviePath(rootDirectory, metadata.displayName ?? "Unknown", path.basename(fallbackFileName));
  }
}

export function formatDisplayTitle(title: string, year?: number): string {
  return year ? `${title} (${year})` : title;
}

export function buildLegacyFallbackFileName(fileName: string): string {
  return sanitizeLegacyFileName(fileName);
}
