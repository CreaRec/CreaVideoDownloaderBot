#!/usr/bin/env tsx
import { access, copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Logger } from "../src/logger.js";
import { buildLegacyFallbackFileName } from "../src/media-metadata.js";
import { createMigrationMetadataService, isMigrationVideoFile } from "../src/migration-metadata.js";
import { loadSettings } from "../src/settings.js";

interface CliOptions {
  source: string;
  dest: string;
  dryRun: boolean;
  noEnrich: boolean;
}

interface MigrationSummary {
  copied: number;
  skipped: number;
  ignored: number;
  errors: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const settings = await loadSettings();
  const logger = new Logger(settings.app.logLevel);
  const { metadataService, migrationResolver } = createMigrationMetadataService(settings, logger);
  const summary: MigrationSummary = { copied: 0, skipped: 0, ignored: 0, errors: 0 };

  const sourceRoot = path.resolve(options.source);
  const destRoot = path.resolve(options.dest);

  logger.info(`Migrating from ${sourceRoot} to ${destRoot}`, {
    dryRun: options.dryRun,
    noEnrich: options.noEnrich,
  });

  for await (const sourcePath of walkFiles(sourceRoot)) {
    const relativePath = path.relative(sourceRoot, sourcePath);

    if (!isMigrationVideoFile(sourcePath)) {
      summary.ignored += 1;
      continue;
    }

    try {
      const extension = path.extname(sourcePath) || ".bin";
      const fallbackFileName = buildLegacyFallbackFileName(path.basename(sourcePath));
      const metadata = await migrationResolver.resolve(relativePath, options.noEnrich);
      const destPath = metadataService.buildOutputPath(metadata, destRoot, fallbackFileName, extension);

      if (options.dryRun) {
        console.log(`${sourcePath} -> ${destPath}`);
        continue;
      }

      if (await exists(destPath)) {
        logger.info(`SKIP existing destination: ${destPath}`);
        summary.skipped += 1;
        continue;
      }

      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
      logger.info(`COPIED ${sourcePath} -> ${destPath}`);
      summary.copied += 1;
    } catch (error) {
      summary.errors += 1;
      logger.error(`Failed to migrate ${sourcePath}`, error);
    }
  }

  console.log(
    JSON.stringify(
      {
        source: sourceRoot,
        dest: destRoot,
        dryRun: options.dryRun,
        noEnrich: options.noEnrich,
        ...summary,
      },
      null,
      2,
    ),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    source: "/mnt/synology/video/bot",
    dest: "/mnt/synology/video",
    dryRun: false,
    noEnrich: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--source") {
      options.source = args[index + 1] ?? options.source;
      index += 1;
      continue;
    }

    if (arg === "--dest") {
      options.dest = args[index + 1] ?? options.dest;
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--no-enrich") {
      options.noEnrich = true;
      continue;
    }
  }

  return options;
}

async function* walkFiles(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
      continue;
    }

    if (entry.isFile()) {
      const fileStat = await stat(entryPath);

      if (fileStat.isFile()) {
        yield entryPath;
      }
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
