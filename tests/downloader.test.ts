import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDownloadCanceled, isFileReferenceError, TelegramDownloader, type DownloadProgress } from "../src/download/downloader.js";
import type { PlexMetadata } from "../src/metadata/media-metadata.js";
import { buildMoviePath, buildTvShowPath, buildUndefinedPath } from "../src/metadata/plex-paths.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

test("downloadFromBotMessage requires the downloader to be started", async () => {
  const downloader = new TelegramDownloader(
    createSettings(),
    createLoggerSpy(),
    createMetadataService({ kind: "undefined", reason: "none" }) as never,
  );

  await assert.rejects(
    downloader.downloadFromBotMessage({ botMessageId: 1, telegramUserId: 1234, mediaKind: "video" }),
    /Downloader has not been started/,
  );
});

test("downloadFromBotMessage saves classified films, avoids collisions, and reports progress", async () => {
  await withTempDir(async (dir) => {
    const initialPath = path.join(dir, "Movies", "Bad Movie", "Bad Movie.mp4");
    const existingBytes = Buffer.from("already here");
    const progressEvents: DownloadProgress[] = [];
    const outputPathEvents: string[] = [];

    await mkdir(path.dirname(initialPath), { recursive: true });
    await writeFile(initialPath, existingBytes);

    const fakeClient = createFakeClient({
      messages: [{ id: 10, media: media("MessageMediaDocument") }],
    });
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "film", title: "Bad Movie" },
      client: fakeClient,
    });

    const result = await downloader.downloadFromBotMessage({
      botMessageId: 10,
      telegramUserId: 1234,
      mediaKind: "video",
      suggestedFileName: 'bad:name?.mp4',
      onOutputPath: (outputPath) => {
        outputPathEvents.push(outputPath);
      },
      onProgress: (progress) => progressEvents.push(progress),
    });

    assert.equal(result.outputPath, path.join(dir, "Movies", "Bad Movie", "Bad Movie-1.mp4"));
    assert.deepEqual(outputPathEvents, [result.outputPath]);
    assert.equal(result.bytes, Buffer.byteLength("downloaded"));
    assert.equal((await stat(initialPath)).size, existingBytes.length);
    assert.deepEqual(progressEvents, [
      { downloadedBytes: 5, totalBytes: 10, percent: 50 },
      { downloadedBytes: 15, totalBytes: 30, percent: 50 },
    ]);
    assert.equal(fakeClient.downloadedMessage?.id, 10);
  });
});

test("downloadFromBotMessage saves TV shows and undefined classifications into expected folders", async () => {
  await withTempDir(async (dir) => {
    const tvDownloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "tv_show", title: "Show Name", season: 3, episode: 4 },
      client: createFakeClient({ messages: [{ id: 11, media: media("MessageMediaDocument") }] }),
    });
    const undefinedDownloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "undefined", reason: "unknown" },
      client: createFakeClient({ messages: [{ id: 12, media: media("MessageMediaPhoto") }] }),
    });

    const tvResult = await tvDownloader.downloadFromBotMessage({
      botMessageId: 11,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "episode.mkv",
    });
    const undefinedResult = await undefinedDownloader.downloadFromBotMessage({
      botMessageId: 12,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "bad/name?.mkv",
    });

    assert.equal(
      tvResult.outputPath,
      path.join(dir, "TV Shows", "Show Name", "Season 03", "Show Name - s03e04.mkv"),
    );
    assert.equal(undefinedResult.outputPath, path.join(dir, "Undefined", "bad_name_.mkv"));
  });
});

test("downloadFromBotMessage can overwrite existing classified output", async () => {
  await withTempDir(async (dir) => {
    const outputPath = path.join(dir, "Movies", "Same Name", "Same Name.mp4");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "old");

    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      overwriteExisting: true,
      metadata: { kind: "film", title: "Same Name" },
      client: createFakeClient({ messages: [{ id: 13, media: media("MessageMediaDocument") }] }),
    });

    const result = await downloader.downloadFromBotMessage({
      botMessageId: 13,
      telegramUserId: 1234,
      mediaKind: "video",
      suggestedFileName: "same.mp4",
    });

    assert.equal(result.outputPath, outputPath);
    assert.equal(result.bytes, Buffer.byteLength("downloaded"));
  });
});

