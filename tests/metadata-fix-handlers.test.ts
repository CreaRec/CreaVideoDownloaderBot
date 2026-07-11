import assert from "node:assert/strict";
import { test } from "node:test";
import { FileTreeBrowser } from "../src/file-tree.js";
import {
  createCandidateReplyMarkup,
  FIX_META_CALLBACK_PREFIX,
  formatCandidateLabel,
  MetadataFixHandlers,
  parseFixMetaCallbackData,
} from "../src/metadata-fix-handlers.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

test("parseFixMetaCallbackData parses pick and cancel actions", () => {
  assert.deepEqual(parseFixMetaCallbackData(`${FIX_META_CALLBACK_PREFIX}:pick:abc123:42`), {
    action: "pick",
    token: "abc123",
    tmdbId: 42,
  });
  assert.deepEqual(parseFixMetaCallbackData(`${FIX_META_CALLBACK_PREFIX}:cancel:abc123`), {
    action: "cancel",
    token: "abc123",
  });
  assert.equal(parseFixMetaCallbackData(`${FIX_META_CALLBACK_PREFIX}:pick:abc123:nope`), undefined);
  assert.equal(parseFixMetaCallbackData("file-delete:ask:abc123"), undefined);
  assert.equal(parseFixMetaCallbackData(undefined), undefined);
});

test("createCandidateReplyMarkup builds pick rows and a cancel button", () => {
  const markup = createCandidateReplyMarkup("tok", [
    { kind: "film", tmdbId: 1, title: "Inception", year: 2010, score: 10 },
    { kind: "film", tmdbId: 2, title: "Other", score: 1 },
  ]);

  assert.equal(markup.reply_markup.inline_keyboard.length, 3);
  assert.equal(markup.reply_markup.inline_keyboard[0]?.[0]?.callback_data, `${FIX_META_CALLBACK_PREFIX}:pick:tok:1`);
  assert.equal(markup.reply_markup.inline_keyboard[2]?.[0]?.callback_data, `${FIX_META_CALLBACK_PREFIX}:cancel:tok`);
});

test("formatCandidateLabel truncates long labels to 64 characters", () => {
  const label = formatCandidateLabel({
    kind: "tv_show",
    tmdbId: 9,
    title: "A".repeat(80),
    year: 2020,
    score: 1,
  });

  assert.equal(label.length, 64);
  assert.ok(label.endsWith("..."));
});

test("pending fix hint and pick sessions expire after TTL", async () => {
  await withTempDir(async (tempDir) => {
    const settings = createSettings({ downloadDirectory: tempDir, stateDirectory: tempDir });
    const handlers = new MetadataFixHandlers(
      settings,
      createLoggerSpy(),
      new FileTreeBrowser(tempDir),
      {} as never,
      {} as never,
      {} as never,
    );

    handlers.setPendingFixHintForTests(1, "Movies/Demo", Date.now() - 1);
    assert.equal(handlers.getPendingFixHintForTests(1), undefined);

    handlers.setPendingFixHintForTests(1, "Movies/Demo", Date.now() + 60_000);
    assert.equal(handlers.getPendingFixHintForTests(1)?.relativePath, "Movies/Demo");

    handlers.setPendingFixPickForTests(1, "token-1", {
      relativePath: "Movies/Demo",
      kind: "film",
      candidates: [],
      expiresAt: Date.now() - 1,
    });
    assert.equal(handlers.getPendingFixPickForTests("token-1"), undefined);

    handlers.setPendingFixPickForTests(1, "token-2", {
      relativePath: "Movies/Demo",
      kind: "film",
      candidates: [{ kind: "film", tmdbId: 7, title: "Demo", score: 1 }],
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(handlers.getPendingFixPickForTests("token-2")?.candidates[0]?.tmdbId, 7);
  });
});
