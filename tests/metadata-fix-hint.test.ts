import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { MetadataFixHintParser } from "../src/metadata-fix-hint.js";
import { createLoggerSpy, createSettings, withTempDir } from "./helpers/test-utils.js";

afterEach(() => {
  mock.restoreAll();
});

test("parse returns undefined without an OpenAI API key", async () => {
  const parser = new MetadataFixHintParser(createSettings(), createLoggerSpy());

  const result = await parser.parse({ folderName: "Wrong Name", text: "Inception 2010" });

  assert.deepEqual(result, { kind: "undefined", reason: "OpenAI API key is not configured." });
});

test("parse extracts a film hint from text", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "hint-instructions.md");
    await writeFile(instructionsPath, "Extract the title.", "utf8");

    const fetchMock = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "film",
                title: "Inception",
                year: 2010,
                confidence: 0.96,
                reason: "User text names the film.",
              }),
            },
          },
        ],
      }),
      init,
    }));

    const parser = new MetadataFixHintParser(
      createSettings({
        openai: {
          apiKey: "key",
          model: "test-model",
          instructionsPath: path.join(dir, "unused.md"),
        },
      }),
      createLoggerSpy(),
      instructionsPath,
    );

    const result = await parser.parse({ folderName: "Wrong Folder", text: "Inception 2010" });
    const request = JSON.parse(fetchMock.mock.calls[0].arguments[1]?.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    assert.deepEqual(result, { kind: "film", title: "Inception", year: 2010 });
    assert.equal(request.messages[0].content, "Extract the title.");
    assert.deepEqual(request.messages[1].content, [
      {
        type: "text",
        text: JSON.stringify({
          folderName: "Wrong Folder",
          text: "Inception 2010",
          hasImage: false,
        }),
      },
    ]);
  });
});

test("parse includes screenshot bytes as an image_url part", async () => {
  await withTempDir(async (dir) => {
    const instructionsPath = path.join(dir, "hint-instructions.md");
    await writeFile(instructionsPath, "Extract the title.", "utf8");

    const fetchMock = mock.method(globalThis, "fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "tv_show",
                title: "Breaking Bad",
                year: 2008,
                confidence: 0.91,
                reason: "Poster text identifies the show.",
              }),
            },
          },
        ],
      }),
    }));

    const parser = new MetadataFixHintParser(
      createSettings({
        openai: {
          apiKey: "key",
          model: "test-model",
          instructionsPath: path.join(dir, "unused.md"),
        },
      }),
      createLoggerSpy(),
      instructionsPath,
    );

    const result = await parser.parse({
      folderName: "Unknown Show",
      image: { mimeType: "image/png", data: Buffer.from("fake-image") },
    });
    const request = JSON.parse(fetchMock.mock.calls[0].arguments[1]?.body as string) as {
      messages: Array<{ role: string; content: Array<{ type: string; image_url?: { url: string } }> }>;
    };

    assert.deepEqual(result, { kind: "tv_show", title: "Breaking Bad", year: 2008 });
    assert.equal(request.messages[1].content[1]?.type, "image_url");
    assert.match(request.messages[1].content[1]?.image_url?.url ?? "", /^data:image\/png;base64,/);
  });
});
