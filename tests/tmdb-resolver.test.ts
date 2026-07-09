import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { TmdbResolver } from "../src/tmdb-resolver.js";
import { createLoggerSpy, createSettings } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

test("resolve returns undefined without a TMDB API key", async () => {
  const resolver = new TmdbResolver(createSettings(), createLoggerSpy());

  const result = await resolver.resolve({
    kind: "film",
    title: "Inception",
    year: 2010,
  });

  assert.equal(result, undefined);
});

test("resolve returns movie metadata with imdb id", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const pathName = new URL(url).pathname;

    if (pathName === "/3/search/movie") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: 27205, title: "Inception", release_date: "2010-07-16" }],
        }),
      };
    }

    if (pathName === "/3/movie/27205") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 27205,
          title: "Inception",
          release_date: "2010-07-16",
          external_ids: { imdb_id: "tt1375666" },
        }),
      };
    }

    throw new Error(`Unexpected TMDB path: ${pathName}`);
  });

  const resolver = new TmdbResolver(createSettings({ tmdb: { apiKey: "tmdb-key" } }), createLoggerSpy());

  const result = await resolver.resolve({
    kind: "film",
    title: "Inception",
    year: 2010,
  });

  assert.deepEqual(result, {
    kind: "film",
    title: "Inception",
    year: 2010,
    plexIds: { imdb: "tt1375666", tmdb: 27205 },
  });
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("resolve returns tv metadata with tvdb id and episode title", async () => {
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const pathName = new URL(url).pathname;

    if (pathName === "/3/search/tv") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" }],
        }),
      };
    }

    if (pathName === "/3/tv/1396") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 1396,
          name: "Breaking Bad",
          first_air_date: "2008-01-20",
          external_ids: { imdb_id: "tt0903747", tvdb_id: 81189 },
        }),
      };
    }

    if (pathName === "/3/tv/1396/season/1/episode/1") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "Pilot" }),
      };
    }

    throw new Error(`Unexpected TMDB path: ${pathName}`);
  });

  const resolver = new TmdbResolver(createSettings({ tmdb: { apiKey: "tmdb-key" } }), createLoggerSpy());

  const result = await resolver.resolve({
    kind: "tv_show",
    title: "Breaking Bad",
    year: 2008,
    season: 1,
    episode: 1,
  });

  assert.deepEqual(result, {
    kind: "tv_show",
    title: "Breaking Bad",
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: "Pilot",
    plexIds: { imdb: "tt0903747", tmdb: 1396, tvdb: 81189 },
  });
});
