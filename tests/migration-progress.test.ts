import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMigrationProgress } from "../src/migration-progress.js";

test("formatMigrationProgress pads the index to match total width", () => {
  assert.equal(formatMigrationProgress(1, 9, "resolving movie.mp4"), "[1/9] resolving movie.mp4");
  assert.equal(formatMigrationProgress(10, 42, "moving movie.mp4"), "[10/42] moving movie.mp4");
  assert.equal(formatMigrationProgress(5, 100, "resolved -> /dest/path.mp4"), "[  5/100] resolved -> /dest/path.mp4");
});
