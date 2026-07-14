import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { FileTreeBrowser } from "../src/files/file-tree.js";
import {
  createCandidateReplyMarkup,
  FIX_META_CALLBACK_PREFIX,
  formatCandidateLabel,
  MetadataFixHandlers,
  parseFixMetaCallbackData,
} from "../src/bot/metadata-fix-handlers.js";
import {
  BOT_HELP_MESSAGE,
  BOT_PRIVATE_MESSAGE,
  createMainReplyKeyboard,
  FILES_BUTTON_TEXT,
} from "../src/telegram/telegram-ctx.js";
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
  const pickButton = markup.reply_markup.inline_keyboard[0]?.[0];
  const cancelButton = markup.reply_markup.inline_keyboard[2]?.[0];
  assert.ok(pickButton && "callback_data" in pickButton);
  assert.ok(cancelButton && "callback_data" in cancelButton);
  assert.equal(pickButton.callback_data, `${FIX_META_CALLBACK_PREFIX}:pick:tok:1`);
  assert.equal(cancelButton.callback_data, `${FIX_META_CALLBACK_PREFIX}:cancel:tok`);
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
    const settings = createSettings({
      download: { directory: tempDir },
      app: { stateDirectory: tempDir },
    });
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

function createHandlers(options: {
  tempDir: string;
  fileTree?: {
    getRelativePathForToken: (token: string) => string;
    canFixMetadata: (relativePath: string) => boolean;
    resolveAbsolutePath?: (relativePath: string) => string;
  };
  tmdbResolver?: {
    searchCandidates: (input: unknown) => Promise<unknown[]>;
    findCandidatesByImdbId?: (imdbId: string) => Promise<unknown[]>;
    resolveCandidateById: (kind: string, tmdbId: number) => Promise<unknown>;
  };
  hintParser?: {
    parse: (input: unknown) => Promise<unknown>;
  };
  renamer?: {
    renameFolder: (folderPath: string, resolved: unknown) => Promise<{ renamed: unknown[]; skipped: unknown[] }>;
  };
}): MetadataFixHandlers {
  const settings = createSettings({
    download: { directory: options.tempDir },
    app: { stateDirectory: options.tempDir },
  });

  return new MetadataFixHandlers(
    settings,
    createLoggerSpy(),
    (options.fileTree ?? new FileTreeBrowser(options.tempDir)) as never,
    (options.tmdbResolver ?? {
      async searchCandidates() {
        return [];
      },
      async findCandidatesByImdbId() {
        return [];
      },
      async resolveCandidateById() {
        return undefined;
      },
    }) as never,
    (options.hintParser ?? {
      async parse() {
        return { kind: "undefined", reason: "no hint" };
      },
    }) as never,
    (options.renamer ?? {
      async renameFolder() {
        return { renamed: [], skipped: [] };
      },
    }) as never,
  );
}

test("tryHandleMetadataFixText returns false without a pending hint", async () => {
  await withTempDir(async (tempDir) => {
    const handlers = createHandlers({ tempDir });
    const handled = await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "Inception" },
      reply: async () => ({ message_id: 1 }),
    } as never);

    assert.equal(handled, false);
  });
});

test("tryHandleMetadataFixText skips Files button text and keeps the pending hint", async () => {
  await withTempDir(async (tempDir) => {
    const handlers = createHandlers({ tempDir });
    handlers.setPendingFixHintForTests(1234, "Movies/Demo");

    const handled = await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: FILES_BUTTON_TEXT },
      reply: async () => ({ message_id: 1 }),
    } as never);

    assert.equal(handled, false);
    assert.equal(handlers.getPendingFixHintForTests(1234)?.relativePath, "Movies/Demo");
  });
});

