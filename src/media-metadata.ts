import type { Logger } from "./logger.js";
import type { MediaClassificationInput } from "./media-classifier.js";
import { MediaClassifier } from "./media-classifier.js";
import path from "node:path";
import type { Settings } from "./settings.js";
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

  async resolveShowIdentity(input: MetadataResolveInput): Promise<{ title: string; year?: number } | undefined> {
    const classification = await this.mediaClassifier.classify(input);

    if (classification.kind === "film" || classification.kind === "tv_show") {
      return {
        title: classification.title,
        year: classification.year,
      };
    }

    return undefined;
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

export function buildMetadataHintsFromLegacyPath(relativePath: string): MetadataResolveInput {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  if (parts[0] === "Film" && parts.length >= 2) {
    const fileName = parts[parts.length - 1];
    return { fileName, description: humanizeLegacyName(pathBaseName(fileName)) };
  }

  if (parts[0] === "TVShow" && parts.length >= 4) {
    const showName = humanizeLegacyName(parts[1]);
    const seasonMatch = parts[2].match(/^Season_(\d+)$/i);
    const episodeFile = pathBaseName(parts[3]);
    const episodeMatch = episodeFile.match(/^(\d+)/);

    const description = [
      showName,
      seasonMatch ? `Season ${seasonMatch[1]}` : undefined,
      episodeMatch ? `Episode ${episodeMatch[1]}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");

    return { fileName: parts[3], description };
  }

  if (parts[0] === "Undefined" && parts.length >= 2) {
    return { fileName: parts[parts.length - 1] };
  }

  return { fileName: parts[parts.length - 1] };
}

function humanizeLegacyName(value: string): string {
  return value.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function pathBaseName(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));

  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

export function buildMetadataFromLegacyPath(relativePath: string): PlexMetadata {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  if (parts[0] === "Film" && parts.length >= 2) {
    const fileName = parts[parts.length - 1];
    const baseName = pathBaseName(fileName).replace(path.extname(fileName), "");
    const title = humanizeLegacyName(baseName);
    const year = extractYearFromText(baseName);

    return {
      kind: "film",
      title,
      displayTitle: formatDisplayTitle(title, year),
      year,
    };
  }

  if (parts[0] === "TVShow" && parts.length >= 4) {
    const showName = humanizeLegacyName(parts[1]);
    const seasonMatch = parts[2].match(/^Season_(\d+)$/i);
    const episodeFile = pathBaseName(parts[3]);
    const episodeMatch = episodeFile.match(/^(\d+)/);
    const season = seasonMatch ? Number.parseInt(seasonMatch[1], 10) : undefined;
    const episode = episodeMatch ? Number.parseInt(episodeMatch[1], 10) : undefined;
    const year = extractYearFromText(showName);

    if (season && episode) {
      return {
        kind: "tv_show",
        title: showName,
        displayTitle: formatDisplayTitle(showName, year),
        year,
        season,
        episode,
      };
    }
  }

  return { kind: "undefined", reason: "Legacy path did not contain enough metadata." };
}

function extractYearFromText(value: string): number | undefined {
  const match = value.match(/\b(19|20)\d{2}\b/);

  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[0], 10);
}

export function buildLegacyFallbackFileName(fileName: string): string {
  return sanitizeLegacyFileName(fileName);
}
