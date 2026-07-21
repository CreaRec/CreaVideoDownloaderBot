import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { configPath, projectRoot } from "./paths.js";

const settingsSchema = z.object({
  telegram: z.object({
    apiId: z.number().int().positive(),
    apiHash: z.string().min(1),
    userSessions: z.record(z.string(), z.string()).default({}),
    botToken: z.string().min(1),
    botUsername: z.string().min(1).regex(/^[A-Za-z0-9_]+$/, {
      message: "Use the bot username without @.",
    }),
  }),
  download: z.object({
    directory: z.string().min(1),
    overwriteExisting: z.boolean().default(false),
  }),
  openai: z
    .object({
      apiKey: z.string().optional(),
      adminApiKey: z.string().optional(),
      model: z.string().min(1).default("gpt-4o-mini"),
      instructionsPath: z.string().min(1).default(configPath("media-classification-instructions.md")),
      usageStartDate: z.string().optional(),
    })
    .default({
      model: "gpt-4o-mini",
      instructionsPath: configPath("media-classification-instructions.md"),
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

type ParsedSettings = z.infer<typeof settingsSchema>;

export type Settings = Omit<ParsedSettings, "telegram"> & {
  telegram: Omit<ParsedSettings["telegram"], "userSessions"> & {
    userSessions: Record<string, string>;
  };
};

export interface LoadSettingsOptions {
  requireSessions?: boolean;
}

export function getSettingsPath(): string {
  if (process.env.SETTINGS_PATH) {
    return path.resolve(process.env.SETTINGS_PATH);
  }

  return configPath("settings.json");
}

export async function loadSettings(
  settingsPath = getSettingsPath(),
  options: LoadSettingsOptions = {},
): Promise<Settings> {
  const requireSessions = options.requireSessions ?? true;
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

  const userSessions = { ...parsedSettings.data.telegram.userSessions };

  if (requireSessions && !hasConfiguredUserSessions(userSessions)) {
    throw new Error(
      "No GramJS user sessions configured. Run npm run login -- --user-id <telegram_user_id> for each user.",
    );
  }

  const { userSessions: _rawUserSessions, ...telegram } = parsedSettings.data.telegram;

  return {
    ...parsedSettings.data,
    telegram: {
      ...telegram,
      userSessions,
    },
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

export function getUserSessionUserIds(userSessions: Record<string, string>): number[] {
  return Object.keys(userSessions)
    .map((userId) => Number(userId))
    .filter((userId) => Number.isInteger(userId));
}

export function getUserSession(settings: Settings, userId: number): string | undefined {
  const session = settings.telegram.userSessions[String(userId)];

  return session && session.length > 0 ? session : undefined;
}

export function isConfiguredUser(settings: Settings, userId: number): boolean {
  return getUserSession(settings, userId) !== undefined;
}

export function getConfiguredUserSessions(settings: Settings): Array<{ userId: number; session: string }> {
  return Object.entries(settings.telegram.userSessions)
    .map(([userId, session]) => {
      if (!session) {
        return undefined;
      }

      const parsedUserId = Number(userId);

      if (!Number.isInteger(parsedUserId)) {
        return undefined;
      }

      return { userId: parsedUserId, session };
    })
    .filter((entry): entry is { userId: number; session: string } => entry !== undefined);
}

export function redactSettings(settings: Settings): Record<string, unknown> {
  const redactedUserSessions = Object.fromEntries(
    Object.entries(settings.telegram.userSessions).map(([userId, session]) => [userId, session ? "***" : ""]),
  );

  return {
    ...settings,
    telegram: {
      ...settings.telegram,
      apiHash: "***",
      botToken: "***",
      userSessions: redactedUserSessions,
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

function hasConfiguredUserSessions(userSessions: Record<string, string>): boolean {
  return Object.values(userSessions).some((session) => session.length > 0);
}
