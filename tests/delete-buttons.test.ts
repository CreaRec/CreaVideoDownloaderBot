import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  createDeleteButtonReplyMarkup,
  createDeleteConfirmationReplyMarkup,
  createDeleteConfirmationStatusMessage,
  createDeleteFailedStatusMessage,
  createDeletedStatusMessage,
  createMoveToKidsConfirmationStatusMessage,
  deleteDownloadedFile,
  DeleteButtonState,
  isPathInsideDirectory,
  moveDownloadedPathToKids,
  parseDeleteCallbackData,
  stripStatusConfirmationSuffix,
  createMoveToKidsConfirmationReplyMarkup,
} from "../src/files/delete-buttons.js";
import { resolveLibraryItemRelativePath } from "../src/files/kids-move.js";
import { withTempDir } from "./helpers/test-utils.js";

test("delete button callback data is parsed from generated markup", () => {
  const deleteMarkup = createDeleteButtonReplyMarkup("abc123", { includeMoveToKids: true });
  const confirmMarkup = createDeleteConfirmationReplyMarkup("abc123");
  const moveConfirmMarkup = createMoveToKidsConfirmationReplyMarkup("abc123");

  assert.deepEqual(parseDeleteCallbackData(deleteMarkup.reply_markup.inline_keyboard[0][0].callback_data), {
    action: "ask",
    token: "abc123",
  });
  assert.deepEqual(parseDeleteCallbackData(deleteMarkup.reply_markup.inline_keyboard[1][0].callback_data), {
    action: "ask-move",
    token: "abc123",
  });
  assert.deepEqual(parseDeleteCallbackData(confirmMarkup.reply_markup.inline_keyboard[0][0].callback_data), {
    action: "confirm",
    token: "abc123",
  });
  assert.deepEqual(parseDeleteCallbackData(confirmMarkup.reply_markup.inline_keyboard[0][1].callback_data), {
    action: "cancel",
    token: "abc123",
  });
  assert.deepEqual(parseDeleteCallbackData(moveConfirmMarkup.reply_markup.inline_keyboard[0][0].callback_data), {
    action: "confirm-move",
    token: "abc123",
  });
  assert.equal(parseDeleteCallbackData("unknown"), undefined);
});

test("delete status messages keep the original text readable", () => {
  const originalText = "Saved movie.mp4 to /downloads/movie.mp4 (100 B)";

  assert.equal(createDeleteConfirmationStatusMessage(originalText), `${originalText}\n\nDelete this downloaded file?`);
  assert.equal(createDeletedStatusMessage(originalText, "/downloads/movie.mp4"), `${originalText}\n\nDeleted file: /downloads/movie.mp4`);
  assert.equal(
    createDeleteFailedStatusMessage(originalText, "/downloads/movie.mp4", "permission denied"),
    `${originalText}\n\nCould not delete file: /downloads/movie.mp4\npermission denied`,
  );
  assert.equal(
    createMoveToKidsConfirmationStatusMessage(originalText, "Movies/Demo Movie", "Kids/Movies/Demo Movie"),
    `${originalText}\n\nMove this to Kids?\nMovies/Demo Movie\n→\nKids/Movies/Demo Movie`,
  );
  assert.equal(
    stripStatusConfirmationSuffix(`${originalText}\n\nMove this to Kids?\nMovies/Demo Movie\n→\nKids/Movies/Demo Movie`),
    originalText,
  );
  assert.equal(stripStatusConfirmationSuffix(`${originalText}\n\nDelete this downloaded file?`), originalText);
});

test("delete button state persists records across instances", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "movie.mp4");
    const firstState = DeleteButtonState.forStateDirectory(dir);
    const record = await firstState.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });

    const secondState = DeleteButtonState.forStateDirectory(dir);
    const restored = await secondState.get(record.token);

    assert.equal(restored?.filePath, filePath);
    assert.equal(restored?.chatId, 1234);
    assert.equal(restored?.messageId, 99);
  });
});

