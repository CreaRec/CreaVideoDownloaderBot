import assert from "node:assert/strict";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { isAllowedBrowsePath, isProtectedRoot, pruneEmptyParentDirectories } from "../src/download/download-paths.js";
import { withTempDir } from "./helpers/test-utils.js";

test("isProtectedRoot matches only top-level Movies, TV Shows, Undefined, and Kids", () => {
  assert.equal(isProtectedRoot("Movies"), true);
  assert.equal(isProtectedRoot("TV Shows"), true);
  assert.equal(isProtectedRoot("Undefined"), true);
  assert.equal(isProtectedRoot("Kids"), true);
  assert.equal(isProtectedRoot("Movies/Nested"), false);
  assert.equal(isProtectedRoot("Kids/Movies"), false);
  assert.equal(isProtectedRoot("loose"), false);
});

test("isAllowedBrowsePath allows only the download root and configured media roots", () => {
  assert.equal(isAllowedBrowsePath(""), true);
  assert.equal(isAllowedBrowsePath("Movies"), true);
  assert.equal(isAllowedBrowsePath("Movies/Nested"), true);
  assert.equal(isAllowedBrowsePath("TV Shows/Show/Season 01"), true);
  assert.equal(isAllowedBrowsePath("Undefined/clip.mp4"), true);
  assert.equal(isAllowedBrowsePath("Kids"), true);
  assert.equal(isAllowedBrowsePath("Kids/Movies/Demo"), true);
  assert.equal(isAllowedBrowsePath("Архив"), false);
  assert.equal(isAllowedBrowsePath("Детское/clip.mp4"), false);
  assert.equal(isAllowedBrowsePath("loose.mp4"), false);
});

test("pruneEmptyParentDirectories removes nested empty folders but keeps protected roots", async () => {
  await withTempDir(async (dir) => {
    const episodePath = path.join(dir, "TV Shows", "Show", "Season 01", "Show - s01e04.mkv");
    await mkdir(path.dirname(episodePath), { recursive: true });
    await writeFile(episodePath, "video", "utf8");
    await unlink(episodePath);

    const removedPaths = await pruneEmptyParentDirectories(episodePath, dir);

    assert.deepEqual(removedPaths.sort(), ["TV Shows/Show", "TV Shows/Show/Season 01"].sort());
    await assert.rejects(stat(path.join(dir, "TV Shows", "Show")));
    await stat(path.join(dir, "TV Shows"));
  });
});

test("pruneEmptyParentDirectories keeps Movies when its last file is removed", async () => {
  await withTempDir(async (dir) => {
    const moviePath = path.join(dir, "Movies", "movie.mp4");
    await mkdir(path.dirname(moviePath), { recursive: true });
    await writeFile(moviePath, "video", "utf8");
    await unlink(moviePath);

    const removedPaths = await pruneEmptyParentDirectories(moviePath, dir);

    assert.deepEqual(removedPaths, []);
    await stat(path.join(dir, "Movies"));
  });
});

test("pruneEmptyParentDirectories stops when a sibling file remains", async () => {
  await withTempDir(async (dir) => {
    const firstPath = path.join(dir, "TV Shows", "Show", "Season 01", "1.mkv");
    const secondPath = path.join(dir, "TV Shows", "Show", "Season 01", "2.mkv");
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, "video", "utf8");
    await writeFile(secondPath, "video", "utf8");
    await unlink(firstPath);

    const removedPaths = await pruneEmptyParentDirectories(firstPath, dir);

    assert.deepEqual(removedPaths, []);
    await stat(path.join(dir, "TV Shows", "Show", "Season 01"));
  });
});

test("pruneEmptyParentDirectories ignores dotfiles when checking emptiness", async () => {
  await withTempDir(async (dir) => {
    const moviePath = path.join(dir, "Movies", "Movie Folder", "movie.mp4");
    await mkdir(path.dirname(moviePath), { recursive: true });
    await writeFile(moviePath, "video", "utf8");
    await writeFile(path.join(path.dirname(moviePath), ".DS_Store"), "meta", "utf8");
    await unlink(moviePath);

    const removedPaths = await pruneEmptyParentDirectories(moviePath, dir);

    assert.deepEqual(removedPaths, ["Movies/Movie Folder"]);
    await assert.rejects(stat(path.join(dir, "Movies", "Movie Folder")));
  });
});
