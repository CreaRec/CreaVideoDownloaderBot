import type { Logger } from "../config/logger.js";
import type { Settings } from "../config/settings.js";
import type { PlexIds } from "./plex-paths.js";

const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";

export interface TmdbMovieMatch {
  kind: "film";
  title: string;
  year?: number;
  plexIds: {
    imdb?: string;
    tmdb: number;
    tvdb?: number;
  };
}

export interface TmdbTvShowMatch {
  kind: "tv_show";
  title: string;
  year?: number;
  season: number;
  episode: number;
  episodeTitle?: string;
  plexIds: {
    imdb?: string;
    tmdb: number;
    tvdb?: number;
  };
}

export interface TmdbTvSeriesMatch {
  title: string;
  year?: number;
  plexIds: PlexIds & { tmdb: number };
}

export type TmdbMatch = TmdbMovieMatch | TmdbTvShowMatch;

export interface TmdbResolveInput {
  kind: "film" | "tv_show";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

export interface TmdbTvSeriesResolveInput {
  title: string;
  year?: number;
  originalTitle?: string;
}

export interface TmdbSearchCandidatesInput {
  kind: "film" | "tv_show";
  title: string;
  year?: number;
  limit?: number;
}

export interface TmdbCandidate {
  kind: "film" | "tv_show";
  tmdbId: number;
  title: string;
  year?: number;
  score: number;
}

export interface TmdbResolvedTitle {
  kind: "film" | "tv_show";
  title: string;
  year?: number;
  plexIds: PlexIds & { tmdb: number };
}

const DEFAULT_CANDIDATE_LIMIT = 5;

export class TmdbResolver {
  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(input: TmdbResolveInput): Promise<TmdbMatch | undefined> {
    if (!this.settings.tmdb.apiKey) {
      return undefined;
    }

    try {
      if (input.kind === "film") {
        return await this.resolveMovie(input);
      }

      if (input.season && input.episode) {
        return await this.resolveTvShow(input as TmdbResolveInput & { season: number; episode: number });
      }

      return undefined;
    } catch (error) {
      this.logger.warn("TMDB metadata resolution failed.", error);
      return undefined;
    }
  }

  async resolveTvSeries(input: TmdbTvSeriesResolveInput): Promise<TmdbTvSeriesMatch | undefined> {
    if (!this.settings.tmdb.apiKey) {
      return undefined;
    }

    try {
      const searchResults = await this.tmdbFetch<TmdbSearchTvResponse>("/search/tv", {
        query: input.title,
        first_air_date_year: input.year,
      });

      const match = pickBestTvMatch(searchResults.results, input.title, input.year, input.originalTitle);

      if (!match) {
        return undefined;
      }

      const details = await this.tmdbFetch<TmdbTvDetails>(`/tv/${match.id}`, {
        append_to_response: "external_ids",
      });

      return {
        title: pickLocalizedTitle(details.name, details.original_name, input.originalTitle) || match.name,
        year: getYear(details.first_air_date) ?? getYear(match.first_air_date) ?? input.year,
        plexIds: {
          imdb: details.external_ids?.imdb_id || undefined,
          tmdb: details.id,
          tvdb: details.external_ids?.tvdb_id || undefined,
        },
      };
    } catch (error) {
      this.logger.warn("TMDB TV series resolution failed.", error);
      return undefined;
    }
  }

  async getEpisodeTitle(tmdbShowId: number, season: number, episode: number): Promise<string | undefined> {
    if (!this.settings.tmdb.apiKey) {
      return undefined;
    }

    try {
      const episodeDetails = await this.tmdbFetch<TmdbEpisodeDetails>(
        `/tv/${tmdbShowId}/season/${season}/episode/${episode}`,
      );

      return episodeDetails.name || undefined;
    } catch {
      this.logger.debug(`TMDB episode lookup failed for show ${tmdbShowId} s${season}e${episode}.`);
      return undefined;
    }
  }

  async searchCandidates(input: TmdbSearchCandidatesInput): Promise<TmdbCandidate[]> {
    if (!this.settings.tmdb.apiKey) {
      return [];
    }

    const limit = Math.max(1, input.limit ?? DEFAULT_CANDIDATE_LIMIT);

    try {
      if (input.kind === "film") {
        const searchResults = await this.tmdbFetch<TmdbSearchMovieResponse>("/search/movie", {
          query: input.title,
          year: input.year,
        });

        return rankMovieCandidates(searchResults.results, input.title, input.year).slice(0, limit);
      }

      const searchResults = await this.tmdbFetch<TmdbSearchTvResponse>("/search/tv", {
        query: input.title,
        first_air_date_year: input.year,
      });

      return rankTvCandidates(searchResults.results, input.title, input.year).slice(0, limit);
    } catch (error) {
      this.logger.warn("TMDB candidate search failed.", error);
      return [];
    }
  }

