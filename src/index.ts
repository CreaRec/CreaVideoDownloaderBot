import { BotService } from "./bot/bot.js";
import { TelegramDownloader } from "./download/downloader.js";
import { Logger, logger } from "./config/logger.js";
import { MediaMetadataService } from "./metadata/media-metadata.js";
import { loadSettings } from "./config/settings.js";
import { shutdownTelemetry, startTelemetry } from "./telemetry.js";

async function main(): Promise<void> {
  const settings = await loadSettings();
  const appLogger = new Logger(settings.app.logLevel);
  startTelemetry();

  const mediaMetadataService = new MediaMetadataService(settings, appLogger);
  const downloader = new TelegramDownloader(settings, appLogger, mediaMetadataService);
  const bot = new BotService(settings, downloader, appLogger);

  await downloader.start();
  await bot.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("[app] shutting down", {
      component: "app",
      step: "shutdown",
      signal,
    });

    await Promise.allSettled([bot.stop(signal), downloader.stop()]);
    await shutdownTelemetry();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(async (error: unknown) => {
  logger.exception("[app] fatal startup error", error, {
    component: "app",
    step: "startup",
    result: "error",
  });
  try {
    await shutdownTelemetry();
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