test("delete button state serializes concurrent saves", async () => {
  await withTempDir(async (dir) => {
    const state = DeleteButtonState.forStateDirectory(dir);
    const records = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        state.upsertForStatus({
          chatId: 1234,
          messageId: index,
          filePath: path.join(dir, `movie-${index}.mp4`),
          originalText: `Saved movie-${index}.mp4`,
        }),
      ),
    );

    const restored = DeleteButtonState.forStateDirectory(dir);
    const restoredRecords = await Promise.all(records.map((record) => restored.get(record.token)));

    assert.deepEqual(
      restoredRecords.map((record) => record?.messageId).sort((left, right) => (left ?? 0) - (right ?? 0)),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
  });
});

test("deleteDownloadedFile deletes only files inside the download directory", async () => {
  await withTempDir(async (dir) => {
    const outputPath = path.join(dir, "Movies", "movie.mp4");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "downloaded", "utf8");

    assert.equal(await deleteDownloadedFile(outputPath, dir), "deleted");
    await assert.rejects(stat(outputPath));
    assert.equal(await deleteDownloadedFile(outputPath, dir), "missing");
    assert.equal(isPathInsideDirectory(outputPath, dir), true);
    assert.equal(isPathInsideDirectory(path.join(path.dirname(dir), "outside.mp4"), dir), false);
    await assert.rejects(deleteDownloadedFile(path.join(path.dirname(dir), "outside.mp4"), dir), /outside/);
  });
});

test("deleteDownloadedFile prunes empty nested directories after deleting the last file", async () => {
  await withTempDir(async (dir) => {
    const outputPath = path.join(dir, "TV Shows", "Show", "Season 01", "4.mkv");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "downloaded", "utf8");

    assert.equal(await deleteDownloadedFile(outputPath, dir), "deleted");
    await assert.rejects(stat(path.join(dir, "TV Shows", "Show", "Season 01")));
    await assert.rejects(stat(path.join(dir, "TV Shows", "Show")));
    await stat(path.join(dir, "TV Shows"));
  });
});

test("resolveLibraryItemRelativePath picks movie/show folders and Undefined files", () => {
  assert.equal(resolveLibraryItemRelativePath("Movies/Demo Movie/Demo Movie.mkv"), path.join("Movies", "Demo Movie"));
  assert.equal(
    resolveLibraryItemRelativePath("TV Shows/Demo Show/Season 01/ep.mkv"),
    path.join("TV Shows", "Demo Show"),
  );
  assert.equal(resolveLibraryItemRelativePath("Undefined/clip.mp4"), path.join("Undefined", "clip.mp4"));
  assert.equal(resolveLibraryItemRelativePath("Kids/Movies/Demo"), undefined);
  assert.equal(resolveLibraryItemRelativePath("Movies"), undefined);
});

test("moveDownloadedPathToKids moves the library item folder under Kids", async () => {
  await withTempDir(async (dir) => {
    const filmDir = path.join(dir, "Movies", "Demo Movie");
    const outputPath = path.join(filmDir, "Demo Movie.mkv");
    await mkdir(filmDir, { recursive: true });
    await writeFile(outputPath, "downloaded", "utf8");

    const result = await moveDownloadedPathToKids(outputPath, dir);

    assert.equal(result.outcome, "moved");
    assert.equal(result.sourceRelativePath?.split(path.sep).join("/"), "Movies/Demo Movie");
    assert.equal(result.targetRelativePath?.split(path.sep).join("/"), "Kids/Movies/Demo Movie");
    await assert.rejects(stat(filmDir));
    await stat(path.join(dir, "Kids", "Movies", "Demo Movie", "Demo Movie.mkv"));

    const conflict = await moveDownloadedPathToKids(
      path.join(dir, "Movies", "Demo Movie", "Demo Movie.mkv"),
      dir,
    );
    assert.equal(conflict.outcome, "missing");

    await mkdir(path.join(dir, "Movies", "Demo Movie"), { recursive: true });
    await writeFile(path.join(dir, "Movies", "Demo Movie", "Demo Movie.mkv"), "again", "utf8");
    const exists = await moveDownloadedPathToKids(path.join(dir, "Movies", "Demo Movie", "Demo Movie.mkv"), dir);
    assert.equal(exists.outcome, "target-exists");
  });
});
