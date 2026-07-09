import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFilmMigrationHints,
  getMigrationInstructionsPath,
  isMigrationVideoFile,
  parseLegacyFilmPath,
  parseLegacyTvPath,
} from "../src/migration-metadata.js";

test("isMigrationVideoFile accepts common video files and rejects dotfiles", () => {
  assert.equal(isMigrationVideoFile("/video/bot/Film/movie.mp4"), true);
  assert.equal(isMigrationVideoFile("/video/bot/.telegram-video-delete-buttons.json"), false);
  assert.equal(isMigrationVideoFile("/video/bot/readme.txt"), false);
});

test("parseLegacyTvPath extracts show folder, season, and episode", () => {
  assert.deepEqual(parseLegacyTvPath("TVShow/Интерны/Season_3/23.mp4"), {
    showKey: "TVShow/Интерны",
    showName: "Интерны",
    season: 3,
    episode: 23,
  });
});

test("parseLegacyFilmPath extracts film title hint", () => {
  assert.deepEqual(parseLegacyFilmPath("Film/Пассажиры.mp4"), {
    cacheKey: "Film/Пассажиры.mp4",
    fileName: "Пассажиры.mp4",
    titleHint: "Пассажиры",
  });
});

test("buildFilmMigrationHints asks for the correct theatrical release year", () => {
  const hints = buildFilmMigrationHints({
    cacheKey: "Film/Пассажиры.mp4",
    fileName: "Пассажиры.mp4",
    titleHint: "Пассажиры",
  });

  assert.match(hints.description, /Пассажиры/);
  assert.match(hints.description, /theatrical release year/i);
});

test("getMigrationInstructionsPath points to the migration instructions file", () => {
  assert.match(getMigrationInstructionsPath(), /media-migration-instructions\.md$/);
});
