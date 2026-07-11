import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { FileTreeBrowser, isPathInsideDirectory, type FileTreeView } from "../src/file-tree.js";
import { withTempDir } from "./helpers/test-utils.js";

test("reset clears cached file tree tokens", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "loose.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();
    const fileCallback = browser.parseCallbackData(findButton(rootView, "File loose.mp4").callback_data);

    assert.ok(fileCallback);

    browser.reset();

    await assert.rejects(browser.renderSelectedToken(fileCallback.token), /no longer available/);
  });
});

test("/files tree renders protected roots and keeps them browse-only", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "Movies"), { recursive: true });
    await mkdir(path.join(dir, "TV Shows"), { recursive: true });
    await mkdir(path.join(dir, "Undefined"), { recursive: true });
    await writeFile(path.join(dir, "loose.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();

    assert.match(rootView.message, /Folder Movies\/ \[protected\]/);
    assert.match(rootView.message, /Folder TV Shows\/ \[protected\]/);
    assert.match(rootView.message, /Folder Undefined\/ \[protected\]/);
    assert.match(rootView.message, /File loose\.mp4/);

    const filmCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(filmCallback);
    assert.equal(filmCallback?.action, "select");

    const selectedFilm = await browser.renderSelectedToken(filmCallback.token);
    assert.match(selectedFilm.message, /This item cannot be deleted/);
    assert.equal(hasButton(selectedFilm, "Open"), true);
    assert.equal(hasButton(selectedFilm, "Delete"), false);
  });
});

