import type { Logger } from "./logger.js";
import type { Settings } from "./settings.js";

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

export type TmdbMatch = TmdbMovieMatch | TmdbTvShowMatch;

export interface TmdbResolveInput {
  kind: "film" | "tv_show";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

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
    const searchResults = await this.tmdbFetch<TmdbSearchTvResponse>("/search/tv", {
      query: input.title,
      first_air_date_year: input.year,
    });

    const match = pickBestTvMatch(searchResults.results, input.title, input.year);

    if (!match) {
      return undefined;
    }

    const details = await this.tmdbFetch<TmdbTvDetails>(`/tv/${match.id}`, {
      append_to_response: "external_ids",
    });

    let episodeTitle = input.episodeTitle;

    try {
      const episodeDetails = await this.tmdbFetch<TmdbEpisodeDetails>(
        `/tv/${details.id}/season/${input.season}/episode/${input.episode}`,
      );
      episodeTitle = episodeDetails.name || episodeTitle;
    } catch {
      this.logger.debug(`TMDB episode lookup failed for ${details.id} s${input.season}e${input.episode}.`);
    }

    return {
      kind: "tv_show",
      title: details.name || match.name,
      year: getYear(details.first_air_date) ?? getYear(match.first_air_date) ?? input.year,
      season: input.season,
      episode: input.episode,
      episodeTitle,
      plexIds: {
        imdb: details.external_ids?.imdb_id || undefined,
        tmdb: details.id,
        tvdb: details.external_ids?.tvdb_id || undefined,
      },
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
  release_date?: string;
}

interface TmdbSearchMovieResponse {
  results: TmdbSearchMovieResult[];
}

interface TmdbSearchTvResult {
  id: number;
  name: string;
  first_air_date?: string;
}

interface TmdbSearchTvResponse {
  results: TmdbSearchTvResult[];
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
  if (results.length === 0) {
    return undefined;
  }

  const normalizedTitle = normalizeForMatch(title);

  const scored = results
    .map((result) => ({
      result,
      score: scoreTitleMatch(normalizedTitle, normalizeForMatch(result.title)) + scoreYearMatch(year, getYear(result.release_date)),
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.score > 0 ? scored[0].result : results[0];
}

function pickBestTvMatch(results: TmdbSearchTvResult[], title: string, year?: number): TmdbSearchTvResult | undefined {
  if (results.length === 0) {
    return undefined;
  }

  const normalizedTitle = normalizeForMatch(title);

  const scored = results
    .map((result) => ({
      result,
      score: scoreTitleMatch(normalizedTitle, normalizeForMatch(result.name)) + scoreYearMatch(year, getYear(result.first_air_date)),
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.score > 0 ? scored[0].result : results[0];
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreTitleMatch(expected: string, actual: string): number {
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

function getYear(dateValue?: string): number | undefined {
  if (!dateValue) {
    return undefined;
  }

  const year = Number.parseInt(dateValue.slice(0, 4), 10);

  return Number.isFinite(year) ? year : undefined;
}