test("downloadFromBotMessage cancels when the abort signal is triggered during progress", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "film", title: "Canceled Movie" },
      client: createFakeClient({ messages: [{ id: 14, media: media("MessageMediaDocument") }] }),
    });

    await assert.rejects(
      downloader.downloadFromBotMessage({
        botMessageId: 14,
        telegramUserId: 1234,
        mediaKind: "video",
        suggestedFileName: "canceled.mp4",
        signal: controller.signal,
        onProgress: () => {
          controller.abort();
        },
      }),
      isDownloadCanceled,
    );
  });
});

test("downloadFromBotMessage cancels before starting when the abort signal is already triggered", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    const fakeClient = createFakeClient({ messages: [{ id: 15, media: media("MessageMediaDocument") }] });
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "film", title: "Canceled Movie" },
      client: fakeClient,
    });

    controller.abort();

    await assert.rejects(
      downloader.downloadFromBotMessage({
        botMessageId: 15,
        telegramUserId: 1234,
        mediaKind: "video",
        signal: controller.signal,
      }),
      isDownloadCanceled,
    );
    assert.equal(fakeClient.downloadedMessage, undefined);
  });
});

test("downloadFromBotMessage falls back to recent outgoing bot media when direct lookup is not downloadable", async () => {
  await withTempDir(async (dir) => {
    const fakeClient = createFakeClient({
      messages: [{ id: 20 }],
      iterMessages: [
        { id: 21, media: media("MessageMediaDocument"), date: 1, message: "too old" },
        { id: 22, media: media("MessageMediaDocument"), date: 1050, message: "  Same   Caption  " },
      ],
    });
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "undefined", reason: "unknown" },
      client: fakeClient,
    });

    await downloader.downloadFromBotMessage({
      botMessageId: 20,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "fallback.bin",
      receivedAt: 1000,
      caption: "Same Caption",
    });

    assert.equal(fakeClient.downloadedMessage?.id, 22);
  });
});

test("downloadFromBotMessage fails when no downloadable media can be found", async () => {
  await withTempDir(async (dir) => {
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "undefined", reason: "unknown" },
      client: createFakeClient({
        messages: [{ id: 30 }],
        iterMessages: [{ id: 31, media: media("MessageMediaUnsupported"), date: 1000 }],
      }),
    });

    await assert.rejects(
      downloader.downloadFromBotMessage({
        botMessageId: 30,
        telegramUserId: 1234,
        mediaKind: "document",
        receivedAt: 1000,
      }),
      /Telegram message 30 does not contain downloadable media/,
    );
  });
});

test("downloadFromBotMessage routes downloads through the sender user session", async () => {
  await withTempDir(async (dir) => {
    const ownerClient = createFakeClient({ messages: [{ id: 40, media: media("MessageMediaDocument") }] });
    const otherClient = createFakeClient({ messages: [{ id: 41, media: media("MessageMediaDocument") }] });
    const downloader = new TelegramDownloader(
      createSettings({
        download: { directory: dir },
        telegram: {
          userSessions: {
            "1234": "owner-session",
            "5678": "other-session",
          },
        },
      }),
      createLoggerSpy(),
      createMetadataService({ kind: "undefined", reason: "unknown" }) as never,
    );

    Object.assign(downloader as unknown as { userClients: Map<number, { client: FakeClient; botEntity: unknown }> }, {
      userClients: new Map([
        [1234, { client: ownerClient, botEntity: { id: "bot-owner" } }],
        [5678, { client: otherClient, botEntity: { id: "bot-other" } }],
      ]),
    });

    await downloader.downloadFromBotMessage({
      botMessageId: 41,
      telegramUserId: 5678,
      mediaKind: "document",
      suggestedFileName: "other-user.bin",
    });

    assert.equal(otherClient.downloadedMessage?.id, 41);
    assert.equal(ownerClient.downloadedMessage, undefined);
  });
});

