import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAutoSearchLabel,
  mergeTmdbCandidates,
  planMetadataFixSearchQueries,
} from "../src/metadata/metadata-fix-autosearch.js";

test("planMetadataFixSearchQueries cleans telegram filenames", () => {
  const queries = planMetadataFixSearchQueries("Испанский_английский_Перевод_1_Провайдер_2q480.mp4");

  assert.equal(queries.length, 1);
  assert.match(queries[0].query.toLowerCase(), /испанский/);
  assert.doesNotMatch(queries[0].query.toLowerCase(), /провайдер/);
});

test("mergeTmdbCandidates deduplicates and keeps highest scores", () => {
  const merged = mergeTmdbCandidates([
    [
      { kind: "film", tmdbId: 1, title: "A", score: 10 },
      { kind: "film", tmdbId: 2, title: "B", score: 5 },
    ],
    [{ kind: "film", tmdbId: 1, title: "A", score: 99 }],
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].tmdbId, 1);
  assert.equal(merged[0].score, 99);
});

test("buildAutoSearchLabel lists query labels", () => {
  assert.equal(
    buildAutoSearchLabel([
      { query: "Spanglish", year: 2004, label: "Угадывание: Spanglish (2004)" },
      { query: "Испанский английский", label: "Испанский английский" },
    ]),
    "Автопоиск: Угадывание: Spanglish (2004); Испанский английский",
  );
});
