import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "../config/logger.js";
import type { Settings } from "../config/settings.js";

const MIN_CONFIDENCE = 0.7;

const modelResponseSchema = z.object({
  kind: z.enum(["film", "tv_show", "undefined"]),
  title: z.string().nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  season: z.number().int().positive().nullable(),
  episode: z.number().int().positive().nullable(),
  episodeTitle: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type MediaClassification =
  | {
      kind: "film";
      title: string;
      year?: number;
    }
  | {
      kind: "tv_show";
      title: string;
      year?: number;
      season: number;
      episode: number;
      episodeTitle?: string;
    }
  | {
      kind: "undefined";
      reason: string;
    };

export interface MediaClassificationInput {
  fileName?: string;
  description?: string;
}

export class MediaClassifier {
  private instructions?: Promise<string>;

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
  ) {}

  async classify(input: MediaClassificationInput): Promise<MediaClassification> {
    if (!this.settings.openai.apiKey) {
      return { kind: "undefined", reason: "OpenAI API key is not configured." };
    }

    try {
      const response = await this.callOpenAI(input);
      const parsed = modelResponseSchema.safeParse(JSON.parse(response));

      if (!parsed.success) {
        this.logger.warn("OpenAI media classification response did not match the expected schema.", parsed.error.issues);
        return { kind: "undefined", reason: "Classifier returned invalid JSON shape." };
      }

      return normalizeClassification(parsed.data);
    } catch (error) {
      this.logger.warn("OpenAI media classification failed; saving as undefined.", error);
      return { kind: "undefined", reason: "Classifier request failed." };
    }
  }

  private async callOpenAI(input: MediaClassificationInput): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.openai.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: await this.getInstructions(),
          },
          {
            role: "user",
            content: JSON.stringify({
              filename: input.fileName ?? null,
              description: input.description ?? null,
            }),
          },
        ],
      }),
    });

    const body = (await response.json()) as unknown;

    if (!response.ok) {
      throw new Error(`OpenAI request failed with status ${response.status}: ${getErrorMessage(body)}`);
    }

    const content = getCompletionContent(body);

    if (!content) {
      throw new Error("OpenAI response did not include message content.");
    }

    return content;
  }

  private getInstructions(): Promise<string> {
    this.instructions ??= readFile(this.settings.openai.instructionsPath, "utf8");
    return this.instructions;
  }
}

type ModelResponse = z.infer<typeof modelResponseSchema>;

function normalizeClassification(response: ModelResponse): MediaClassification {
  if (response.confidence < MIN_CONFIDENCE) {
    return { kind: "undefined", reason: response.reason || "Classifier confidence was too low." };
  }

  if (response.kind === "film" && response.title) {
    return {
      kind: "film",
      title: response.title,
      year: response.year ?? undefined,
    };
  }

  if (response.kind === "tv_show" && response.title && response.season && response.episode) {
    return {
      kind: "tv_show",
      title: response.title,
      year: response.year ?? undefined,
      season: response.season,
      episode: response.episode,
      episodeTitle: response.episodeTitle ?? undefined,
    };
  }

  return { kind: "undefined", reason: response.reason || "Classifier did not identify all required metadata." };
}

function getCompletionContent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("choices" in value) || !Array.isArray(value.choices)) {
    return undefined;
  }

  const [choice] = value.choices;

  if (typeof choice !== "object" || choice === null || !("message" in choice)) {
    return undefined;
  }

  const message = choice.message;

  if (typeof message !== "object" || message === null || !("content" in message)) {
    return undefined;
  }

  return typeof message.content === "string" ? message.content : undefined;
}

function getErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return "unknown error";
  }

  const error = value.error;

  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "unknown error";
  }

  return typeof error.message === "string" ? error.message : "unknown error";
}