test("downloadPrepared serializes concurrent GramJS media downloads for the same user", async () => {
  await withTempDir(async (dir) => {
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    let firstDownloadStarted = false;
    let resolveFirstDownload!: () => void;
    const firstDownloadGate = new Promise<void>((resolve) => {
      resolveFirstDownload = resolve;
    });

    const fakeClient = createFakeClient({
      messages: [
        { id: 50, media: media("MessageMediaDocument") },
        { id: 51, media: media("MessageMediaDocument") },
      ],
    });
    const originalDownloadMedia = fakeClient.downloadMedia.bind(fakeClient);

    fakeClient.downloadMedia = async (message, downloadOptions) => {
      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);

      try {
        if (!firstDownloadStarted) {
          firstDownloadStarted = true;
          await firstDownloadGate;
        }

        await originalDownloadMedia(message, downloadOptions);
        await writeFile(downloadOptions.outputFile, `content-${message.id}`, "utf8");
      } finally {
        activeDownloads -= 1;
      }
    };

    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "undefined", reason: "unknown" },
      client: fakeClient,
    });

    const first = downloader.downloadFromBotMessage({
      botMessageId: 50,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "first.bin",
    });
    const second = downloader.downloadFromBotMessage({
      botMessageId: 51,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "second.bin",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(activeDownloads, 1);
    resolveFirstDownload();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(maxActiveDownloads, 1);
    assert.equal(await readFile(firstResult.outputPath, "utf8"), "content-50");
    assert.equal(await readFile(secondResult.outputPath, "utf8"), "content-51");
  });
});

test("downloadPrepared allows concurrent GramJS media downloads for different users", async () => {
  await withTempDir(async (dir) => {
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    let resolveBothReady!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      resolveBothReady = resolve;
    });
    let startedCount = 0;

    const createBlockingClient = (messageId: number): FakeClient => {
      const client = createFakeClient({
        messages: [{ id: messageId, media: media("MessageMediaDocument") }],
      });
      const originalDownloadMedia = client.downloadMedia.bind(client);

      client.downloadMedia = async (message, downloadOptions) => {
        activeDownloads += 1;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        startedCount += 1;

        if (startedCount === 2) {
          resolveBothReady();
        }

        await bothReady;

        try {
          await originalDownloadMedia(message, downloadOptions);
          await writeFile(downloadOptions.outputFile, `content-${message.id}`, "utf8");
        } finally {
          activeDownloads -= 1;
        }
      };

      return client;
    };

    const ownerClient = createBlockingClient(60);
    const otherClient = createBlockingClient(61);
    const downloader = new TelegramDownloader(
      createSettings({
        download: { directory: dir },
        telegram: {
          userSessions: {
            "1234": "owner-session",
            "5678": "other-session",
          },
        },
      }),
      createLoggerSpy(),
      createMetadataService({ kind: "undefined", reason: "unknown" }) as never,
    );

    Object.assign(downloader as unknown as { userClients: Map<number, { client: FakeClient; botEntity: unknown }> }, {
      userClients: new Map([
        [1234, { client: ownerClient, botEntity: { id: "bot-owner" } }],
        [5678, { client: otherClient, botEntity: { id: "bot-other" } }],
      ]),
    });

    const results = await Promise.all([
      downloader.downloadFromBotMessage({
        botMessageId: 60,
        telegramUserId: 1234,
        mediaKind: "document",
        suggestedFileName: "owner.bin",
      }),
      downloader.downloadFromBotMessage({
        botMessageId: 61,
        telegramUserId: 5678,
        mediaKind: "document",
        suggestedFileName: "other.bin",
      }),
    ]);

    assert.equal(maxActiveDownloads, 2);
    assert.equal(await readFile(results[0].outputPath, "utf8"), "content-60");
    assert.equal(await readFile(results[1].outputPath, "utf8"), "content-61");
  });
});

test("start fails when no GramJS sessions are configured", async () => {
  const downloader = new TelegramDownloader(
    createSettings({
      telegram: {
        userSessions: {},
      },
    }),
    createLoggerSpy(),
    createMetadataService({ kind: "undefined", reason: "unknown" }) as never,
  );

  await assert.rejects(downloader.start(), /No GramJS user sessions configured/);
});

test("prepareDownload reports existingPath when a library duplicate is found by id", async () => {
  await withTempDir(async (dir) => {
    const existing = path.join(
      dir,
      "Movies",
      "Old Title (2010) {imdb-tt1375666}",
      "Old Title (2010) {imdb-tt1375666}.mkv",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: {
        kind: "film",
        title: "Inception",
        year: 2010,
        plexIds: { imdb: "tt1375666" },
      },
      client: createFakeClient({ messages: [{ id: 50, media: media("MessageMediaDocument") }] }),
      useRealBuildOutputPath: true,
    });

    const prepared = await downloader.prepareDownload({
      botMessageId: 50,
      telegramUserId: 1234,
      mediaKind: "video",
      suggestedFileName: "inception.mkv",
    });

    assert.equal(prepared.existingPath, existing);
    assert.match(prepared.canonicalPath, /Inception \(2010\) \{imdb-tt1375666\}/);
  });
});

