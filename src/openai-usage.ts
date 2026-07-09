import type { Logger } from "./logger.js";
import type { Settings } from "./settings.js";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const SECONDS_PER_DAY = 24 * 60 * 60;

export interface OpenAIUsageReporter {
  createReport(rangeArg?: string): Promise<string>;
}

interface UsageTimeRange {
  label: string;
  startTime: number;
  endTime: number;
}

interface UsageSummary {
  range: UsageTimeRange;
  totalCost: number;
  currency: string;
  totalRequests: number;
}

interface OpenAIPage {
  data?: unknown[];
  has_more?: boolean;
  next_page?: string | null;
}

export class OpenAIUsageService implements OpenAIUsageReporter {
  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async createReport(rangeArg?: string): Promise<string> {
    if (!this.settings.openai.adminApiKey) {
      return "OpenAI usage is not configured. Set openai.adminApiKey in config/settings.json.";
    }

    try {
      const range = createUsageTimeRange(rangeArg, this.settings.openai.usageStartDate);
      const [costs, totalRequests] = await Promise.all([this.fetchCosts(range), this.fetchCompletionRequests(range)]);
      return formatOpenAIUsageReport({
        range,
        totalCost: costs.totalCost,
        currency: costs.currency,
        totalRequests,
      });
    } catch (error) {
      this.logger.warn("Failed to fetch OpenAI usage.", error);
      return "Could not fetch OpenAI usage right now. Check the logs for details.";
    }
  }

  private async fetchCosts(range: UsageTimeRange): Promise<{ totalCost: number; currency: string }> {
    let totalCost = 0;
    let currency = "usd";

    for await (const bucket of this.fetchPagedBuckets("/organization/costs", range)) {
      for (const result of getBucketResults(bucket)) {
        const amount = getObjectProperty(result, "amount");
        const value = getNumberProperty(amount, "value") ?? 0;
        const resultCurrency = getStringProperty(amount, "currency");

        totalCost += value;
        currency = resultCurrency ?? currency;
      }
    }

    return { totalCost, currency };
  }

  private async fetchCompletionRequests(range: UsageTimeRange): Promise<number> {
    let totalRequests = 0;

    for await (const bucket of this.fetchPagedBuckets("/organization/usage/completions", range)) {
      for (const result of getBucketResults(bucket)) {
        totalRequests += getNumberProperty(result, "num_model_requests") ?? 0;
      }
    }

    return totalRequests;
  }

  private async *fetchPagedBuckets(pathName: string, range: UsageTimeRange): AsyncGenerator<unknown> {
    let page: string | undefined;

    do {
      const response = await this.fetchOpenAIPage(pathName, range, page);

      for (const bucket of response.data ?? []) {
        yield bucket;
      }

      page = response.has_more && response.next_page ? response.next_page : undefined;
    } while (page);
  }

  private async fetchOpenAIPage(pathName: string, range: UsageTimeRange, page?: string): Promise<OpenAIPage> {
    const url = new URL(`${OPENAI_API_BASE_URL}${pathName}`);

    url.searchParams.set("start_time", String(range.startTime));
    url.searchParams.set("end_time", String(range.endTime));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");

    if (page) {
      url.searchParams.set("page", page);
    }

    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.settings.openai.adminApiKey}`,
      },
    });
    const body = (await response.json()) as unknown;

    if (!response.ok) {
      throw new Error(`OpenAI usage request failed with status ${response.status}: ${getErrorMessage(body)}`);
    }

    if (typeof body !== "object" || body === null) {
      throw new Error("OpenAI usage response was not an object.");
    }

    return body as OpenAIPage;
  }
}

export function createUsageTimeRange(rangeArg: string | undefined, configuredStartDate: string | undefined, now = new Date()): UsageTimeRange {
  const normalizedRangeArg = rangeArg?.trim().toLowerCase();
  const endTime = Math.floor(now.getTime() / 1_000);

  if (normalizedRangeArg === "today") {
    return {
      label: "Today",
      startTime: toUnixSeconds(startOfUtcDay(now)),
      endTime,
    };
  }

  if (normalizedRangeArg === "month") {
    return {
      label: "Month to date",
      startTime: toUnixSeconds(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      endTime,
    };
  }

  if (configuredStartDate) {
    return {
      label: "Full configured range",
      startTime: toUnixSeconds(parseUtcDate(configuredStartDate)),
      endTime,
    };
  }

  return {
    label: "Month to date",
    startTime: toUnixSeconds(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    endTime,
  };
}

export function formatOpenAIUsageReport(summary: UsageSummary): string {
  const costPerRequest = summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : undefined;

  return [
    `OpenAI usage (${summary.range.label})`,
    `Time range: ${formatDateTime(summary.range.startTime)} to ${formatDateTime(summary.range.endTime)}`,
    `Total requests: ${summary.totalRequests.toLocaleString("en-US")}`,
    `Total cost: ${formatCurrency(summary.totalCost, summary.currency)}`,
    `Cost per request: ${costPerRequest === undefined ? "N/A" : formatCurrency(costPerRequest, summary.currency)}`,
  ].join("\n");
}

function getBucketResults(bucket: unknown): unknown[] {
  if (typeof bucket !== "object" || bucket === null || !("results" in bucket) || !Array.isArray(bucket.results)) {
    return [];
  }

  return bucket.results;
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }

  return (value as Record<string, unknown>)[property];
}

function getNumberProperty(value: unknown, property: string): number | undefined {
  const propertyValue = getObjectProperty(value, property);
  return typeof propertyValue === "number" && Number.isFinite(propertyValue) ? propertyValue : undefined;
}

function getStringProperty(value: unknown, property: string): string | undefined {
  const propertyValue = getObjectProperty(value, property);
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function getErrorMessage(value: unknown): string {
  const error = getObjectProperty(value, "error");
  const message = getStringProperty(error, "message");
  return message ?? "unknown error";
}

function formatCurrency(value: number, currency: string): string {
  const currencyCode = currency.toUpperCase();

  if (currencyCode === "USD") {
    return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
  }

  return `${value.toFixed(value >= 1 ? 2 : 4)} ${currencyCode}`;
}

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toISOString().replace(".000Z", "Z");
}

function parseUtcDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error("openai.usageStartDate must use YYYY-MM-DD format.");
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  if (date.toISOString().slice(0, 10) !== value) {
    throw new Error("openai.usageStartDate must be a real calendar date.");
  }

  return date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
