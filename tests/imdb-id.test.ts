import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImdbId } from "../src/metadata/imdb-id.js";

test("parseImdbId extracts id from IMDb title URLs", () => {
  assert.equal(parseImdbId("https://www.imdb.com/title/tt27200708/"), "tt27200708");
  assert.equal(parseImdbId("http://imdb.com/title/tt1375666/?ref_=fn_al_tt_1"), "tt1375666");
  assert.equal(parseImdbId("www.imdb.com/title/TT0084311"), "tt0084311");
});

test("parseImdbId extracts a bare tt id", () => {
  assert.equal(parseImdbId("tt27200708"), "tt27200708");
  assert.equal(parseImdbId("IMDb: TT1375666"), "tt1375666");
});

test("parseImdbId prefers the URL id when both appear", () => {
  assert.equal(
    parseImdbId("Wrong tt0000001 https://www.imdb.com/title/tt27200708/ still wrong tt9999999"),
    "tt27200708",
  );
});

test("parseImdbId returns undefined without an IMDb id", () => {
  assert.equal(parseImdbId(undefined), undefined);
  assert.equal(parseImdbId(""), undefined);
  assert.equal(parseImdbId("Mother Mary 2025"), undefined);
  assert.equal(parseImdbId("https://www.themoviedb.org/movie/1"), undefined);
});
