import { loadSettings, redactSettings } from "../config/settings.js";

async function main(): Promise<void> {
  const settings = await loadSettings();
  console.log("Settings are valid:");
  console.log(JSON.stringify(redactSettings(settings), null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