test("downloadPrepared replace deletes the existing duplicate then writes the canonical path", async () => {
  await withTempDir(async (dir) => {
    const existing = path.join(
      dir,
      "Movies",
      "Old Title (2010) {imdb-tt1375666}",
      "Old Title (2010) {imdb-tt1375666}.mkv",
    );
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "old");

    const fakeClient = createFakeClient({ messages: [{ id: 51, media: media("MessageMediaDocument") }] });
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: {
        kind: "film",
        title: "Inception",
        year: 2010,
        plexIds: { imdb: "tt1375666" },
      },
      client: fakeClient,
      useRealBuildOutputPath: true,
    });

    const prepared = await downloader.prepareDownload({
      botMessageId: 51,
      telegramUserId: 1234,
      mediaKind: "video",
      suggestedFileName: "inception.mkv",
    });
    const result = await downloader.downloadPrepared(
      prepared,
      {
        botMessageId: 51,
        telegramUserId: 1234,
        mediaKind: "video",
        suggestedFileName: "inception.mkv",
      },
      "replace",
    );

    assert.equal(result.outputPath, prepared.canonicalPath);
    await assert.rejects(stat(existing), /ENOENT/);
    assert.equal((await stat(result.outputPath)).size, Buffer.byteLength("downloaded"));
    assert.equal(fakeClient.downloadedMessage?.id, 51);
  });
});

test("downloadPrepared keep both leaves the existing file and writes a unique path", async () => {
  await withTempDir(async (dir) => {
    const canonical = path.join(
      dir,
      "Movies",
      "Inception (2010) {imdb-tt1375666}",
      "Inception (2010) {imdb-tt1375666}.mkv",
    );
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(canonical, "old");

    const fakeClient = createFakeClient({ messages: [{ id: 52, media: media("MessageMediaDocument") }] });
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: {
        kind: "film",
        title: "Inception",
        year: 2010,
        plexIds: { imdb: "tt1375666" },
      },
      client: fakeClient,
      useRealBuildOutputPath: true,
    });

    const prepared = await downloader.prepareDownload({
      botMessageId: 52,
      telegramUserId: 1234,
      mediaKind: "video",
      suggestedFileName: "inception.mkv",
    });
    const result = await downloader.downloadPrepared(
      prepared,
      {
        botMessageId: 52,
        telegramUserId: 1234,
        mediaKind: "video",
        suggestedFileName: "inception.mkv",
      },
      "keep",
    );

    assert.equal(prepared.existingPath, canonical);
    assert.equal(
      result.outputPath,
      path.join(dir, "Movies", "Inception (2010) {imdb-tt1375666}", "Inception (2010) {imdb-tt1375666}-1.mkv"),
    );
    assert.equal((await stat(canonical)).size, Buffer.byteLength("old"));
    assert.equal((await stat(result.outputPath)).size, Buffer.byteLength("downloaded"));
  });
});

test("downloadPrepared rejects skip choice", async () => {
  await withTempDir(async (dir) => {
    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "film", title: "Movie" },
      client: createFakeClient({ messages: [{ id: 53, media: media("MessageMediaDocument") }] }),
    });
    const prepared = await downloader.prepareDownload({
      botMessageId: 53,
      telegramUserId: 1234,
      mediaKind: "video",
    });

    await assert.rejects(
      downloader.downloadPrepared(prepared, { botMessageId: 53, telegramUserId: 1234, mediaKind: "video" }, "skip"),
      /Cannot download after skip choice/,
    );
  });
});

