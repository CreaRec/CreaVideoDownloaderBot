import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "../config/logger.js";
import { configPath } from "../config/paths.js";
import type { Settings } from "../config/settings.js";

const MIN_CONFIDENCE = 0.7;
const DEFAULT_INSTRUCTIONS_PATH = configPath("metadata-fix-hint-instructions.md");

const modelResponseSchema = z.object({
  kind: z.enum(["film", "tv_show", "undefined"]),
  title: z.string().nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type MetadataFixHint =
  | {
      kind: "film" | "tv_show";
      title: string;
      year?: number;
    }
  | {
      kind: "undefined";
      reason: string;
    };

export interface MetadataFixHintInput {
  folderName: string;
  text?: string;
  image?: {
    mimeType: string;
    data: Buffer;
  };
}

const filenameGuessSchema = z.object({
  title: z.string().nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  confidence: z.number().min(0).max(1),
});

export interface FilenameTitleGuess {
  title: string;
  year?: number;
}

export class MetadataFixHintParser {
  private instructions?: Promise<string>;

  constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly instructionsPath = DEFAULT_INSTRUCTIONS_PATH,
  ) {}

  async guessTitleFromFilename(fileName: string): Promise<FilenameTitleGuess | undefined> {
    if (!this.settings.openai.apiKey) {
      return undefined;
    }

    const cleanedName = fileName.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();

    if (!cleanedName) {
      return undefined;
    }

    try {
      const response = await this.callFilenameGuess(cleanedName);
      const parsed = filenameGuessSchema.safeParse(JSON.parse(response));

      if (!parsed.success || parsed.data.confidence < MIN_CONFIDENCE || !parsed.data.title?.trim()) {
        return undefined;
      }

      return {
        title: parsed.data.title.trim(),
        year: parsed.data.year ?? undefined,
      };
    } catch (error) {
      this.logger.debug("[metadata_fix] filename title guess failed", {
        component: "metadata_fix",
        handler: "metadata_fix",
        step: "filename_guess",
        result: "skipped",
      });
      return undefined;
    }
  }

  async parse(input: MetadataFixHintInput): Promise<MetadataFixHint> {
    if (!this.settings.openai.apiKey) {
      return { kind: "undefined", reason: "OpenAI API key is not configured." };
    }

    if (!input.text?.trim() && !input.image) {
      return { kind: "undefined", reason: "Provide a text title and/or a screenshot." };
    }

    try {
      const response = await this.callOpenAI(input);
      const parsed = modelResponseSchema.safeParse(JSON.parse(response));

      if (!parsed.success) {
        this.logger.warn("[metadata_fix] invalid OpenAI hint schema", {
          component: "metadata_fix",
          handler: "metadata_fix",
          step: "hint_parse",
          error_type: "openai",
          issue_count: parsed.error.issues.length,
        });
        return { kind: "undefined", reason: "Hint parser returned invalid JSON shape." };
      }

      return normalizeHint(parsed.data);
    } catch (error) {
      this.logger.exception("[metadata_fix] OpenAI hint parse failed", error, {
        component: "metadata_fix",
        handler: "metadata_fix",
        step: "hint_parse",
        error_type: "openai",
      });
      return { kind: "undefined", reason: "Hint parser request failed." };
    }
  }

  private async callFilenameGuess(fileName: string): Promise<string> {
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
            content:
              "You identify the original film or TV series title from noisy download file names. " +
              "Return JSON: title (original English or international title when confident), year (release/first-air year or null), confidence 0-1. " +
              "Examples: 'Испанский английский' -> Spanglish (2004). If unsure, set title null and confidence below 0.7.",
          },
          {
            role: "user",
            content: JSON.stringify({ fileName }),
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

  private async callOpenAI(input: MetadataFixHintInput): Promise<string> {
    const userContent: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: JSON.stringify({
          folderName: input.folderName,
          text: input.text?.trim() || null,
          hasImage: Boolean(input.image),
        }),
      },
    ];

    if (input.image) {
      const mimeType = input.image.mimeType || "image/jpeg";
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${input.image.data.toString("base64")}`,
        },
      });
    }

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
            content: userContent,
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
    this.instructions ??= readFile(this.instructionsPath, "utf8");
    return this.instructions;
  }
}

type ModelResponse = z.infer<typeof modelResponseSchema>;

function normalizeHint(response: ModelResponse): MetadataFixHint {
  if (response.confidence < MIN_CONFIDENCE) {
    return { kind: "undefined", reason: response.reason || "Hint confidence was too low." };
  }

  if ((response.kind === "film" || response.kind === "tv_show") && response.title?.trim()) {
    return {
      kind: response.kind,
      title: response.title.trim(),
      year: response.year ?? undefined,
    };
  }

  return { kind: "undefined", reason: response.reason || "Could not identify a film or TV show from the hint." };
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
