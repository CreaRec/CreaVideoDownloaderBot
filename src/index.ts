import { BotService } from "./bot.js";
import { TelegramDownloader } from "./downloader.js";
import { Logger } from "./logger.js";
import { MediaMetadataService } from "./media-metadata.js";
import { loadSettings } from "./settings.js";

async function main(): Promise<void> {
  const settings = await loadSettings();
  const logger = new Logger(settings.app.logLevel);
  const mediaMetadataService = new MediaMetadataService(settings, logger);
  const downloader = new TelegramDownloader(settings, logger, mediaMetadataService);
  const bot = new BotService(settings, downloader, logger);

  await downloader.start();
  await bot.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info(`Received ${signal}; shutting down.`);

    await Promise.allSettled([bot.stop(signal), downloader.stop()]);
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