  async findCandidatesByImdbId(imdbId: string): Promise<TmdbCandidate[]> {
    if (!this.settings.tmdb.apiKey) {
      return [];
    }

    try {
      const response = await this.tmdbFetch<TmdbFindResponse>(`/find/${imdbId}`, {
        external_source: "imdb_id",
      });

      const movies = (response.movie_results ?? []).map((result) => ({
        kind: "film" as const,
        tmdbId: result.id,
        title: result.title,
        year: getYear(result.release_date),
        score: result.popularity ?? 0,
      }));

      const shows = (response.tv_results ?? []).map((result) => ({
        kind: "tv_show" as const,
        tmdbId: result.id,
        title: result.name,
        year: getYear(result.first_air_date),
        score: result.popularity ?? 0,
      }));

      return [...movies, ...shows].sort((left, right) => right.score - left.score);
    } catch (error) {
      this.logger.warn(`TMDB IMDb lookup failed for ${imdbId}.`, error);
      return [];
    }
  }

  async resolveCandidateById(kind: "film" | "tv_show", tmdbId: number): Promise<TmdbResolvedTitle | undefined> {
    if (!this.settings.tmdb.apiKey) {
      return undefined;
    }

    try {
      if (kind === "film") {
        const details = await this.tmdbFetch<TmdbMovieDetails>(`/movie/${tmdbId}`, {
          append_to_response: "external_ids",
        });

        return {
          kind: "film",
          title: details.title,
          year: getYear(details.release_date),
          plexIds: {
            imdb: details.external_ids?.imdb_id || undefined,
            tmdb: details.id,
          },
        };
      }

      const details = await this.tmdbFetch<TmdbTvDetails>(`/tv/${tmdbId}`, {
        append_to_response: "external_ids",
      });

      return {
        kind: "tv_show",
        title: details.name || details.original_name || `TMDB ${tmdbId}`,
        year: getYear(details.first_air_date),
        plexIds: {
          imdb: details.external_ids?.imdb_id || undefined,
          tmdb: details.id,
          tvdb: details.external_ids?.tvdb_id || undefined,
        },
      };
    } catch (error) {
      this.logger.warn(`TMDB candidate resolution failed for ${kind} ${tmdbId}.`, error);
      return undefined;
    }
  }

  private async resolveMovie(input: TmdbResolveInput): Promise<TmdbMovieMatch | undefined> {
    const searchResults = await this.tmdbFetch<TmdbSearchMovieResponse>("/search/movie", {
      query: input.title,
      year: input.year,
    });

    const match = pickBestMovieMatch(searchResults.results, input.title, input.year);

    if (!match) {
      return undefined;
    }

    const details = await this.tmdbFetch<TmdbMovieDetails>(`/movie/${match.id}`, {
      append_to_response: "external_ids",
    });

    return {
      kind: "film",
      title: details.title || match.title,
      year: getYear(details.release_date) ?? getYear(match.release_date) ?? input.year,
      plexIds: {
        imdb: details.external_ids?.imdb_id || undefined,
        tmdb: details.id,
      },
    };
  }

  private async resolveTvShow(
    input: TmdbResolveInput & { season: number; episode: number },
  ): Promise<TmdbTvShowMatch | undefined> {
    const series = await this.resolveTvSeries({
      title: input.title,
      year: input.year,
    });

    if (!series) {
      return undefined;
    }

    const episodeTitle = (await this.getEpisodeTitle(series.plexIds.tmdb, input.season, input.episode)) ?? input.episodeTitle;

    return {
      kind: "tv_show",
      title: series.title,
      year: series.year,
      season: input.season,
      episode: input.episode,
      episodeTitle,
      plexIds: series.plexIds,
    };
  }