test("tryHandleMetadataFixText processes a title hint and shows candidates", async () => {
  await withTempDir(async (tempDir) => {
    const replies: Array<{ message: string; extra?: unknown }> = [];
    const handlers = createHandlers({
      tempDir,
      hintParser: {
        async parse() {
          return { kind: "film", title: "Inception", year: 2010 };
        },
      },
      tmdbResolver: {
        async searchCandidates() {
          return [{ kind: "film", tmdbId: 1, title: "Inception", year: 2010, score: 10 }];
        },
        async findCandidatesByImdbId() {
          throw new Error("IMDb lookup should not run for title hints");
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });
    handlers.setPendingFixHintForTests(1234, "Movies/Demo");

    const handled = await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "Inception 2010" },
      reply: async (message: string, extra?: unknown) => {
        replies.push({ message, extra });
        return { message_id: replies.length };
      },
    } as never);

    assert.equal(handled, true);
    assert.equal(handlers.getPendingFixHintForTests(1234), undefined);
    assert.equal(replies[0]?.message, "Looking up TMDB matches...");
    assert.match(replies[1]?.message ?? "", /Choose the correct film/);
    assert.match(replies[1]?.message ?? "", /Search: Inception \(2010\)/);
    assert.ok(replies[1]?.extra);
  });
});

test("tryHandleMetadataFixText looks up an IMDb URL without calling the hint parser", async () => {
  await withTempDir(async (tempDir) => {
    const replies: Array<{ message: string; extra?: unknown }> = [];
    let hintParserCalls = 0;
    const handlers = createHandlers({
      tempDir,
      hintParser: {
        async parse() {
          hintParserCalls += 1;
          return { kind: "undefined", reason: "should not run" };
        },
      },
      tmdbResolver: {
        async searchCandidates() {
          throw new Error("Title search should not run for IMDb ids");
        },
        async findCandidatesByImdbId(imdbId: string) {
          assert.equal(imdbId, "tt27200708");
          return [{ kind: "film", tmdbId: 99, title: "Mother Mary", year: 2026, score: 1 }];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });
    handlers.setPendingFixHintForTests(1234, "Movies/Wrong Folder");

    const handled = await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "https://www.imdb.com/title/tt27200708/" },
      reply: async (message: string, extra?: unknown) => {
        replies.push({ message, extra });
        return { message_id: replies.length };
      },
    } as never);

    assert.equal(handled, true);
    assert.equal(hintParserCalls, 0);
    assert.match(replies[1]?.message ?? "", /Choose the correct film/);
    assert.match(replies[1]?.message ?? "", /IMDb: tt27200708/);
    assert.ok(replies[1]?.extra);
  });
});

test("tryHandleMetadataFixText looks up a bare IMDb id", async () => {
  await withTempDir(async (tempDir) => {
    const replies: Array<{ message: string; extra?: unknown }> = [];
    const handlers = createHandlers({
      tempDir,
      tmdbResolver: {
        async searchCandidates() {
          return [];
        },
        async findCandidatesByImdbId(imdbId: string) {
          assert.equal(imdbId, "tt1375666");
          return [{ kind: "film", tmdbId: 27205, title: "Inception", year: 2010, score: 1 }];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });
    handlers.setPendingFixHintForTests(1234, "Movies/Demo");

    await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "tt1375666" },
      reply: async (message: string, extra?: unknown) => {
        replies.push({ message, extra });
        return { message_id: replies.length };
      },
    } as never);

    assert.match(replies[1]?.message ?? "", /IMDb: tt1375666/);
  });
});

test("tryHandleMetadataFixText reports when an IMDb id has no TMDB match", async () => {
  await withTempDir(async (tempDir) => {
    const replies: string[] = [];
    const handlers = createHandlers({
      tempDir,
      tmdbResolver: {
        async searchCandidates() {
          return [];
        },
        async findCandidatesByImdbId() {
          return [];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });
    handlers.setPendingFixHintForTests(1234, "Movies/Demo");

    await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "tt0000001" },
      reply: async (message: string) => {
        replies.push(message);
        return { message_id: replies.length };
      },
    } as never);

    assert.equal(replies[0], "Looking up TMDB matches...");
    assert.equal(replies[1], "No TMDB match found for IMDb ID tt0000001.");
  });
});