test("downloadPrepared re-fetches the bot message after waiting in the exclusive queue", async () => {
  await withTempDir(async (dir) => {
    const staleMessage = { id: 70, media: media("MessageMediaDocument"), fileReference: "stale" };
    const freshMessage = { id: 70, media: media("MessageMediaDocument"), fileReference: "fresh" };
    const messagesById = new Map<number, FakeMessage>([
      [69, { id: 69, media: media("MessageMediaDocument") }],
      [70, staleMessage],
    ]);
    let resolveFirstDownload!: () => void;
    const firstDownloadGate = new Promise<void>((resolve) => {
      resolveFirstDownload = resolve;
    });
    let firstDownloadStarted = false;

    const fakeClient = createFakeClient();
    fakeClient.getMessages = async (_entity, params) => {
      const requestedId = Array.isArray(params?.ids) ? params?.ids[0] : params?.ids;
      return requestedId === undefined ? undefined : messagesById.get(requestedId);
    };

    const originalDownloadMedia = fakeClient.downloadMedia.bind(fakeClient);
    fakeClient.downloadMedia = async (message, downloadOptions) => {
      if (!firstDownloadStarted) {
        firstDownloadStarted = true;
        await firstDownloadGate;
      }

      await originalDownloadMedia(message, downloadOptions);
    };

    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "undefined", reason: "unknown" },
      client: fakeClient,
    });

    const first = downloader.downloadFromBotMessage({
      botMessageId: 69,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "first.bin",
    });
    const prepared = await downloader.prepareDownload({
      botMessageId: 70,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "queued.bin",
    });
    assert.equal((prepared.message as { fileReference?: string }).fileReference, "stale");

    // Telegram rotates the file reference while this item waits behind the active download.
    messagesById.set(70, freshMessage);

    const second = downloader.downloadPrepared(prepared, {
      botMessageId: 70,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "queued.bin",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveFirstDownload();
    await Promise.all([first, second]);

    assert.equal(fakeClient.downloadedMessage, freshMessage);
    assert.equal((fakeClient.downloadedMessage as { fileReference?: string }).fileReference, "fresh");
  });
});

test("downloadPrepared retries once after FILE_REFERENCE_EXPIRED", async () => {
  await withTempDir(async (dir) => {
    const staleMessage = { id: 71, media: media("MessageMediaDocument"), fileReference: "stale" };
    const freshMessage = { id: 71, media: media("MessageMediaDocument"), fileReference: "fresh" };
    let downloadAttempts = 0;
    let getMessagesCalls = 0;

    const fakeClient = createFakeClient({ messages: [staleMessage] });
    fakeClient.getMessages = async () => {
      getMessagesCalls += 1;
      return getMessagesCalls === 1 ? staleMessage : freshMessage;
    };
    fakeClient.downloadMedia = async (message, downloadOptions) => {
      downloadAttempts += 1;
      fakeClient.downloadedMessage = message;

      if (downloadAttempts === 1) {
        const error = new Error("RPCError: 400: FILE_REFERENCE_EXPIRED (caused by upload.GetFile)");
        Object.assign(error, { code: 400, errorMessage: "FILE_REFERENCE_EXPIRED" });
        throw error;
      }

      await writeFile(downloadOptions.outputFile, "downloaded", "utf8");
    };

    const downloader = createStartedDownloader({
      downloadDirectory: dir,
      metadata: { kind: "undefined", reason: "unknown" },
      client: fakeClient,
    });

    const result = await downloader.downloadFromBotMessage({
      botMessageId: 71,
      telegramUserId: 1234,
      mediaKind: "document",
      suggestedFileName: "retry.bin",
    });

    assert.equal(downloadAttempts, 2);
    assert.equal(fakeClient.downloadedMessage, freshMessage);
    assert.equal(await readFile(result.outputPath, "utf8"), "downloaded");
  });
});

test("isFileReferenceError detects GramJS FILE_REFERENCE errors", () => {
  assert.equal(isFileReferenceError({ errorMessage: "FILE_REFERENCE_EXPIRED" }), true);
  assert.equal(isFileReferenceError({ message: "FILE_REFERENCE_INVALID" }), true);
  assert.equal(isFileReferenceError(new Error("something else")), false);
});

function createStartedDownloader(options: {
  downloadDirectory: string;
  metadata: PlexMetadata;
  client: FakeClient;
  overwriteExisting?: boolean;
  telegramUserId?: number;
  useRealBuildOutputPath?: boolean;
}): TelegramDownloader {
  const telegramUserId = options.telegramUserId ?? 1234;
  const downloader = new TelegramDownloader(
    createSettings({
      download: {
        directory: options.downloadDirectory,
        overwriteExisting: options.overwriteExisting ?? false,
      },
      telegram: {
        userSessions: {
          [String(telegramUserId)]: "session",
        },
      },
    }),
    createLoggerSpy(),
    createMetadataService(options.metadata, options.useRealBuildOutputPath) as never,
  );

  Object.assign(downloader as unknown as { userClients: Map<number, { client: FakeClient; botEntity: unknown }> }, {
    userClients: new Map([[telegramUserId, { client: options.client, botEntity: { id: "bot" } }]]),
  });

  return downloader;
}

