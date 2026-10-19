import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { MediaMetadataService } from "../src/metadata/media-metadata.js";
import type { MediaClassification } from "../src/metadata/media-classifier.js";
import { TvLibraryCatalog, type LibraryTvShow } from "../src/metadata/tv-library-catalog.js";
import { createLoggerSpy, createSettings } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

const himym2005: LibraryTvShow = {
  folderName: "Как я встретил вашу маму (2005) {tvdb-75760}",
  title: "Как я встретил вашу маму",
  year: 2005,
  plexIds: { tvdb: 75760 },
  id: "tvdb-75760",
};

test("resolveMetadata uses a single deterministic library match and skips TMDB series search", async () => {
  const classifier = {
    classify: async (input: { existingShows?: unknown[] }) => {
      assert.equal(input.existingShows?.length, 1);
      return {
        kind: "tv_show",
        title: "Как я встретил вашу маму",
        season: 3,
        episode: 5,
      } satisfies MediaClassification;
    },
  };

  const tmdbResolver = {
    resolve: async () => {
      throw new Error("TMDB resolve should not run");
    },
    getEpisodeTitle: async () => undefined,
  };

  const catalog = {
    listShows: async () => [himym2005],
    invalidate: () => undefined,
  };

  const service = new MediaMetadataService(
    createSettings(),
    createLoggerSpy(),
    classifier as never,
    tmdbResolver as never,
    catalog as never,
  );

  const metadata = await service.resolveMetadata({ description: "caption" });

  assert.equal(metadata.kind, "tv_show");
  assert.equal(metadata.title, "Как я встретил вашу маму");
  assert.equal(metadata.year, 2005);
  assert.deepEqual(metadata.plexIds, { tvdb: 75760 });
});

test("resolveMetadata uses LLM existingShowId when deterministic match is absent", async () => {
  const classifier = {
    classify: async () =>
      ({
        kind: "tv_show",
        title: "How I Met Your Mother",
        season: 1,
        episode: 1,
        libraryShowId: "tvdb-75760",
      }) satisfies MediaClassification,
  };

  const tmdbResolver = {
    resolve: async () => {
      throw new Error("TMDB resolve should not run");
    },
    getEpisodeTitle: async () => undefined,
  };

  const catalog = {
    listShows: async () => [himym2005],
    invalidate: () => undefined,
  };

  const service = new MediaMetadataService(
    createSettings(),
    createLoggerSpy(),
    classifier as never,
    tmdbResolver as never,
    catalog as never,
  );

  const metadata = await service.resolveMetadata({ description: "caption" });

  assert.equal(metadata.year, 2005);
  assert.deepEqual(metadata.plexIds, { tvdb: 75760 });
});

test("resolveMetadata asks user on ambiguous library matches", async () => {
  const himym2010: LibraryTvShow = {
    folderName: "Как я встретил вашу маму (2010) {tmdb-85267}",
    title: "Как я встретил вашу маму",
    year: 2010,
    plexIds: { tmdb: 85267 },
    id: "tmdb-85267",
  };

  const classifier = {
    classify: async () =>
      ({
        kind: "tv_show",
        title: "Как я встретил вашу маму",
        season: 3,
        episode: 1,
      }) satisfies MediaClassification,
  };

  const tmdbResolver = {
    resolve: async () => {
      throw new Error("TMDB resolve should not run");
    },
    getEpisodeTitle: async () => undefined,
  };

  const catalog = {
    listShows: async () => [himym2005, himym2010],
    invalidate: () => undefined,
  };

  const service = new MediaMetadataService(
    createSettings(),
    createLoggerSpy(),
    classifier as never,
    tmdbResolver as never,
    catalog as never,
  );

  let prompted = false;
  const metadata = await service.resolveMetadata(
    { description: "caption" },
    {
      resolveAmbiguousTvShow: async () => {
        prompted = true;
        return { source: "library", showId: "tvdb-75760" };
      },
    },
  );

  assert.equal(prompted, true);
  assert.equal(metadata.year, 2005);
  assert.deepEqual(metadata.plexIds, { tvdb: 75760 });
});
