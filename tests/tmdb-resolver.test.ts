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

test("resolveTvSeries prefers the Russian original show name over unrelated matches", async () => {
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const pathName = new URL(url).pathname;

    if (pathName === "/3/search/tv") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { id: 70374, name: "The Interns", original_name: "The Interns", first_air_date: "1970-01-01", popularity: 5 },
            { id: 32651, name: "The Interns", original_name: "Интерны", first_air_date: "2010-03-29", popularity: 40 },
          ],
        }),
      };
    }

    if (pathName === "/3/tv/32651") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 32651,
          name: "The Interns",
          original_name: "Интерны",
          first_air_date: "2010-03-29",
          external_ids: { imdb_id: "tt1528698", tvdb_id: 154431 },
        }),
      };
    }

    throw new Error(`Unexpected TMDB path: ${pathName}`);
  });

  const resolver = new TmdbResolver(createSettings({ tmdb: { apiKey: "tmdb-key" } }), createLoggerSpy());

  const result = await resolver.resolveTvSeries({
    title: "The Interns",
    year: 2010,
    originalTitle: "Интерны",
  });

  assert.deepEqual(result, {
    title: "Интерны",
    year: 2010,
    plexIds: { imdb: "tt1528698", tmdb: 32651, tvdb: 154431 },
  });
});

test("resolve prefers the more popular Passengers release when year is missing", async () => {
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const pathName = new URL(url).pathname;

    if (pathName === "/3/search/movie") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { id: 8640, title: "Passengers", release_date: "2002-01-01", popularity: 8 },
            { id: 274870, title: "Passengers", release_date: "2016-12-21", popularity: 90 },
          ],
        }),
      };
    }

    if (pathName === "/3/movie/274870") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 274870,
          title: "Passengers",
          release_date: "2016-12-21",
          external_ids: { imdb_id: "tt1355644" },
        }),
      };
    }

    throw new Error(`Unexpected TMDB path: ${pathName}`);
  });

  const resolver = new TmdbResolver(createSettings({ tmdb: { apiKey: "tmdb-key" } }), createLoggerSpy());

  const result = await resolver.resolve({
    kind: "film",
    title: "Passengers",
  });

  assert.equal(result?.kind, "film");
  assert.equal(result?.year, 2016);
  assert.equal(result?.plexIds.tmdb, 274870);
});