function createMetadataService(metadata: PlexMetadata, useRealBuildOutputPath = false) {
  return {
    resolveMetadata: async () => metadata,
    buildOutputPath: (resolvedMetadata: PlexMetadata, rootDirectory: string, fallbackFileName: string, extension: string) => {
      if (useRealBuildOutputPath) {
        if (resolvedMetadata.kind === "film" && resolvedMetadata.title) {
          return buildMoviePath({
            rootDirectory,
            title: resolvedMetadata.title,
            year: resolvedMetadata.year,
            extension,
            plexIds: resolvedMetadata.plexIds,
          });
        }

        if (
          resolvedMetadata.kind === "tv_show" &&
          resolvedMetadata.title &&
          resolvedMetadata.season &&
          resolvedMetadata.episode
        ) {
          return buildTvShowPath({
            rootDirectory,
            title: resolvedMetadata.title,
            year: resolvedMetadata.year,
            season: resolvedMetadata.season,
            episode: resolvedMetadata.episode,
            episodeTitle: resolvedMetadata.episodeTitle,
            extension,
            plexIds: resolvedMetadata.plexIds,
          });
        }

        return buildUndefinedPath(rootDirectory, fallbackFileName);
      }

      if (resolvedMetadata.kind === "film" && resolvedMetadata.title) {
        return path.join(rootDirectory, "Movies", resolvedMetadata.title, `${resolvedMetadata.title}${extension}`);
      }

      if (
        resolvedMetadata.kind === "tv_show" &&
        resolvedMetadata.title &&
        resolvedMetadata.season &&
        resolvedMetadata.episode
      ) {
        const season = String(resolvedMetadata.season).padStart(2, "0");
        const episode = String(resolvedMetadata.episode).padStart(2, "0");

        return path.join(
          rootDirectory,
          "TV Shows",
          resolvedMetadata.title,
          `Season ${season}`,
          `${resolvedMetadata.title} - s${season}e${episode}${extension}`,
        );
      }

      return path.join(rootDirectory, "Undefined", fallbackFileName);
    },
  };
}

function createFakeClient(options: { messages?: FakeMessage[]; iterMessages?: FakeMessage[] } = {}): FakeClient {
  const client: FakeClient = {
    downloadedMessage: undefined,
    async getMessages(_entity?: unknown, params?: { ids?: number | number[] }) {
      const requestedId = Array.isArray(params?.ids) ? params?.ids[0] : params?.ids;

      if (requestedId !== undefined && options.messages) {
        return options.messages.find((message) => message.id === requestedId) ?? options.messages[0];
      }

      return options.messages?.[0];
    },
    async *iterMessages() {
      for (const message of options.iterMessages ?? []) {
        yield message;
      }
    },
    async downloadMedia(message, downloadOptions) {
      client.downloadedMessage = message;
      await downloadOptions.progressCallback?.(5n, { toJSNumber: () => 10 });
      await downloadOptions.progressCallback?.("15", "30");
      await writeFile(downloadOptions.outputFile, "downloaded", "utf8");
    },
    async connect() {},
    async disconnect() {},
    async getEntity() {
      return { id: "bot" };
    },
  };

  return client;
}

function media(className: string): { className: string } {
  return { className };
}

interface FakeClient {
  downloadedMessage?: FakeMessage;
  getMessages: (
    entity?: unknown,
    params?: { ids?: number | number[] },
  ) => Promise<FakeMessage | FakeMessage[] | undefined>;
  iterMessages: () => AsyncGenerator<FakeMessage>;
  downloadMedia: (
    message: FakeMessage,
    options: {
      outputFile: string;
      progressCallback?: (downloaded: unknown, total: unknown) => void | Promise<void>;
    },
  ) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  getEntity: () => Promise<unknown>;
}

interface FakeMessage {
  id?: number;
  media?: unknown;
  date?: number;
  out?: boolean;
  message?: string;
}
