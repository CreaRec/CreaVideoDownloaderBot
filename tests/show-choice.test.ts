import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShowAmbiguityPromptMessage,
  createShowChoiceReplyMarkup,
  parseShowCallbackData,
} from "../src/bot/show-choice.js";
import { parseTvShowFolderName } from "../src/metadata/tv-library-catalog.js";

test("createShowAmbiguityPromptMessage lists candidate shows", () => {
  const candidates = [
    parseTvShowFolderName("Как я встретил вашу маму (2005) {tvdb-75760}")!,
    parseTvShowFolderName("Как я встретил вашу маму (2010) {tmdb-85267}")!,
  ];

  const message = createShowAmbiguityPromptMessage("Как я встретил вашу маму", candidates);

  assert.match(message, /Several TV shows in your library match/);
  assert.match(message, /2005/);
  assert.match(message, /2010/);
});

test("show choice callback data round-trips", () => {
  const markup = createShowChoiceReplyMarkup("abc123", [
    parseTvShowFolderName("Show (2008) {tvdb-1}")!,
  ]);

  const libraryButton = markup.reply_markup.inline_keyboard[0][0];
  const tmdbButton = markup.reply_markup.inline_keyboard[1][0];

  assert.deepEqual(parseShowCallbackData(libraryButton.callback_data), {
    action: "library",
    token: "abc123",
    showId: "tvdb-1",
  });
  assert.deepEqual(parseShowCallbackData(tmdbButton.callback_data), {
    action: "tmdb",
    token: "abc123",
    showId: undefined,
  });
});
