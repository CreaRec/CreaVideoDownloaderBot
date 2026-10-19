import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeMediaTitle,
  parseTitleAndYearFromFolderDisplayName,
  stripPlexIdTagsFromFolderName,
} from "../src/metadata/title-normalize.js";
import {
  buildLibraryShowId,
  findDeterministicLibraryMatches,
  parseTvShowFolderName,
} from "../src/metadata/tv-library-catalog.js";

test("normalizeMediaTitle folds case, ё/е, punctuation, and whitespace", () => {
  assert.equal(normalizeMediaTitle("Как Я Встретил Вашу Маму"), normalizeMediaTitle("как я встретил вашу маму"));
  assert.equal(normalizeMediaTitle("Ёлка"), normalizeMediaTitle("елка"));
  assert.equal(normalizeMediaTitle("Foo - Bar!!!"), "foo bar");
});

test("parseTvShowFolderName extracts title, year, and ids from Plex folders", () => {
  const parsed = parseTvShowFolderName("Как я встретил вашу маму (2005) {tvdb-75760}");

  assert.deepEqual(parsed, {
    folderName: "Как я встретил вашу маму (2005) {tvdb-75760}",
    title: "Как я встретил вашу маму",
    year: 2005,
    plexIds: { tvdb: 75760 },
    id: "tvdb-75760",
  });
});

test("findDeterministicLibraryMatches returns all normalized title hits", () => {
  const library = [
    parseTvShowFolderName("Как я встретил вашу маму (2005) {tvdb-75760}")!,
    parseTvShowFolderName("Как я встретил вашу маму (2010) {tmdb-85267}")!,
    parseTvShowFolderName("Breaking Bad (2008) {tvdb-81189}")!,
  ];

  const matches = findDeterministicLibraryMatches("Как я встретил вашу маму", library);

  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.id, "tvdb-75760");
  assert.equal(matches[1]?.id, "tmdb-85267");
});

test("stripPlexIdTagsFromFolderName and parseTitleAndYearFromFolderDisplayName", () => {
  const stripped = stripPlexIdTagsFromFolderName("Show Name (1999) {imdb-tt123}");
  assert.equal(stripped, "Show Name (1999)");
  assert.deepEqual(parseTitleAndYearFromFolderDisplayName(stripped), { title: "Show Name", year: 1999 });
  assert.equal(buildLibraryShowId("folder", { tmdb: 42 }, "Show", 1999), "tmdb-42");
});
