import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getSettingsPath, getUserSession, getUserSessionUserIds, loadSettings } from "./settings.js";

export function parseLoginUserId(argv: string[], configuredUserIds: number[]): number {
  const userIdIndex = argv.indexOf("--user-id");

  if (userIdIndex !== -1) {
    const rawUserId = argv[userIdIndex + 1];

    if (!rawUserId || rawUserId.startsWith("-")) {
      throw new Error("Missing value for --user-id. Usage: npm run login -- --user-id <telegram_user_id>");
    }

    const userId = Number(rawUserId);

    if (!Number.isInteger(userId)) {
      throw new Error(`Invalid --user-id value: ${rawUserId}`);
    }

    return userId;
  }

  if (configuredUserIds.length === 1) {
    return configuredUserIds[0];
  }

  if (configuredUserIds.length === 0) {
    throw new Error("Missing --user-id. Usage: npm run login -- --user-id <telegram_user_id>");
  }

  throw new Error("Multiple users are configured in telegram.userSessions. Specify --user-id.");
}

async function main(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = await loadSettings(settingsPath, { requireSessions: false });
  const configuredUserIds = getUserSessionUserIds(settings.telegram.userSessions);
  const userId = parseLoginUserId(process.argv.slice(2), configuredUserIds);
  const existingSession = getUserSession(settings, userId) ?? "";
  const stringSession = new StringSession(existingSession);
  const client = new TelegramClient(stringSession, settings.telegram.apiId, settings.telegram.apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => input.text("Telegram phone number: "),
    password: async () => input.password("Two-step verification password, if enabled: "),
    phoneCode: async () => input.text("Telegram login code: "),
    onError: (error) => {
      console.error(error);
    },
  });

  const session = stringSession.save();

  if (!session) {
    throw new Error("Telegram login succeeded but no string session was produced.");
  }

  const rawSettings = await readFile(settingsPath, "utf8");
  const settingsJson = JSON.parse(rawSettings) as {
    telegram?: {
      stringSession?: string;
      userSessions?: Record<string, string>;
    };
  };

  const userSessions = {
    ...settingsJson.telegram?.userSessions,
    [String(userId)]: session,
  };

  settingsJson.telegram = {
    ...settingsJson.telegram,
    userSessions,
  };

  delete settingsJson.telegram.stringSession;

  await writeFile(settingsPath, `${JSON.stringify(settingsJson, null, 2)}\n`, "utf8");
  await client.disconnect();

  console.log(`GramJS session saved for user ${userId} in ${settingsPath}. Keep this file private.`);
}

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