  private async tmdbFetch<T>(pathName: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const apiKey = this.settings.tmdb.apiKey;

    if (!apiKey) {
      throw new Error("TMDB API key is not configured.");
    }

    const url = new URL(`${TMDB_API_BASE_URL}${pathName}`);
    url.searchParams.set("api_key", apiKey);

    if (this.settings.tmdb.language) {
      url.searchParams.set("language", this.settings.tmdb.language);
    }

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImpl(url);

    if (!response.ok) {
      throw new Error(`TMDB request failed with status ${response.status} for ${pathName}`);
    }

    return (await response.json()) as T;
  }
}

interface TmdbSearchMovieResult {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  popularity?: number;
}

interface TmdbSearchMovieResponse {
  results: TmdbSearchMovieResult[];
}

interface TmdbSearchTvResult {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  popularity?: number;
}

interface TmdbSearchTvResponse {
  results: TmdbSearchTvResult[];
}

interface TmdbFindResponse {
  movie_results?: TmdbSearchMovieResult[];
  tv_results?: TmdbSearchTvResult[];
}

interface TmdbExternalIds {
  imdb_id?: string | null;
  tvdb_id?: number | null;
}

interface TmdbMovieDetails {
  id: number;
  title: string;
  release_date?: string;
  external_ids?: TmdbExternalIds;
}

interface TmdbTvDetails {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  external_ids?: TmdbExternalIds;
}

interface TmdbEpisodeDetails {
  name?: string;
}

function pickBestMovieMatch(
  results: TmdbSearchMovieResult[],
  title: string,
  year?: number,
): TmdbSearchMovieResult | undefined {
  const best = rankMovieCandidates(results, title, year)[0];

  if (!best) {
    return undefined;
  }

  return results.find((result) => result.id === best.tmdbId);
}

function pickBestTvMatch(
  results: TmdbSearchTvResult[],
  title: string,
  year?: number,
  originalTitle?: string,
): TmdbSearchTvResult | undefined {
  const best = rankTvCandidates(results, title, year, originalTitle)[0];

  if (!best) {
    return undefined;
  }

  return results.find((result) => result.id === best.tmdbId);
}

function rankMovieCandidates(results: TmdbSearchMovieResult[], title: string, year?: number): TmdbCandidate[] {
  if (results.length === 0) {
    return [];
  }

  const normalizedTitle = normalizeForMatch(title);
  const scored = results
    .map((result) => ({
      result,
      score:
        scoreTitleMatch(normalizedTitle, normalizeForMatch(result.title)) +
        scoreTitleMatch(normalizedTitle, normalizeForMatch(result.original_title ?? "")) +
        scoreYearMatch(year, getYear(result.release_date)) +
        scorePopularity(result.popularity, !year),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (getYear(right.result.release_date) ?? 0) - (getYear(left.result.release_date) ?? 0) ||
        (right.result.popularity ?? 0) - (left.result.popularity ?? 0),
    );

  const ranked = scored[0]?.score > 0 ? scored : [...scored].sort((left, right) => (right.result.popularity ?? 0) - (left.result.popularity ?? 0));

  return ranked.map(({ result, score }) => ({
    kind: "film" as const,
    tmdbId: result.id,
    title: result.title,
    year: getYear(result.release_date),
    score,
  }));
}

function rankTvCandidates(
  results: TmdbSearchTvResult[],
  title: string,
  year?: number,
  originalTitle?: string,
): TmdbCandidate[] {
  if (results.length === 0) {
    return [];
  }

  const normalizedTitle = normalizeForMatch(title);
  const normalizedOriginalTitle = normalizeForMatch(originalTitle ?? title);
  const scored = results
    .map((result) => ({
      result,
      score:
        scoreTitleMatch(normalizedOriginalTitle, normalizeForMatch(result.original_name ?? "")) * 2 +
        scoreTitleMatch(normalizedOriginalTitle, normalizeForMatch(result.name)) +
        scoreTitleMatch(normalizedTitle, normalizeForMatch(result.name)) +
        scoreTitleMatch(normalizedTitle, normalizeForMatch(result.original_name ?? "")) +
        scoreYearMatch(year, getYear(result.first_air_date)) +
        scorePopularity(result.popularity, !year),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (getYear(right.result.first_air_date) ?? 0) - (getYear(left.result.first_air_date) ?? 0) ||
        (right.result.popularity ?? 0) - (left.result.popularity ?? 0),
    );

  const ranked = scored[0]?.score > 0 ? scored : [...scored].sort((left, right) => (right.result.popularity ?? 0) - (left.result.popularity ?? 0));

  return ranked.map(({ result, score }) => ({
    kind: "tv_show" as const,
    tmdbId: result.id,
    title: result.name,
    year: getYear(result.first_air_date),
    score,
  }));
}

function pickLocalizedTitle(localizedName: string, originalName: string | undefined, preferredTitle?: string): string {
  if (preferredTitle && containsSameWords(preferredTitle, localizedName)) {
    return localizedName;
  }

  if (preferredTitle && originalName && containsSameWords(preferredTitle, originalName)) {
    return preferredTitle;
  }

  return localizedName || originalName || preferredTitle || "";
}

function containsSameWords(left: string, right: string): boolean {
  const normalizedLeft = normalizeForMatch(left);
  const normalizedRight = normalizeForMatch(right);

  return normalizedLeft.length > 0 && (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scoreTitleMatch(expected: string, actual: string): number {
  if (!expected || !actual) {
    return 0;
  }

  if (expected === actual) {
    return 100;
  }

  if (actual.includes(expected) || expected.includes(actual)) {
    return 50;
  }

  return 0;
}

function scoreYearMatch(expected?: number, actual?: number): number {
  if (!expected || !actual) {
    return 0;
  }

  return expected === actual ? 20 : 0;
}

function scorePopularity(popularity: number | undefined, enabled: boolean): number {
  if (!enabled || !popularity) {
    return 0;
  }

  return Math.min(popularity, 100) * 0.2;
}

function getYear(dateValue?: string): number | undefined {
  if (!dateValue) {
    return undefined;
  }

  const year = Number.parseInt(dateValue.slice(0, 4), 10);

  return Number.isFinite(year) ? year : undefined;
}
