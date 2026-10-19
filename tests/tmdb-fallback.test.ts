import assert from "node:assert/strict";
import { test } from "node:test";
import { pickConfidentCandidate } from "../src/metadata/tmdb-fallback.js";
import type { TmdbCandidate } from "../src/metadata/tmdb-resolver.js";

test("pickConfidentCandidate accepts a clear winner", () => {
  const candidates: TmdbCandidate[] = [
    { kind: "film", tmdbId: 1, title: "Spanglish", year: 2004, score: 120 },
    { kind: "film", tmdbId: 2, title: "Other", year: 2000, score: 40 },
  ];

  assert.equal(pickConfidentCandidate(candidates)?.tmdbId, 1);
});

test("pickConfidentCandidate rejects ambiguous close scores", () => {
  const candidates: TmdbCandidate[] = [
    { kind: "film", tmdbId: 1, title: "A", score: 85 },
    { kind: "film", tmdbId: 2, title: "B", score: 80 },
  ];

  assert.equal(pickConfidentCandidate(candidates), undefined);
});
