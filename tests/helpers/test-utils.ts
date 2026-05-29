import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../src/logger.js";
import type { Settings } from "../../src/settings.js";

export function createSettings(overrides: PartialSettings = {}): Settings {
  const base: Settings = {
    telegram: {
      apiId: 123456,
      apiHash: "api-hash",
      stringSession: "",
      botToken: "123:bot-token",
      botUsername: "test_bot",
      allowedUserIds: [1234],
    },
    download: {
      directory: path.join(os.tmpdir(), "telegram-video-tests"),
      overwriteExisting: false,
    },
    openai: {
      apiKey: "",
      model: "gpt-4o-mini",
      instructionsPath: path.join(os.tmpdir(), "telegram-video-instructions.md"),
    },
    app: {
      logLevel: "debug",
    },
  };

  return {
    ...base,
    ...overrides,
    telegram: {
      ...base.telegram,
      ...overrides.telegram,
    },
    download: {
      ...base.download,
      ...overrides.download,
    },
    openai: {
      ...base.openai,
      ...overrides.openai,
    },
    app: {
      ...base.app,
      ...overrides.app,
    },
  };
}

export function createLoggerSpy(): LoggerSpy {
  const entries: LoggerEntry[] = [];

  return {
    entries,
    debug(message: string, details?: unknown): void {
      entries.push({ level: "debug", message, details });
    },
    info(message: string, details?: unknown): void {
      entries.push({ level: "info", message, details });
    },
    warn(message: string, details?: unknown): void {
      entries.push({ level: "warn", message, details });
    },
    error(message: string, details?: unknown): void {
      entries.push({ level: "error", message, details });
    },
  } as LoggerSpy;
}

export async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "telegram-video-test-"));

  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface LoggerEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details?: unknown;
}

export type LoggerSpy = Logger & {
  entries: LoggerEntry[];
};

type PartialSettings = {
  [Key in keyof Settings]?: Partial<Settings[Key]>;
};
