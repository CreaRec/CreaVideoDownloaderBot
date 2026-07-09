import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const settingsSchema = z.object({
  telegram: z.object({
    apiId: z.number().int().positive(),
    apiHash: z.string().min(1),
    stringSession: z.string(),
    botToken: z.string().min(1),
    botUsername: z.string().min(1).regex(/^[A-Za-z0-9_]+$/, {
      message: "Use the bot username without @.",
    }),
    allowedUserIds: z.array(z.number().int()).min(1),
  }),
  download: z.object({
    directory: z.string().min(1),
    overwriteExisting: z.boolean().default(false),
    maxConcurrent: z.number().int().positive().default(3),
  }),
  openai: z
    .object({
      apiKey: z.string().optional(),
      adminApiKey: z.string().optional(),
      model: z.string().min(1).default("gpt-4o-mini"),
      instructionsPath: z.string().min(1).default(path.resolve(projectRoot, "config", "media-classification-instructions.md")),
      usageStartDate: z.string().optional(),
    })
    .default({
      model: "gpt-4o-mini",
      instructionsPath: path.resolve(projectRoot, "config", "media-classification-instructions.md"),
    }),
  tmdb: z
    .object({
      apiKey: z.string().optional(),
      language: z.string().min(1).default("ru-RU"),
    })
    .default({
      language: "ru-RU",
    }),
  app: z
    .object({
      logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
      stateDirectory: z.string().min(1).default(path.join(projectRoot, "data")),
      statusUpdateMinIntervalMs: z.number().int().positive().default(10_000),
      statusUpdatePercentStep: z.number().int().positive().max(50).default(10),
      statusEditMinGapMs: z.number().int().nonnegative().default(300),
    })
    .default({
      logLevel: "info",
      stateDirectory: path.join(projectRoot, "data"),
      statusUpdateMinIntervalMs: 10_000,
      statusUpdatePercentStep: 10,
      statusEditMinGapMs: 300,
    }),
});

export type Settings = z.infer<typeof settingsSchema>;

export function getSettingsPath(): string {
  if (process.env.SETTINGS_PATH) {
    return path.resolve(process.env.SETTINGS_PATH);
  }

  return path.resolve(projectRoot, "config", "settings.json");
}

export async function loadSettings(settingsPath = getSettingsPath()): Promise<Settings> {
  let rawSettings: string;

  try {
    rawSettings = await readFile(settingsPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read settings file at ${settingsPath}. Copy config/settings.example.json to config/settings.json and update it. ${message}`,
    );
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawSettings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Settings file is not valid JSON: ${message}`);
  }

  const parsedSettings = settingsSchema.safeParse(parsedJson);

  if (!parsedSettings.success) {
    const details = parsedSettings.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Settings validation failed: ${details}`);
  }

  return {
    ...parsedSettings.data,
    app: {
      ...parsedSettings.data.app,
      stateDirectory: path.resolve(parsedSettings.data.app.stateDirectory),
    },
    download: {
      ...parsedSettings.data.download,
      directory: path.resolve(parsedSettings.data.download.directory),
    },
    openai: {
      ...parsedSettings.data.openai,
      apiKey: parsedSettings.data.openai.apiKey ?? "",
      adminApiKey: parsedSettings.data.openai.adminApiKey ?? "",
      instructionsPath: path.resolve(parsedSettings.data.openai.instructionsPath),
    },
    tmdb: {
      ...parsedSettings.data.tmdb,
      apiKey: parsedSettings.data.tmdb.apiKey ?? "",
    },
  };
}

export function redactSettings(settings: Settings): Record<string, unknown> {
  return {
    ...settings,
    telegram: {
      ...settings.telegram,
      apiHash: "***",
      botToken: "***",
      stringSession: settings.telegram.stringSession ? "***" : "",
    },
    openai: {
      ...settings.openai,
      apiKey: settings.openai.apiKey ? "***" : "",
      adminApiKey: settings.openai.adminApiKey ? "***" : "",
    },
    tmdb: {
      ...settings.tmdb,
      apiKey: settings.tmdb.apiKey ? "***" : "",
    },
  };
}
