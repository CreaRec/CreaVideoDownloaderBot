import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { MediaClassifier } from "../src/media-classifier.js";
import { MetadataFixRenamer, parseSeasonEpisode } from "../src/metadata-fix-renamer.js";
import { TmdbResolver } from "../src/tmdb-resolver.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

test("parseSeasonEpisode reads common episode tags", () => {
  assert.deepEqual(parseSeasonEpisode("Show.s02e07.mkv"), { season: 2, episode: 7 });
  assert.deepEqual(parseSeasonEpisode("Show.2x07.mkv"), { season: 2, episode: 7 });
  assert.deepEqual(parseSeasonEpisode("Show Name - s01e01 - Pilot.mp4"), { season: 1, episode: 1 });
  assert.equal(parseSeasonEpisode("movie.mp4"), undefined);
});

test("renameFolder moves a film into the Plex movie path", async () => {
  await withTempDir(async (dir) => {
    const sourceFolder = path.join(dir, "Undefined", "Wrong Movie");
    await mkdir(sourceFolder, { recursive: true });
    await writeFile(path.join(sourceFolder, "wrong.mp4"), "video", "utf8");

    const renamer = new MetadataFixRenamer(
      createSettings({ download: { directory: dir, overwriteExisting: false } }),
      createLoggerSpy(),
      new TmdbResolver(createSettings({ tmdb: { apiKey: "tmdb-key" } }), createLoggerSpy()),
    );

    const result = await renamer.renameFolder(sourceFolder, {
      kind: "film",
      title: "Inception",
      year: 2010,
      plexIds: { imdb: "tt1375666", tmdb: 27205 },
    });

    assert.equal(result.renamed.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.match(result.renamed[0].to, /Movies[/\\]Inception \(2010\) \{imdb-tt1375666\}[/\\]Inception \(2010\) \{imdb-tt1375666\}\.mp4$/);
    assert.equal(await readFile(result.renamed[0].to, "utf8"), "video");
  });
});

test("renameFolder moves TV episodes using season tags and TMDB episode titles", async () => {
  await withTempDir(async (dir) => {
    const sourceFolder = path.join(dir, "Undefined", "Wrong Show");
    await mkdir(path.join(sourceFolder, "Season 01"), { recursive: true });
    await writeFile(path.join(sourceFolder, "Season 01", "ep.s01e01.mkv"), "one", "utf8");
    await writeFile(path.join(sourceFolder, "Season 01", "ep.s01e02.mkv"), "two", "utf8");

    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      const pathName = new URL(url).pathname;

      if (pathName === "/3/tv/1396/season/1/episode/1") {
        return { ok: true, status: 200, json: async () => ({ name: "Pilot" }) };
      }

      if (pathName === "/3/tv/1396/season/1/episode/2") {
        return { ok: true, status: 200, json: async () => ({ name: "Cat's in the Bag..." }) };
      }

      throw new Error(`Unexpected TMDB path: ${pathName}`);
    });

    const settings = createSettings({
      download: { directory: dir, overwriteExisting: false },
      tmdb: { apiKey: "tmdb-key" },
    });
    const renamer = new MetadataFixRenamer(settings, createLoggerSpy(), new TmdbResolver(settings, createLoggerSpy()));

    const result = await renamer.renameFolder(sourceFolder, {
      kind: "tv_show",
      title: "Breaking Bad",
      year: 2008,
      plexIds: { imdb: "tt0903747", tmdb: 1396, tvdb: 81189 },
    });

    assert.equal(result.renamed.length, 2);
    assert.equal(result.skipped.length, 0);
    assert.match(
      result.renamed[0].to,
      /TV Shows[/\\]Breaking Bad \(2008\) \{tvdb-81189\}[/\\]Season 01[/\\]Breaking Bad \(2008\) - s01e01 - Pilot\.mkv$/,
    );
    assert.match(
      result.renamed[1].to,
      /TV Shows[/\\]Breaking Bad \(2008\) \{tvdb-81189\}[/\\]Season 01[/\\]Breaking Bad \(2008\) - s01e02 - Cat's in the Bag\.\.\.\.mkv$/,
    );
  });
});

test("renameFolder skips TV files without season/episode when classifier cannot help", async () => {
  await withTempDir(async (dir) => {
    const sourceFolder = path.join(dir, "Undefined", "Wrong Show");
    await mkdir(sourceFolder, { recursive: true });
    await writeFile(path.join(sourceFolder, "mystery.mkv"), "video", "utf8");

    const settings = createSettings({
      download: { directory: dir, overwriteExisting: false },
      openai: { apiKey: "" },
      tmdb: { apiKey: "tmdb-key" },
    });
    const renamer = new MetadataFixRenamer(
      settings,
      createLoggerSpy(),
      new TmdbResolver(settings, createLoggerSpy()),
      new MediaClassifier(settings, createLoggerSpy()),
    );

    const result = await renamer.renameFolder(sourceFolder, {
      kind: "tv_show",
      title: "Breaking Bad",
      year: 2008,
      plexIds: { tmdb: 1396 },
    });

    assert.equal(result.renamed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /season\/episode/i);
  });
});
