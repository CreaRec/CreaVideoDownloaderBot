import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { FileTreeBrowser, isPathInsideDirectory, type FileTreeView } from "../src/files/file-tree.js";
import { withTempDir } from "./helpers/test-utils.js";

test("reset clears cached file tree tokens", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "Movies"), { recursive: true });
    await writeFile(path.join(dir, "Movies", "loose.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();
    const moviesCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(moviesCallback);

    const selectedMovies = await browser.renderSelectedToken(moviesCallback.token);
    const openMovies = browser.parseCallbackData(findButton(selectedMovies, "Open").callback_data);
    assert.ok(openMovies);

    const moviesView = await browser.renderDirectoryToken(openMovies.token);
    const fileCallback = browser.parseCallbackData(findButton(moviesView, "File loose.mp4").callback_data);

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
    await mkdir(path.join(dir, "Kids"), { recursive: true });
    await mkdir(path.join(dir, "Архив"), { recursive: true });
    await writeFile(path.join(dir, "loose.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();

    assert.match(rootView.message, /Folder Movies\/ \[protected\]/);
    assert.match(rootView.message, /Folder TV Shows\/ \[protected\]/);
    assert.match(rootView.message, /Folder Undefined\/ \[protected\]/);
    assert.match(rootView.message, /Folder Kids\/ \[protected\]/);
    assert.doesNotMatch(rootView.message, /Архив/);
    assert.doesNotMatch(rootView.message, /loose\.mp4/);
    assert.equal(hasButton(rootView, "Folder Архив"), false);
    assert.equal(hasButton(rootView, "File loose.mp4"), false);

    const filmCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(filmCallback);
    assert.equal(filmCallback?.action, "select");

    const selectedFilm = await browser.renderSelectedToken(filmCallback.token);
    assert.match(selectedFilm.message, /This item cannot be deleted/);
    assert.equal(hasButton(selectedFilm, "Open"), true);
    assert.equal(hasButton(selectedFilm, "Delete"), false);
    assert.equal(hasButton(selectedFilm, "Move to Kids"), false);

    const kidsCallback = browser.parseCallbackData(findButton(rootView, "Folder Kids").callback_data);
    assert.ok(kidsCallback);
    const selectedKids = await browser.renderSelectedToken(kidsCallback.token);
    assert.equal(hasButton(selectedKids, "Move to Kids"), false);
    assert.equal(hasButton(selectedKids, "Delete"), false);
  });
});

