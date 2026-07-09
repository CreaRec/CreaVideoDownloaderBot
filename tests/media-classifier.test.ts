import { writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { MediaClassifier } from "../src/media-classifier.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

test("classify returns undefined without an OpenAI API key", async () => {
  const classifier = new MediaClassifier(createSettings(), createLoggerSpy());

  const result = await classifier.classify({ fileName: "movie.mp4" });

  assert.deepEqual(result, { kind: "undefined", reason: "OpenAI API key is not configured." });
});

test("classifier honors an instructionsPath override", () => {
  const overridePath = "/custom/instructions.md";
  const classifier = new MediaClassifier(createSettings(), createLoggerSpy(), overridePath);

  assert.equal(classifier.getInstructionsPath(), overridePath);
});

test("classify sends the configured request and normalizes a film response", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "instructions.md");
    await writeFile(instructionsPath, "Classify media.", "utf8");

    const fetchMock = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "film",
                title: "The Movie",
                year: 2010,
                season: null,
                episode: null,
                episodeTitle: null,
                confidence: 0.95,
                reason: "Matched movie title.",
              }),
            },
          },
        ],
      }),
      init,
    }));

    const classifier = new MediaClassifier(
      createSettings({
        openai: {
          apiKey: "key",
          model: "test-model",
          instructionsPath,
        },
      }),
      createLoggerSpy(),
    );

    const result = await classifier.classify({ fileName: "movie.mp4", description: "A movie" });
    const request = JSON.parse(fetchMock.mock.calls[0].arguments[1]?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };

    assert.deepEqual(result, { kind: "film", title: "The Movie", year: 2010 });
    assert.equal(fetchMock.mock.calls[0].arguments[0], "https://api.openai.com/v1/chat/completions");
    assert.equal(fetchMock.mock.calls[0].arguments[1]?.headers?.["Authorization"], "Bearer key");
    assert.equal(request.model, "test-model");
    assert.equal(request.messages[0].content, "Classify media.");
    assert.deepEqual(JSON.parse(request.messages[1].content), {
      filename: "movie.mp4",
      description: "A movie",
    });
  });
});

test("classify normalizes a TV show response", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "instructions.md");
    await writeFile(instructionsPath, "Classify media.", "utf8");
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "tv_show",
                title: "The Show",
                year: 2008,
                season: 2,
                episode: 7,
                episodeTitle: "Episode Title",
                confidence: 0.91,
                reason: "Matched episode pattern.",
              }),
            },
          },
        ],
      }),
    }));

    const classifier = new MediaClassifier(
      createSettings({ openai: { apiKey: "key", instructionsPath } }),
      createLoggerSpy(),
    );

    const result = await classifier.classify({ fileName: "show.s02e07.mp4" });

    assert.deepEqual(result, {
      kind: "tv_show",
      title: "The Show",
      year: 2008,
      season: 2,
      episode: 7,
      episodeTitle: "Episode Title",
    });
  });
});

test("classify falls back on low confidence or incomplete metadata", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "instructions.md");
    await writeFile(instructionsPath, "Classify media.", "utf8");
    const responses = [
      {
        kind: "film",
        title: "Maybe",
        year: null,
        season: null,
        episode: null,
        episodeTitle: null,
        confidence: 0.2,
        reason: "Unsure.",
      },
      {
        kind: "tv_show",
        title: "Missing Episode",
        year: null,
        season: 1,
        episode: null,
        episodeTitle: null,
        confidence: 0.9,
        reason: "Incomplete.",
      },
    ];

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      }),
    }));

    const classifier = new MediaClassifier(
      createSettings({ openai: { apiKey: "key", instructionsPath } }),
      createLoggerSpy(),
    );

    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Unsure." });
    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Incomplete." });
  });
});

test("classify logs and falls back for malformed model responses", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "instructions.md");
    await writeFile(instructionsPath, "Classify media.", "utf8");
    const logger = createLoggerSpy();
    const responses = ["not-json", JSON.stringify({ kind: "film", confidence: 2, reason: "bad" })];

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: responses.shift() } }],
      }),
    }));

    const classifier = new MediaClassifier(
      createSettings({ openai: { apiKey: "key", instructionsPath } }),
      logger,
    );

    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Classifier request failed." });
    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Classifier returned invalid JSON shape." });
    assert.equal(logger.entries.filter((entry) => entry.level === "warn").length, 2);
  });
});

test("classify falls back for missing content, HTTP errors, and fetch failures", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "instructions.md");
    await writeFile(instructionsPath, "Classify media.", "utf8");
    const responses = [
      {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: {} }] }),
      },
      {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "rate limited" } }),
      },
      new Error("network down"),
    ];

    mock.method(globalThis, "fetch", async () => {
      const response = responses.shift();

      if (response instanceof Error) {
        throw response;
      }

      return response;
    });

    const classifier = new MediaClassifier(
      createSettings({ openai: { apiKey: "key", instructionsPath } }),
      createLoggerSpy(),
    );

    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Classifier request failed." });
    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Classifier request failed." });
    assert.deepEqual(await classifier.classify({}), { kind: "undefined", reason: "Classifier request failed." });
  });
});
