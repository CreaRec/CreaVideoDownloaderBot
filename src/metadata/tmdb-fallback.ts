import type { MediaClassificationInput } from "./media-classifier.js";
import type { PlexMetadata } from "./media-metadata.js";
import { formatDisplayTitle } from "./media-metadata.js";
import { cleanDownloadTitle } from "./filename-title.js";
import type { TmdbCandidate, TmdbResolver } from "./tmdb-resolver.js";

const MIN_CONFIDENT_SCORE = 80;
const MIN_SCORE_GAP = 25;

export interface TmdbFallbackResult {
  metadata: PlexMetadata;
  fallbackUsed: boolean;
}

export async function applyTmdbFallbackWhenNeeded(
  classification: { kind: "undefined"; reason: string },
  input: MediaClassificationInput,
  tmdbResolver: TmdbResolver,
): Promise<TmdbFallbackResult> {
  const cleaned = cleanDownloadTitle(input.fileName, input.description);
  const classificationReason = classification.reason;

  if (!cleaned.query) {
    return {
      metadata: buildUnrecognized(classificationReason, "Не удалось извлечь название из файла.", classificationReason),
      fallbackUsed: false,
    };
  }

  const candidates = await tmdbResolver.searchMixedCandidates({
    query: cleaned.query,
    year: cleaned.year,
    limit: 5,
  });

  const confident = pickConfidentCandidate(candidates);

  if (!confident) {
    return {
      metadata: buildUnrecognized(classificationReason, cleaned.query, classificationReason),
      fallbackUsed: false,
    };
  }

  if (confident.kind === "film") {
    const resolved = await tmdbResolver.resolveCandidateById("film", confident.tmdbId);

    if (!resolved || resolved.kind !== "film") {
      return {
        metadata: buildUnrecognized(classificationReason, cleaned.query, classificationReason),
        fallbackUsed: false,
      };
    }

    return {
      metadata: {
        kind: "film",
        title: resolved.title,
        displayTitle: formatDisplayTitle(resolved.title, resolved.year),
        year: resolved.year,
        plexIds: resolved.plexIds,
        classificationReason,
      },
      fallbackUsed: true,
    };
  }

  const season = cleaned.season;
  const episode = cleaned.episode;

  if (!season || !episode) {
    return {
      metadata: buildUnrecognized(
        classificationReason,
        cleaned.query,
        `${classificationReason} TMDB нашёл сериал, но не удалось определить сезон и серию.`,
      ),
      fallbackUsed: false,
    };
  }

  const series = await tmdbResolver.resolveCandidateById("tv_show", confident.tmdbId);

  if (!series || series.kind !== "tv_show") {
    return {
      metadata: buildUnrecognized(classificationReason, cleaned.query, classificationReason),
      fallbackUsed: false,
    };
  }

  const episodeTitle = await tmdbResolver.getEpisodeTitle(series.plexIds.tmdb, season, episode);

  return {
    metadata: {
      kind: "tv_show",
      title: series.title,
      displayTitle: formatDisplayTitle(series.title, series.year),
      year: series.year,
      season,
      episode,
      episodeTitle,
      plexIds: series.plexIds,
      classificationReason,
    },
    fallbackUsed: true,
  };
}

export function pickConfidentCandidate(candidates: TmdbCandidate[]): TmdbCandidate | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const [top, second] = candidates;

  if (!top || top.score < MIN_CONFIDENT_SCORE) {
    return undefined;
  }

  if (!second || top.score - second.score >= MIN_SCORE_GAP) {
    return top;
  }

  if (top.score >= 100 && top.score - second.score >= 10) {
    return top;
  }

  return undefined;
}

function buildUnrecognized(
  classifierReason: string,
  displayName: string,
  classificationReason: string,
): PlexMetadata {
  return {
    kind: "unrecognized",
    reason: classificationReason,
    displayName,
    classificationReason,
  };
}