test("/files tree rejects paths outside configured root folders", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "Архив"), { recursive: true });
    await writeFile(path.join(dir, "Архив", "clip.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const token = (
      browser as unknown as {
        getOrCreateToken: (relativePath: string) => string;
      }
    ).getOrCreateToken("Архив");

    await assert.rejects(browser.renderSelectedToken(token), /configured root folders/);
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
    assert.equal(hasButton(selectedNested, "Move to Kids"), true);
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

test("/files tree Move to Kids is only on library folders, not files or Kids paths", async () => {
  await withTempDir(async (dir) => {
    const movieFolder = path.join(dir, "Movies", "Demo Movie");
    const kidsFolder = path.join(dir, "Kids", "Movies", "Already Kids");
    await mkdir(movieFolder, { recursive: true });
    await writeFile(path.join(movieFolder, "movie.mp4"), "video", "utf8");
    await mkdir(kidsFolder, { recursive: true });
    await writeFile(path.join(kidsFolder, "movie.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();

    const moviesCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(moviesCallback);
    const selectedMovies = await browser.renderSelectedToken(moviesCallback.token);
    assert.equal(hasButton(selectedMovies, "Move to Kids"), false);

    const openMovies = browser.parseCallbackData(findButton(selectedMovies, "Open").callback_data);
    assert.ok(openMovies);
    const moviesView = await browser.renderDirectoryToken(openMovies.token);
    const filmCallback = browser.parseCallbackData(findButton(moviesView, "Folder Demo Movie").callback_data);
    assert.ok(filmCallback);

    const selectedFilm = await browser.renderSelectedToken(filmCallback.token);
    assert.equal(hasButton(selectedFilm, "Move to Kids"), true);
    const moveCallback = browser.parseCallbackData(findButton(selectedFilm, "Move to Kids").callback_data);
    assert.ok(moveCallback);
    assert.equal(moveCallback.action, "move");

    const openFilm = browser.parseCallbackData(findButton(selectedFilm, "Open").callback_data);
    assert.ok(openFilm);
    const filmView = await browser.renderDirectoryToken(openFilm.token);
    const fileCallback = browser.parseCallbackData(findButton(filmView, "File movie.mp4").callback_data);
    assert.ok(fileCallback);
    const selectedFile = await browser.renderSelectedToken(fileCallback.token);
    assert.equal(hasButton(selectedFile, "Move to Kids"), false);

    const kidsRootCallback = browser.parseCallbackData(findButton(rootView, "Folder Kids").callback_data);
    assert.ok(kidsRootCallback);
    const selectedKidsRoot = await browser.renderSelectedToken(kidsRootCallback.token);
    const openKids = browser.parseCallbackData(findButton(selectedKidsRoot, "Open").callback_data);
    assert.ok(openKids);
    const kidsView = await browser.renderDirectoryToken(openKids.token);
    const kidsMoviesCallback = browser.parseCallbackData(findButton(kidsView, "Folder Movies").callback_data);
    assert.ok(kidsMoviesCallback);
    const selectedKidsMovies = await browser.renderSelectedToken(kidsMoviesCallback.token);
    const openKidsMovies = browser.parseCallbackData(findButton(selectedKidsMovies, "Open").callback_data);
    assert.ok(openKidsMovies);
    const kidsMoviesView = await browser.renderDirectoryToken(openKidsMovies.token);
    const kidsFilmCallback = browser.parseCallbackData(findButton(kidsMoviesView, "Folder Already Kids").callback_data);
    assert.ok(kidsFilmCallback);
    const selectedKidsFilm = await browser.renderSelectedToken(kidsFilmCallback.token);
    assert.equal(hasButton(selectedKidsFilm, "Move to Kids"), false);
  });
});

test("/files tree Move to Kids moves folder and refuses overwrite", async () => {
  await withTempDir(async (dir) => {
    const sourceFolder = path.join(dir, "Movies", "Demo Movie");
    const targetFolder = path.join(dir, "Kids", "Movies", "Demo Movie");
    await mkdir(sourceFolder, { recursive: true });
    await writeFile(path.join(sourceFolder, "movie.mp4"), "video", "utf8");

    const browser = new FileTreeBrowser(dir);
    const rootView = await browser.renderRoot();
    const moviesCallback = browser.parseCallbackData(findButton(rootView, "Folder Movies").callback_data);
    assert.ok(moviesCallback);
    const selectedMovies = await browser.renderSelectedToken(moviesCallback.token);
    const openMovies = browser.parseCallbackData(findButton(selectedMovies, "Open").callback_data);
    assert.ok(openMovies);
    const moviesView = await browser.renderDirectoryToken(openMovies.token);
    const filmCallback = browser.parseCallbackData(findButton(moviesView, "Folder Demo Movie").callback_data);
    assert.ok(filmCallback);

    const selectedFilm = await browser.renderSelectedToken(filmCallback.token);
    const moveCallback = browser.parseCallbackData(findButton(selectedFilm, "Move to Kids").callback_data);
    assert.ok(moveCallback);

    const confirmation = await browser.renderMoveToKidsConfirmationToken(moveCallback.token);
    assert.match(confirmation.message, /Move this folder to Kids/);
    assert.match(confirmation.message, /Movies\/Demo Movie/);
    assert.match(confirmation.message, /Kids\/Movies\/Demo Movie/);
    assert.equal(hasButton(confirmation, "Confirm move"), true);

    const confirmCallback = browser.parseCallbackData(findButton(confirmation, "Confirm move").callback_data);
    assert.ok(confirmCallback);
    assert.equal(confirmCallback.action, "confirm-move");

    const { outcome, targetRelativePath } = await browser.moveTokenToKids(confirmCallback.token);
    assert.equal(outcome, "moved");
    assert.equal(targetRelativePath?.split(path.sep).join("/"), "Kids/Movies/Demo Movie");
    await assert.rejects(stat(sourceFolder));
    await stat(path.join(targetFolder, "movie.mp4"));

    const moviesAfter = await browser.renderDirectoryToken(openMovies.token);
    assert.doesNotMatch(moviesAfter.message, /Demo Movie/);

    await mkdir(sourceFolder, { recursive: true });
    await writeFile(path.join(sourceFolder, "movie.mp4"), "again", "utf8");
    const browser2 = new FileTreeBrowser(dir);
    const root2 = await browser2.renderRoot();
    const movies2 = browser2.parseCallbackData(findButton(root2, "Folder Movies").callback_data);
    assert.ok(movies2);
    const selectedMovies2 = await browser2.renderSelectedToken(movies2.token);
    const openMovies2 = browser2.parseCallbackData(findButton(selectedMovies2, "Open").callback_data);
    assert.ok(openMovies2);
    const moviesView2 = await browser2.renderDirectoryToken(openMovies2.token);
    const film2 = browser2.parseCallbackData(findButton(moviesView2, "Folder Demo Movie").callback_data);
    assert.ok(film2);
    const conflict = await browser2.moveTokenToKids(film2.token);
    assert.equal(conflict.outcome, "target-exists");
    await stat(sourceFolder);
    await stat(targetFolder);
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
