import type { Settings } from "./settings.js";

type LogLevel = Settings["app"]["logLevel"];

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, details?: unknown): void {
    this.write("debug", message, details);
  }

  info(message: string, details?: unknown): void {
    this.write("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.write("error", message, details);
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    if (levelWeights[level] < levelWeights[this.level]) {
      return;
    }

    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;

    if (details === undefined) {
      console.log(line);
      return;
    }

    console.log(line, details);
  }
}