test("/files tree can browse protected roots and delete nested folders", async () => {
  await withTempDir(async (dir) => {
    const nestedFolder = path.join(dir, "Movies", "Movie_Folder");

    await mkdir(nestedFolder, { recursive: true });
    await writeFile(path.join(nestedFolder, "movie.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();
    const filmCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(filmCallback);

    const selectedFilm = await browser.renderSelectedToken(filmCallback.token);
    const openFilmCallback = browser.parseCallbackData(findButton(selectedFilm, "Open").callback_data);
    assert.ok(openFilmCallback);

    const filmView = await browser.renderDirectoryToken(openFilmCallback.token);
    assert.match(filmView.message, /Folder Movie_Folder\//);

    const nestedCallback = browser.parseCallbackData(findButton(filmView, "Folder Movie_Folder").callback_data);
    assert.ok(nestedCallback);

    const selectedNested = await browser.renderSelectedToken(nestedCallback.token);
    assert.equal(hasButton(selectedNested, "Open"), true);
    assert.equal(hasButton(selectedNested, "Fix metadata"), true);
    assert.equal(hasButton(selectedNested, "Delete"), true);

    const deleteCallback = browser.parseCallbackData(findButton(selectedNested, "Delete").callback_data);
    assert.ok(deleteCallback);

    const confirmation = await browser.renderDeleteConfirmationToken(deleteCallback.token);
    assert.match(confirmation.message, /Delete this folder and all of its contents/);

    const outcome = await browser.deleteToken(deleteCallback.token);
    assert.equal(outcome, "deleted");
    await assert.rejects(stat(nestedFolder));
  });
});

test("/files tree shows Fix metadata on folders but not protected roots or files", async () => {
  await withTempDir(async (dir) => {
    const nestedFolder = path.join(dir, "Undefined", "Wrong Title");
    await mkdir(nestedFolder, { recursive: true });
    await writeFile(path.join(nestedFolder, "clip.mp4"), "video", "utf8");
    await mkdir(path.join(dir, "Movies"), { recursive: true });

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();

    const moviesCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(moviesCallback);
    const selectedMovies = await browser.renderSelectedToken(moviesCallback.token);
    assert.equal(hasButton(selectedMovies, "Fix metadata"), false);

    const undefinedCallback = browser.parseCallbackData(findButton(rootView, "Folder Undefined").callback_data);
    assert.ok(undefinedCallback);
    const selectedUndefined = await browser.renderSelectedToken(undefinedCallback.token);
    const openUndefined = browser.parseCallbackData(findButton(selectedUndefined, "Open").callback_data);
    assert.ok(openUndefined);

    const undefinedView = await browser.renderDirectoryToken(openUndefined.token);
    const folderCallback = browser.parseCallbackData(findButton(undefinedView, "Folder Wrong Title").callback_data);
    assert.ok(folderCallback);

    const selectedFolder = await browser.renderSelectedToken(folderCallback.token);
    assert.equal(hasButton(selectedFolder, "Fix metadata"), true);
    const fixCallback = browser.parseCallbackData(findButton(selectedFolder, "Fix metadata").callback_data);
    assert.ok(fixCallback);
    assert.equal(fixCallback.action, "fix");

    const openFolder = browser.parseCallbackData(findButton(selectedFolder, "Open").callback_data);
    assert.ok(openFolder);
    const folderView = await browser.renderDirectoryToken(openFolder.token);
    const fileCallback = browser.parseCallbackData(findButton(folderView, "File clip.mp4").callback_data);
    assert.ok(fileCallback);
    const selectedFile = await browser.renderSelectedToken(fileCallback.token);
    assert.equal(hasButton(selectedFile, "Fix metadata"), false);
  });
});

test("/files tree prunes empty parent folders after deleting the last file", async () => {
  await withTempDir(async (dir) => {
    const nestedFolder = path.join(dir, "Movies", "Movie_Folder");
    const moviePath = path.join(nestedFolder, "movie.mp4");

    await mkdir(nestedFolder, { recursive: true });
    await writeFile(moviePath, "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();
    const filmCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(filmCallback);

    const selectedFilm = await browser.renderSelectedToken(filmCallback.token);
    const openFilmCallback = browser.parseCallbackData(findButton(selectedFilm, "Open").callback_data);
    assert.ok(openFilmCallback);

    const filmView = await browser.renderDirectoryToken(openFilmCallback.token);
    const nestedCallback = browser.parseCallbackData(findButton(filmView, "Folder Movie_Folder").callback_data);
    assert.ok(nestedCallback);

    const selectedNested = await browser.renderSelectedToken(nestedCallback.token);
    const openNestedCallback = browser.parseCallbackData(findButton(selectedNested, "Open").callback_data);
    assert.ok(openNestedCallback);

    const nestedView = await browser.renderDirectoryToken(openNestedCallback.token);
    const fileCallback = browser.parseCallbackData(findButton(nestedView, "File movie.mp4").callback_data);
    assert.ok(fileCallback);

    const selectedFile = await browser.renderSelectedToken(fileCallback.token);
    const deleteCallback = browser.parseCallbackData(findButton(selectedFile, "Delete").callback_data);
    assert.ok(deleteCallback);

    const outcome = await browser.deleteToken(deleteCallback.token);
    assert.equal(outcome, "deleted");
    await assert.rejects(stat(moviePath));
    await assert.rejects(stat(nestedFolder));
    await stat(path.join(dir, "Movies"));
  });
});

test("/files tree rejects paths outside the download directory", async () => {
  await withTempDir(async (dir) => {
    const browser = new FileTreeBrowser(dir);
    const outsidePath = path.join(path.dirname(dir), "outside.mp4");
    const token = (
      browser as unknown as {
        getOrCreateToken: (relativePath: string) => string;
      }
    ).getOrCreateToken(path.relative(dir, outsidePath));

    assert.equal(isPathInsideDirectory(path.join(dir, "inside.mp4"), dir), true);
    assert.equal(isPathInsideDirectory(outsidePath, dir), false);
    await assert.rejects(browser.renderSelectedToken(token), /outside/);
  });
});

function findButton(view: FileTreeView, text: string): { text: string; callback_data: string } {
  const button = view.extra.reply_markup.inline_keyboard.flat().find((candidate) => candidate.text === text);

  assert.ok(button, `Expected to find button ${text}`);
  assert.ok("callback_data" in button, `Expected ${text} to have callback data`);

  return button;
}

function hasButton(view: FileTreeView, text: string): boolean {
  return view.extra.reply_markup.inline_keyboard.flat().some((button) => button.text === text);
}
