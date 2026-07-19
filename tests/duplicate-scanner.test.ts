import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findDuplicateMedia } from "../src/metadata/duplicate-scanner.js";
import type { PlexMetadata } from "../src/metadata/media-metadata.js";
import { withTempDir } from "./helpers/test-utils.js";

test("findDuplicateMedia returns undefined without plex ids", async () => {
  const metadata: PlexMetadata = { kind: "film", title: "Inception", year: 2010 };

  assert.equal(await findDuplicateMedia("/tmp/unused", metadata), undefined);
});

test("findDuplicateMedia finds a movie by imdb across differently titled folders", async () => {
  await withTempDir(async (root) => {
    const existing = path.join(
      root,
      "Movies",
      "Old Inception Title (2010) {imdb-tt1375666}",
      "Old Inception Title (2010) {imdb-tt1375666}.mkv",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const found = await findDuplicateMedia(root, {
      kind: "film",
      title: "Inception",
      year: 2010,
      plexIds: { imdb: "tt1375666", tmdb: 27205 },
    });

    assert.equal(found, existing);
  });
});

test("findDuplicateMedia finds a movie by tmdb when imdb is absent", async () => {
  await withTempDir(async (root) => {
    const existing = path.join(root, "Movies", "Film (2020) {tmdb-99}", "Film (2020) {tmdb-99}.mp4");
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const found = await findDuplicateMedia(root, {
      kind: "film",
      title: "Film",
      year: 2020,
      plexIds: { tmdb: 99 },
    });

    assert.equal(found, existing);
  });
});

test("findDuplicateMedia finds a TV episode by show id and sXXeYY", async () => {
  await withTempDir(async (root) => {
    const existing = path.join(
      root,
      "TV Shows",
      "Breaking Bad (2008) {tvdb-81189}",
      "Season 01",
      "Breaking Bad (2008) - s01e02 - Cat's in the Bag.mkv",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const found = await findDuplicateMedia(root, {
      kind: "tv_show",
      title: "Breaking Bad",
      year: 2008,
      season: 1,
      episode: 2,
      plexIds: { tvdb: 81189, tmdb: 1396 },
    });

    assert.equal(found, existing);
  });
});

test("findDuplicateMedia finds a TV episode by tmdb show id", async () => {
  await withTempDir(async (root) => {
    const existing = path.join(
      root,
      "TV Shows",
      "Show (2015) {tmdb-1396}",
      "Season 02",
      "Show (2015) - s02e03.mkv",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const found = await findDuplicateMedia(root, {
      kind: "tv_show",
      title: "Show",
      season: 2,
      episode: 3,
      plexIds: { tmdb: 1396 },
    });

    assert.equal(found, existing);
  });
});

test("findDuplicateMedia does not match across Movies and TV Shows", async () => {
  await withTempDir(async (root) => {
    const movie = path.join(root, "Movies", "Thing (2010) {tmdb-100}", "Thing (2010) {tmdb-100}.mkv");
    await mkdir(path.dirname(movie), { recursive: true });
    await writeFile(movie, "movie");

    const found = await findDuplicateMedia(root, {
      kind: "tv_show",
      title: "Thing",
      season: 1,
      episode: 1,
      plexIds: { tmdb: 100 },
    });

    assert.equal(found, undefined);
  });
});

test("findDuplicateMedia ignores wrong episode tags", async () => {
  await withTempDir(async (root) => {
    const existing = path.join(
      root,
      "TV Shows",
      "Show (2015) {tmdb-1396}",
      "Season 01",
      "Show (2015) - s01e01.mkv",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const found = await findDuplicateMedia(root, {
      kind: "tv_show",
      title: "Show",
      season: 1,
      episode: 2,
      plexIds: { tmdb: 1396 },
    });

    assert.equal(found, undefined);
  });
});
