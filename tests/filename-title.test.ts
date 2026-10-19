import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanDownloadTitle } from "../src/metadata/filename-title.js";

test("cleanDownloadTitle strips quality and provider noise from telegram filenames", () => {
  const cleaned = cleanDownloadTitle(
    "Испанский_английский_Перевод_1_Провайдер_2q480.mp4",
    undefined,
  );

  assert.match(cleaned.query.toLowerCase(), /испанский/);
  assert.match(cleaned.query.toLowerCase(), /английский/);
  assert.doesNotMatch(cleaned.query.toLowerCase(), /провайдер/);
  assert.doesNotMatch(cleaned.query.toLowerCase(), /перевод/);
});

test("cleanDownloadTitle prefers caption and reads season tags", () => {
  const cleaned = cleanDownloadTitle("random.bin", "Breaking Bad S02E05");

  assert.equal(cleaned.query, "Breaking Bad S02E05");
  assert.equal(cleaned.season, 2);
  assert.equal(cleaned.episode, 5);
});
