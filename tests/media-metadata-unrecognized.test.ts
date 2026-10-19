import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import path from "node:path";
import { MediaMetadataService } from "../src/metadata/media-metadata.js";
import type { MediaClassification } from "../src/metadata/media-classifier.js";
import { createLoggerSpy, createSettings } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

test("resolveMetadata uses TMDB fallback after classifier undefined", async () => {
  const classifier = {
    classify: async (): Promise<MediaClassification> => ({
      kind: "undefined",
      reason: "Classifier confidence was too low.",
    }),
  };
  const tmdbResolver = {
    resolve: async () => undefined,
    searchMixedCandidates: async () => [
      { kind: "film", tmdbId: 687, title: "Spanglish", year: 2004, score: 120 },
    ],
    resolveCandidateById: async () => ({
      kind: "film" as const,
      title: "Spanglish",
      year: 2004,
      plexIds: { tmdb: 687 },
    }),
  };

  const service = new MediaMetadataService(
    createSettings({ tmdb: { apiKey: "tmdb-key" } }),
    createLoggerSpy(),
    classifier as never,
    tmdbResolver as never,
    { listShows: async () => [] } as never,
  );

  const metadata = await service.resolveMetadata({
    fileName: "Spanglish.2004.mp4",
    description: "Spanglish 2004",
  });

  assert.equal(metadata.kind, "film");
  assert.equal(metadata.title, "Spanglish");
  assert.equal(metadata.classificationReason, "Classifier confidence was too low.");
});

test("buildOutputPath stores unrecognized media under Movies", () => {
  const service = new MediaMetadataService(createSettings(), createLoggerSpy());
  const outputPath = service.buildOutputPath(
    { kind: "unrecognized", reason: "unknown", displayName: "Mystery Clip", classificationReason: "unknown" },
    "/video",
    "clip.mp4",
    ".mp4",
  );

  assert.equal(outputPath, path.join("/video", "Movies", "Mystery Clip", "clip.mp4"));
});
