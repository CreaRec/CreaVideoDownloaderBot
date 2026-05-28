import { readFile, writeFile } from "node:fs/promises";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getSettingsPath, loadSettings } from "./settings.js";

async function main(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = await loadSettings(settingsPath);
  const stringSession = new StringSession(settings.telegram.stringSession);
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
    };
  };

  settingsJson.telegram = {
    ...settingsJson.telegram,
    stringSession: session,
  };

  await writeFile(settingsPath, `${JSON.stringify(settingsJson, null, 2)}\n`, "utf8");
  await client.disconnect();

  console.log(`GramJS session saved to ${settingsPath}. Keep this file private.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
