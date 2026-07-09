import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Logger } from "../src/logger.js";
import { loadSettings, redactSettings } from "../src/settings.js";
import { createSettings, withTempDir, writeJson } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
  delete process.env.SETTINGS_PATH;
});

test("loadSettings reads valid settings, applies defaults, and resolves paths", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");

    await writeJson(settingsPath, {
      telegram: {
        apiId: 123456,
        apiHash: "api-hash",
        stringSession: "session",
        botToken: "123:bot-token",
        botUsername: "test_bot",
        allowedUserIds: [1234],
      },
      download: {
        directory: "downloads",
      },
    });

    const settings = await loadSettings(settingsPath);

    assert.equal(settings.download.directory, path.resolve("downloads"));
    assert.equal(settings.download.overwriteExisting, false);
    assert.equal(settings.download.maxConcurrent, 3);
    assert.equal(settings.openai.apiKey, "");
    assert.equal(settings.openai.adminApiKey, "");
    assert.equal(settings.openai.model, "gpt-4o-mini");
    assert.equal(settings.tmdb.apiKey, "");
    assert.equal(settings.tmdb.language, "ru-RU");
    assert.equal(settings.app.logLevel, "info");
    assert.equal(settings.app.statusUpdateMinIntervalMs, 10_000);
    assert.equal(settings.app.statusUpdatePercentStep, 10);
    assert.equal(settings.app.statusEditMinGapMs, 300);
    assert.equal(
      settings.app.stateDirectory,
      path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "data"),
    );
    assert.equal(settings.openai.instructionsPath, path.resolve("config/media-classification-instructions.md"));
  });
});

test("loadSettings reads API keys from settings.json even when environment variables are set", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const settings = createSettings({
      openai: {
        apiKey: "from-file",
        adminApiKey: "admin-from-file",
        model: "model",
        instructionsPath: path.join(dir, "instructions.md"),
      },
      tmdb: {
        apiKey: "tmdb-from-file",
      },
    });

    process.env.OPENAI_API_KEY = "from-env";
    process.env.OPENAI_ADMIN_API_KEY = "admin-from-env";
    process.env.TMDB_API_KEY = "tmdb-from-env";
    await writeJson(settingsPath, settings);

    const loaded = await loadSettings(settingsPath);

    assert.equal(loaded.openai.apiKey, "from-file");
    assert.equal(loaded.openai.adminApiKey, "admin-from-file");
    assert.equal(loaded.tmdb.apiKey, "tmdb-from-file");
  });
});

test("getSettingsPath honors SETTINGS_PATH through loadSettings default", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "custom-settings.json");

    process.env.SETTINGS_PATH = settingsPath;
    await writeJson(settingsPath, createSettings());

    const settings = await loadSettings();

    assert.equal(settings.telegram.botUsername, "test_bot");
  });
});

test("loadSettings reports missing files, invalid JSON, and schema failures", async () => {
  await withTempDir(async (dir) => {
    const invalidJsonPath = path.join(dir, "invalid-json.json");
    const invalidSettingsPath = path.join(dir, "invalid-settings.json");

    await mkdir(path.dirname(invalidJsonPath), { recursive: true });
    await writeFile(invalidJsonPath, "{not-json", "utf8");
    await writeJson(invalidSettingsPath, {
      ...createSettings(),
      telegram: {
        ...createSettings().telegram,
        botUsername: "@bad",
      },
    });

    await assert.rejects(loadSettings(path.join(dir, "missing.json")), /Could not read settings file/);
    await assert.rejects(loadSettings(invalidJsonPath), /Settings file is not valid JSON/);
    await assert.rejects(loadSettings(invalidSettingsPath), /telegram\.botUsername: Use the bot username without @/);
  });
});

test("redactSettings masks secrets while preserving non-secret values", () => {
  const redacted = redactSettings(
    createSettings({
      telegram: {
        stringSession: "session",
      },
      openai: {
        apiKey: "openai-key",
        adminApiKey: "admin-key",
        model: "model",
        instructionsPath: "/instructions.md",
      },
      tmdb: {
        apiKey: "tmdb-key",
      },
    }),
  );

  assert.equal((redacted.telegram as Record<string, unknown>).apiHash, "***");
  assert.equal((redacted.telegram as Record<string, unknown>).botToken, "***");
  assert.equal((redacted.telegram as Record<string, unknown>).stringSession, "***");
  assert.equal((redacted.openai as Record<string, unknown>).apiKey, "***");
  assert.equal((redacted.openai as Record<string, unknown>).adminApiKey, "***");
  assert.equal((redacted.openai as Record<string, unknown>).model, "model");
  assert.equal((redacted.tmdb as Record<string, unknown>).apiKey, "***");
});

test("Logger filters below the configured level and passes details through", () => {
  const log = mock.method(console, "log", () => {});
  const logger = new Logger("warn");
  const details = { reason: "boom" };

  logger.debug("debug");
  logger.info("info");
  logger.warn("warn", details);
  logger.error("error");

  assert.equal(log.mock.callCount(), 2);
  assert.match(log.mock.calls[0].arguments[0] as string, /WARN warn$/);
  assert.equal(log.mock.calls[0].arguments[1], details);
  assert.match(log.mock.calls[1].arguments[0] as string, /ERROR error$/);
});
