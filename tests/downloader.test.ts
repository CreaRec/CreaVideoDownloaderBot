import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDownloadCanceled, TelegramDownloader, type DownloadProgress } from "../src/downloader.js";
import type { PlexMetadata } from "../src/media-metadata.js";
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
          allowedUserIds: [1234, 5678],
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

test("start fails when allowed users are missing GramJS sessions", async () => {
  const downloader = new TelegramDownloader(
    createSettings({
      telegram: {
        allowedUserIds: [1234, 5678],
        userSessions: {
          "1234": "owner-session",
        },
      },
    }),
    createLoggerSpy(),
    createMetadataService({ kind: "undefined", reason: "unknown" }) as never,
  );

  await assert.rejects(downloader.start(), /Missing GramJS sessions for Telegram user IDs: 5678/);
});

function createStartedDownloader(options: {
  downloadDirectory: string;
  metadata: PlexMetadata;
  client: FakeClient;
  overwriteExisting?: boolean;
  telegramUserId?: number;
}): TelegramDownloader {
  const telegramUserId = options.telegramUserId ?? 1234;
  const downloader = new TelegramDownloader(
    createSettings({
      download: {
        directory: options.downloadDirectory,
        overwriteExisting: options.overwriteExisting ?? false,
      },
      telegram: {
        allowedUserIds: [telegramUserId],
        userSessions: {
          [String(telegramUserId)]: "session",
        },
      },
    }),
    createLoggerSpy(),
    createMetadataService(options.metadata) as never,
  );

  Object.assign(downloader as unknown as { userClients: Map<number, { client: FakeClient; botEntity: unknown }> }, {
    userClients: new Map([[telegramUserId, { client: options.client, botEntity: { id: "bot" } }]]),
  });

  return downloader;
}

function createMetadataService(metadata: PlexMetadata) {
  return {
    resolveMetadata: async () => metadata,
    buildOutputPath: (resolvedMetadata: PlexMetadata, rootDirectory: string, fallbackFileName: string, extension: string) => {
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
    async getMessages() {
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
  getMessages: () => Promise<FakeMessage | FakeMessage[] | undefined>;
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
