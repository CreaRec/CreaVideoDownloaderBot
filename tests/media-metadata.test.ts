import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { MediaMetadataService } from "../src/metadata/media-metadata.js";
import type { MediaClassification } from "../src/metadata/media-classifier.js";
import type { TmdbMatch } from "../src/metadata/tmdb-resolver.js";
import { createLoggerSpy, createSettings } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

test("resolveMetadata merges TMDB movie ids into Plex metadata", async () => {
  const classifier = {
    classify: async (): Promise<MediaClassification> => ({
      kind: "film",
      title: "Inception",
      year: 2010,
    }),
  };
  const tmdbResolver = {
    resolve: async (): Promise<TmdbMatch> => ({
      kind: "film",
      title: "Inception",
      year: 2010,
      plexIds: { imdb: "tt1375666", tmdb: 27205 },
    }),
  };

  const service = new MediaMetadataService(
    createSettings({ tmdb: { apiKey: "tmdb-key" } }),
    createLoggerSpy(),
    classifier as never,
    tmdbResolver as never,
  );

  const metadata = await service.resolveMetadata({ fileName: "Inception.2010.mkv" });

  assert.deepEqual(metadata, {
    kind: "film",
    title: "Inception",
    displayTitle: "Inception (2010)",
    year: 2010,
    plexIds: { imdb: "tt1375666", tmdb: 27205 },
  });
});

test("resolveMetadata keeps OpenAI tv metadata when TMDB is unavailable", async () => {
  const classifier = {
    classify: async (): Promise<MediaClassification> => ({
      kind: "tv_show",
      title: "Breaking Bad",
      year: 2008,
      season: 1,
      episode: 1,
      episodeTitle: "Pilot",
    }),
  };
  const tmdbResolver = {
    resolve: async () => undefined,
  };

  const service = new MediaMetadataService(
    createSettings(),
    createLoggerSpy(),
    classifier as never,
    tmdbResolver as never,
  );

  const metadata = await service.resolveMetadata({
    fileName: "episode.mkv",
    description: "Breaking Bad S01E01",
  });

  assert.deepEqual(metadata, {
    kind: "tv_show",
    title: "Breaking Bad",
    displayTitle: "Breaking Bad (2008)",
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: "Pilot",
    plexIds: undefined,
  });
});

test("buildOutputPath uses enriched movie metadata", () => {
  const service = new MediaMetadataService(createSettings(), createLoggerSpy());

  const outputPath = service.buildOutputPath(
    {
      kind: "film",
      title: "Inception",
      year: 2010,
      plexIds: { imdb: "tt1375666" },
    },
    "/video",
    "fallback.mkv",
    ".mkv",
  );

  assert.match(outputPath, /Movies\/Inception \(2010\) \{imdb-tt1375666\}\/Inception \(2010\) \{imdb-tt1375666\}\.mkv$/);
});
