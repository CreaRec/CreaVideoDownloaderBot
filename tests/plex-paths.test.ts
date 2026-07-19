import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMoviePath,
  buildTvShowPath,
  buildUndefinedPath,
  formatEpisodeTag,
  formatPlexIdTags,
  formatPlexTitle,
  formatSeasonDir,
  normalizeImdbId,
  parsePlexIdTags,
  plexIdsOverlap,
  sanitizePlexName,
} from "../src/metadata/plex-paths.js";

test("formatPlexTitle includes year when provided", () => {
  assert.equal(formatPlexTitle("Inception", 2010), "Inception (2010)");
  assert.equal(formatPlexTitle("Inception"), "Inception");
});

test("formatSeasonDir and formatEpisodeTag are zero-padded", () => {
  assert.equal(formatSeasonDir(3), "Season 03");
  assert.equal(formatEpisodeTag(3, 4), "s03e04");
});

test("formatPlexIdTags prefers imdb for films and tvdb for shows", () => {
  assert.equal(formatPlexIdTags({ imdb: "tt1375666", tmdb: 27205 }, "film"), " {imdb-tt1375666}");
  assert.equal(formatPlexIdTags({ tmdb: 27205 }, "film"), " {tmdb-27205}");
  assert.equal(formatPlexIdTags({ tvdb: 81189, tmdb: 1396 }, "tv_show"), " {tvdb-81189}");
});

test("parsePlexIdTags extracts imdb, tmdb, and tvdb tags", () => {
  assert.deepEqual(parsePlexIdTags("Inception (2010) {imdb-tt1375666}"), { imdb: "tt1375666" });
  assert.deepEqual(parsePlexIdTags("Inception (2010) {tmdb-27205}"), { tmdb: 27205 });
  assert.deepEqual(parsePlexIdTags("Breaking Bad (2008) {tvdb-81189}"), { tvdb: 81189 });
  assert.deepEqual(parsePlexIdTags("Show {tmdb-1396} {tvdb-81189}"), { tmdb: 1396, tvdb: 81189 });
  assert.deepEqual(parsePlexIdTags("No tags here"), {});
});

test("normalizeImdbId and plexIdsOverlap match shared identifiers", () => {
  assert.equal(normalizeImdbId("1375666"), "tt1375666");
  assert.equal(plexIdsOverlap({ imdb: "tt1375666" }, { imdb: "1375666", tmdb: 1 }), true);
  assert.equal(plexIdsOverlap({ tmdb: 27205 }, { tmdb: 27205 }), true);
  assert.equal(plexIdsOverlap({ tvdb: 81189 }, { tmdb: 1396 }), false);
});

test("buildMoviePath creates Plex movie folders with id tags", () => {
  const outputPath = buildMoviePath({
    rootDirectory: "/video",
    title: "Inception",
    year: 2010,
    extension: ".mkv",
    plexIds: { imdb: "tt1375666", tmdb: 27205 },
  });

  assert.equal(
    outputPath,
    path.join("/video", "Movies", "Inception (2010) {imdb-tt1375666}", "Inception (2010) {imdb-tt1375666}.mkv"),
  );
});

test("buildTvShowPath creates Plex TV folders with episode title", () => {
  const outputPath = buildTvShowPath({
    rootDirectory: "/video",
    title: "Breaking Bad",
    year: 2008,
    season: 1,
    episode: 1,
    episodeTitle: "Pilot",
    extension: ".mkv",
    plexIds: { tvdb: 81189 },
  });

  assert.equal(
    outputPath,
    path.join(
      "/video",
      "TV Shows",
      "Breaking Bad (2008) {tvdb-81189}",
      "Season 01",
      "Breaking Bad (2008) - s01e01 - Pilot.mkv",
    ),
  );
});

test("buildUndefinedPath keeps legacy fallback names", () => {
  assert.equal(buildUndefinedPath("/video", "bad_name_.mkv"), path.join("/video", "Undefined", "bad_name_.mkv"));
});

test("sanitizePlexName keeps spaces and removes forbidden characters", () => {
  assert.equal(sanitizePlexName('Bad: Name?'), "Bad Name");
});
