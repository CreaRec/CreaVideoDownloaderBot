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

  assert.equal(markup.reply_markup.inline_keyboard.length, 4);
  const pickButton = markup.reply_markup.inline_keyboard[0]?.[0];
  const cancelButton = markup.reply_markup.inline_keyboard[3]?.[0];
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
      candidates: [],
      expiresAt: Date.now() - 1,
    });
    assert.equal(handlers.getPendingFixPickForTests("token-1"), undefined);

    handlers.setPendingFixPickForTests(1, "token-2", {
      relativePath: "Movies/Demo",
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
    searchCandidates?: (input: unknown) => Promise<unknown[]>;
    searchMixedCandidates?: (input: unknown) => Promise<unknown[]>;
    findCandidatesByImdbId?: (imdbId: string) => Promise<unknown[]>;
    resolveCandidateById: (kind: string, tmdbId: number) => Promise<unknown>;
  };
  hintParser?: {
    parse: (input: unknown) => Promise<unknown>;
    guessTitleFromFilename?: (fileName: string) => Promise<{ title: string; year?: number } | undefined>;
  };
  renamer?: {
    renameFolder?: (folderPath: string, resolved: unknown) => Promise<{ renamed: unknown[]; skipped: unknown[] }>;
    renameItem?: (itemPath: string, resolved: unknown, episode?: unknown) => Promise<{ renamed: unknown[]; skipped: unknown[] }>;
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
      async searchMixedCandidates() {
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
      async guessTitleFromFilename() {
        return undefined;
      },
    }) as never,
    (options.renamer ?? {
      async renameFolder() {
        return { renamed: [], skipped: [] };
      },
      async renameItem() {
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
        async searchMixedCandidates() {
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
    assert.equal(replies[0]?.message, "Ищу варианты в TMDB…");
    assert.match(replies[1]?.message ?? "", /Выберите правильный тайтл/);
    assert.match(replies[1]?.message ?? "", /Поиск: Inception \(2010\)/);
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
    assert.match(replies[1]?.message ?? "", /Выберите правильный тайтл/);
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

    assert.equal(replies[0], "Ищу варианты в TMDB…");
    assert.equal(replies[1], "В TMDB нет совпадений для IMDb ID tt0000001.");
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

    assert.equal(replies[0], "Ищу варианты в TMDB…");
    assert.match(replies[1] ?? "", /В TMDB ничего не найдено по запросу «\?\?\?»/);
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
        async searchMixedCandidates() {
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

    assert.match(replies[1] ?? "", /В TMDB ничего не найдено по запросу «Unknown Show»/);
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

    assert.deepEqual(answers, ["Сессия выбора истекла."]);
  });
});

test("handleMetadataFixButton cancel clears the pick and edits the message", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const edits: string[] = [];
    const handlers = createHandlers({ tempDir });
    handlers.setPendingFixPickForTests(1234, "tok", {
      relativePath: "Movies/Demo",
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

    assert.deepEqual(edits, ["Исправление метаданных отменено."]);
    assert.deepEqual(answers, ["Отменено."]);
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
        async renameItem() {
          const target = path.join(tempDir, "Movies", "Inception (2010)", "Inception (2010).mkv");
          return {
            renamed: [{ from: path.join(folderPath, "a.mkv"), to: target }],
            skipped: [],
          };
        },
      },
    });
    handlers.setPendingFixPickForTests(1234, "tok", {
      relativePath: "Movies/Demo",
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

    assert.deepEqual(answers, ["Применяю…"]);
    assert.match(edits[0] ?? "", /Перенёс в Movies\/Inception \(2010\)/);
    assert.match(edits[0] ?? "", /как Inception \(2010\)/);
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

    assert.deepEqual(answers, ["Для этого файла нельзя исправить метаданные."]);
  });
});

test("startMetadataFix auto-presents TMDB candidates from the file name", async () => {
  await withTempDir(async (tempDir) => {
    const answers: string[] = [];
    const replies: Array<{ message: string; extra?: unknown }> = [];
    const handlers = createHandlers({
      tempDir,
      fileTree: {
        getRelativePathForToken: () => "Undefined/Испанский_английский_Перевод_1_Провайдер_2q480.mp4",
        canFixMetadata: () => true,
      },
      tmdbResolver: {
        async searchMixedCandidates() {
          return [{ kind: "film", tmdbId: 687, title: "Spanglish", year: 2004, score: 120 }];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });

    await handlers.startMetadataFix(
      {
        from: { id: 1234 },
        reply: async (message: string, extra?: unknown) => {
          replies.push({ message, extra });
          return { message_id: replies.length };
        },
        answerCbQuery: async (message: string) => {
          answers.push(message);
        },
      } as never,
      "file-token",
    );

    assert.deepEqual(answers, ["Ищу в TMDB…"]);
    assert.match(replies[0]?.message ?? "", /Исправление метаданных: Undefined\//);
    assert.match(replies[1]?.message ?? "", /Выберите правильный тайтл/);
    assert.match(replies[1]?.message ?? "", /Автопоиск/);
    assert.ok(replies[1]?.extra);
    assert.equal(handlers.getPendingFixHintForTests(1234), undefined);
  });
});

test("startMetadataFix uses an LLM filename guess before presenting candidates", async () => {
  await withTempDir(async (tempDir) => {
    const replies: Array<{ message: string; extra?: unknown }> = [];
    let searchCalls = 0;
    const handlers = createHandlers({
      tempDir,
      fileTree: {
        getRelativePathForToken: () => "Undefined/Испанский_английский.mp4",
        canFixMetadata: () => true,
      },
      hintParser: {
        async parse() {
          return { kind: "undefined", reason: "unused" };
        },
        async guessTitleFromFilename() {
          return { title: "Spanglish", year: 2004 };
        },
      },
      tmdbResolver: {
        async searchMixedCandidates(input: { query?: string }) {
          searchCalls += 1;
          if (input.query === "Spanglish") {
            return [{ kind: "film", tmdbId: 687, title: "Spanglish", year: 2004, score: 120 }];
          }
          return [];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });

    await handlers.startMetadataFix(
      {
        from: { id: 1234 },
        reply: async (message: string, extra?: unknown) => {
          replies.push({ message, extra });
          return { message_id: replies.length };
        },
        answerCbQuery: async () => undefined,
      } as never,
      "file-token",
    );

    assert.ok(searchCalls >= 1);
    assert.match(replies[1]?.message ?? "", /Угадывание: Spanglish \(2004\)/);
    assert.ok(replies[1]?.extra);
  });
});

test("startMetadataFix falls back to manual hint when auto search finds nothing", async () => {
  await withTempDir(async (tempDir) => {
    const replies: string[] = [];
    const handlers = createHandlers({
      tempDir,
      fileTree: {
        getRelativePathForToken: () => "Movies/Demo",
        canFixMetadata: () => true,
      },
      tmdbResolver: {
        async searchMixedCandidates() {
          return [];
        },
        async resolveCandidateById() {
          return undefined;
        },
      },
    });

    await handlers.startMetadataFix(
      {
        from: { id: 1234 },
        reply: async (message: string) => {
          replies.push(message);
          return { message_id: replies.length };
        },
        answerCbQuery: async () => undefined,
      } as never,
      "folder-token",
    );

    assert.match(replies[1] ?? "", /В TMDB ничего не найдено по названию из файла/);
    assert.match(replies[1] ?? "", /IMDb/);
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
