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
  deleteDownloadedFile,
  DeleteButtonState,
  isPathInsideDirectory,
  parseDeleteCallbackData,
} from "../src/delete-buttons.js";
import { withTempDir } from "./helpers/test-utils.js";

test("delete button callback data is parsed from generated markup", () => {
  const deleteMarkup = createDeleteButtonReplyMarkup("abc123");
  const confirmMarkup = createDeleteConfirmationReplyMarkup("abc123");

  assert.deepEqual(parseDeleteCallbackData(deleteMarkup.reply_markup.inline_keyboard[0][0].callback_data), {
    action: "ask",
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
});

test("delete button state persists records across instances", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "movie.mp4");
    const firstState = DeleteButtonState.forDownloadDirectory(dir);
    const record = await firstState.upsertForStatus({
      chatId: 1234,
      messageId: 99,
      filePath,
      originalText: "Saved movie.mp4",
    });

    const secondState = DeleteButtonState.forDownloadDirectory(dir);
    const restored = await secondState.get(record.token);

    assert.equal(restored?.filePath, filePath);
    assert.equal(restored?.chatId, 1234);
    assert.equal(restored?.messageId, 99);
  });
});

test("deleteDownloadedFile deletes only files inside the download directory", async () => {
  await withTempDir(async (dir) => {
    const outputPath = path.join(dir, "Film", "movie.mp4");
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