test("tryHandleMetadataFixText reports when the correction cannot be understood", async () => {
  await withTempDir(async (tempDir) => {
    const replies: string[] = [];
    const handlers = createHandlers({
      tempDir,
      hintParser: {
        async parse() {
          return { kind: "undefined", reason: "unclear screenshot" };
        },
      },
    });
    handlers.setPendingFixHintForTests(1234, "Movies/Demo");

    await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "???" },
      reply: async (message: string) => {
        replies.push(message);
        return { message_id: replies.length };
      },
    } as never);

    assert.equal(replies[0], "Looking up TMDB matches...");
    assert.match(replies[1] ?? "", /Could not understand the correction: unclear screenshot/);
  });
});

test("tryHandleMetadataFixText reports when no TMDB matches are found", async () => {
  await withTempDir(async (tempDir) => {
    const replies: string[] = [];
    const handlers = createHandlers({
      tempDir,
      hintParser: {
        async parse() {
          return { kind: "tv_show", title: "Unknown Show", year: 1999 };
        },
      },
      tmdbResolver: {
        async searchCandidates() {
          return [];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });
    handlers.setPendingFixHintForTests(1234, "Series/Demo");

    await handlers.tryHandleMetadataFixText({
      from: { id: 1234 },
      message: { text: "Unknown Show" },
      reply: async (message: string) => {
        replies.push(message);
        return { message_id: replies.length };
      },
    } as never);

    assert.match(replies[1] ?? "", /No TMDB matches found for TV show "Unknown Show" \(1999\)/);
  });
});

test("handleMetadataFixButton rejects unauthorized users", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const handlers = createHandlers({ tempDir });

    await handlers.handleMetadataFixButton({
      from: { id: 999 },
      callbackQuery: { data: `${FIX_META_CALLBACK_PREFIX}:cancel:tok` },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.deepEqual(answers, [BOT_PRIVATE_MESSAGE]);
  });
});

test("handleMetadataFixButton rejects expired pick tokens", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const handlers = createHandlers({ tempDir });
    handlers.setPendingFixPickForTests(1234, "tok", {
      relativePath: "Movies/Demo",
      kind: "film",
      candidates: [{ kind: "film", tmdbId: 1, title: "Demo", score: 1 }],
      expiresAt: Date.now() - 1,
    });

    await handlers.handleMetadataFixButton({
      from: { id: 1234 },
      callbackQuery: { data: `${FIX_META_CALLBACK_PREFIX}:cancel:tok` },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.deepEqual(answers, ["Fix selection is no longer available."]);
  });
});

test("handleMetadataFixButton cancel clears the pick and edits the message", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const edits: string[] = [];
    const handlers = createHandlers({ tempDir });
    handlers.setPendingFixPickForTests(1234, "tok", {
      relativePath: "Movies/Demo",
      kind: "film",
      candidates: [{ kind: "film", tmdbId: 1, title: "Demo", score: 1 }],
    });

    await handlers.handleMetadataFixButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `${FIX_META_CALLBACK_PREFIX}:cancel:tok`,
        message: { message_id: 50, chat: { id: 1234 }, text: "Choose a match" },
      },
      telegram: {
        editMessageText: async (_chatId: number, _messageId: number, _inline: undefined, text: string) => {
          edits.push(text);
        },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.deepEqual(edits, ["Metadata fix cancelled."]);
    assert.deepEqual(answers, ["Cancelled."]);
    assert.equal(handlers.getPendingFixPickForTests("tok"), undefined);
  });
});

