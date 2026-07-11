import { access, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInsideDirectory, pruneEmptyParentDirectories } from "../download/download-paths.js";
import type { Logger } from "../config/logger.js";
import type { MediaClassifier } from "./media-classifier.js";
import { buildMoviePath, buildTvShowPath, type PlexIds } from "./plex-paths.js";
import type { Settings } from "../config/settings.js";
import type { TmdbResolvedTitle, TmdbResolver } from "./tmdb-resolver.js";

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".m4v",
  ".wmv",
  ".webm",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
]);

export interface MetadataFixRenameResult {
  renamed: Array<{ from: string; to: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

export class MetadataFixRenamer {
  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly tmdbResolver: TmdbResolver,
    private readonly mediaClassifier?: MediaClassifier,
  ) {}

  async renameFolder(folderPath: string, resolved: TmdbResolvedTitle): Promise<MetadataFixRenameResult> {
    const rootDirectory = path.resolve(this.settings.download.directory);
    const resolvedFolder = path.resolve(folderPath);

    if (!isPathInsideDirectory(resolvedFolder, rootDirectory)) {
      throw new Error("Refusing to rename a folder outside the configured download directory.");
    }

    const mediaFiles = await collectMediaFiles(resolvedFolder);
    const renamed: MetadataFixRenameResult["renamed"] = [];
    const skipped: MetadataFixRenameResult["skipped"] = [];
    const movedSources: string[] = [];

    for (const mediaFile of mediaFiles) {
      try {
        const targetPath = await this.buildTargetPath(mediaFile, resolved);

        if (path.resolve(mediaFile) === path.resolve(targetPath)) {
          skipped.push({ path: mediaFile, reason: "Already at the correct path." });
          continue;
        }

        await mkdir(path.dirname(targetPath), { recursive: true });
        const availablePath = this.settings.download.overwriteExisting
          ? targetPath
          : await getAvailablePath(targetPath);

        await rename(mediaFile, availablePath);
        renamed.push({ from: mediaFile, to: availablePath });
        movedSources.push(mediaFile);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to rename media file during metadata fix: ${mediaFile}`, error);
        skipped.push({ path: mediaFile, reason });
      }
    }

    for (const sourcePath of movedSources) {
      await pruneEmptyParentDirectories(sourcePath, rootDirectory);
    }

    return { renamed, skipped };
  }

  private async buildTargetPath(mediaFile: string, resolved: TmdbResolvedTitle): Promise<string> {
    const extension = path.extname(mediaFile) || ".mp4";
    const rootDirectory = this.settings.download.directory;

    if (resolved.kind === "film") {
      return buildMoviePath({
        rootDirectory,
        title: resolved.title,
        year: resolved.year,
        extension,
        plexIds: resolved.plexIds,
      });
    }

    const episode = await this.resolveEpisode(mediaFile, resolved);

    if (!episode) {
      throw new Error("Could not determine season/episode from the file name.");
    }

    const episodeTitle =
      (await this.tmdbResolver.getEpisodeTitle(resolved.plexIds.tmdb, episode.season, episode.episode)) ??
      episode.episodeTitle;

    return buildTvShowPath({
      rootDirectory,
      title: resolved.title,
      year: resolved.year,
      season: episode.season,
      episode: episode.episode,
      episodeTitle,
      extension,
      plexIds: resolved.plexIds,
    });
  }

  private async resolveEpisode(
    mediaFile: string,
    resolved: TmdbResolvedTitle,
  ): Promise<{ season: number; episode: number; episodeTitle?: string } | undefined> {
    const fromName = parseSeasonEpisode(path.basename(mediaFile));

    if (fromName) {
      return fromName;
    }

    if (!this.mediaClassifier) {
      return undefined;
    }

    const classification = await this.mediaClassifier.classify({
      fileName: path.basename(mediaFile),
      description: `Show title: ${resolved.title}${resolved.year ? ` (${resolved.year})` : ""}`,
    });

    if (classification.kind === "tv_show") {
      return {
        season: classification.season,
        episode: classification.episode,
        episodeTitle: classification.episodeTitle,
      };
    }

    return undefined;
  }
}

export function parseSeasonEpisode(fileName: string): { season: number; episode: number } | undefined {
  const patterns = [
    /(?:^|[^\d])[Ss](\d{1,2})[Ee](\d{1,3})(?:[^\d]|$)/,
    /(?:^|[^\d])(\d{1,2})x(\d{1,3})(?:[^\d]|$)/i,
    /Season[ ._-]*(\d{1,2}).{0,20}Episode[ ._-]*(\d{1,3})/i,
  ];

  for (const pattern of patterns) {
    const match = fileName.match(pattern);

    if (!match) {
      continue;
    }

    const season = Number.parseInt(match[1], 10);
    const episode = Number.parseInt(match[2], 10);

    if (Number.isFinite(season) && Number.isFinite(episode) && season > 0 && episode > 0) {
      return { season, episode };
    }
  }

  return undefined;
}

export function isMediaFileName(fileName: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function collectMediaFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(folderPath, entry.name);
    const entryStat = await stat(entryPath);

    if (entryStat.isDirectory()) {
      files.push(...(await collectMediaFiles(entryPath)));
      continue;
    }

    if (entryStat.isFile() && isMediaFileName(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function getAvailablePath(filePath: string): Promise<string> {
  if (!(await exists(filePath))) {
    return filePath;
  }

  const parsed = path.parse(filePath);

  for (let index = 1; index < 10_000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);

    if (!(await exists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Could not find an available filename for ${filePath}.`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