test("handleMetadataFixButton pick applies rename and shows a summary", async () => {
  await withTempDir(async (tempDir) => {
    const folderPath = path.join(tempDir, "Movies", "Demo");
    await mkdir(folderPath, { recursive: true });
    const answers: string[] = [];
    const edits: string[] = [];
    const handlers = createHandlers({
      tempDir,
      fileTree: {
        getRelativePathForToken: () => "Movies/Demo",
        canFixMetadata: () => true,
        resolveAbsolutePath: () => folderPath,
      },
      tmdbResolver: {
        async searchCandidates() {
          return [];
        },
        async resolveCandidateById() {
          return { kind: "film", title: "Inception", year: 2010, tmdbId: 1 };
        },
      },
      renamer: {
        async renameFolder() {
          return {
            renamed: [{ from: path.join(folderPath, "a.mkv"), to: "Inception (2010).mkv" }],
            skipped: [{ path: path.join(folderPath, "note.txt"), reason: "unsupported" }],
          };
        },
      },
    });
    handlers.setPendingFixPickForTests(1234, "tok", {
      relativePath: "Movies/Demo",
      kind: "film",
      candidates: [{ kind: "film", tmdbId: 1, title: "Inception", year: 2010, score: 10 }],
    });

    await handlers.handleMetadataFixButton({
      from: { id: 1234 },
      callbackQuery: {
        data: `${FIX_META_CALLBACK_PREFIX}:pick:tok:1`,
        message: { message_id: 50, chat: { id: 1234 }, text: "Choose a match" },
      },
      telegram: {
        editMessageText: async (_chatId: number, _messageId: number, _inline: undefined, text: string) => {
          edits.push(text);
        },
      },
      answerCbQuery: async (message: string) => {
        answers.push(message);
      },
    } as never);

    assert.deepEqual(answers, ["Applying metadata..."]);
    assert.match(edits[0] ?? "", /Applied film: Inception \(2010\)/);
    assert.match(edits[0] ?? "", /Renamed: 1/);
    assert.match(edits[0] ?? "", /Skipped: 1/);
    assert.match(edits[0] ?? "", /a\.mkv → Inception \(2010\)\.mkv/);
  });
});

test("startMetadataFix rejects folders that cannot be fixed", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const handlers = createHandlers({
      tempDir,
      fileTree: {
        getRelativePathForToken: () => "",
        canFixMetadata: () => false,
      },
    });

    await handlers.startMetadataFix(
      {
        from: { id: 1234 },
        reply: async () => ({ message_id: 1 }),
        answerCbQuery: async (message: string) => {
          answers.push(message);
        },
      } as never,
      "root-token",
    );

    assert.deepEqual(answers, ["This folder cannot be fixed."]);
  });
});

test("startMetadataFix seeds a pending hint and asks for a correction", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const replies: string[] = [];
    const handlers = createHandlers({
      tempDir,
      fileTree: {
        getRelativePathForToken: () => "Movies/Demo",
        canFixMetadata: () => true,
      },
    });

    await handlers.startMetadataFix(
      {
        from: { id: 1234 },
        reply: async (message: string) => {
          replies.push(message);
          return { message_id: 1 };
        },
        answerCbQuery: async (message: string) => {
          answers.push(message);
        },
      } as never,
      "folder-token",
    );

    assert.match(replies[0] ?? "", /Fix metadata for folder: Movies\/Demo/);
    assert.match(replies[0] ?? "", /IMDb link\/ID/);
    assert.deepEqual(answers, ["Send a correction hint."]);
    assert.equal(handlers.getPendingFixHintForTests(1234)?.relativePath, "Movies/Demo");
  });
});

test("handleMetadataFixPhoto without pending hint replies with help and keyboard", async () => {
  await withTempDir(async (tempDir) => {
    const replies: Array<{ message: string; extra?: unknown }> = [];
    const handlers = createHandlers({ tempDir });

    await handlers.handleMetadataFixPhoto({
      from: { id: 1234 },
      message: { photo: [{ file_id: "photo-1" }] },
      reply: async (message: string, extra?: unknown) => {
        replies.push({ message, extra });
        return { message_id: 1 };
      },
    } as never);

    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.message, BOT_HELP_MESSAGE);
    assert.deepEqual(replies[0]?.extra, createMainReplyKeyboard());
  });
});
