import path from "node:path";
import { parseSeasonEpisode } from "./metadata-fix-renamer.js";

const QUALITY_PATTERN =
  /\b(?:\d{3,4}p|4k|uhd|hdr|10bit|x26[45]|hevc|avc|h\.?26[45]|web-?dl|webrip|bluray|bdrip|dvdrip|\d*q\d{3,4})\b/gi;

const NOISE_TOKENS = new Set(
  [
    "перевод",
    "translation",
    "translate",
    "dub",
    "dubbed",
    "dual",
    "audio",
    "озвучка",
    "провайдер",
    "provider",
    "испанский",
    "английский",
    "spanish",
    "english",
    "russian",
    "русский",
    "multi",
    "subs",
    "subtitles",
    "субтитры",
    "cam",
    "ts",
    "hdtv",
    "proper",
    "repack",
    "extended",
    "uncut",
    "remastered",
    "vk",
    "youtube",
    "telegram",
  ].map((token) => token.toLowerCase()),
);

const TRAILING_INDEX_PATTERN = /(?:^|[\s._-])(?:v|part|cd|disc)\s*\d{1,2}$/i;

export interface CleanedDownloadTitle {
  query: string;
  year?: number;
  season?: number;
  episode?: number;
}

export function cleanDownloadTitle(fileName?: string, caption?: string): CleanedDownloadTitle {
  const fromCaption = caption ? stripCaptionNoise(caption) : "";
  const fromFile = fileName ? cleanFileNameStem(fileName) : "";
  const query = chooseBetterQuery(fromCaption, fromFile);
  const year = extractYear(caption) ?? extractYear(fileName) ?? extractYear(query);
  const episodeInfo = parseSeasonEpisode(fileName ?? "") ?? parseSeasonEpisode(caption ?? "");

  return {
    query,
    year,
    ...(episodeInfo ? { season: episodeInfo.season, episode: episodeInfo.episode } : {}),
  };
}

function chooseBetterQuery(captionQuery: string, fileQuery: string): string {
  const caption = captionQuery.trim();
  const file = fileQuery.trim();

  if (!caption) {
    return file;
  }

  if (!file) {
    return caption;
  }

  if (caption.length >= 3 && file.length < 4) {
    return caption;
  }

  if (file.length >= caption.length) {
    return file;
  }

  return caption;
}

function cleanFileNameStem(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  return normalizeTitleCandidate(stem);
}

function stripCaptionNoise(caption: string): string {
  const firstLine = caption.split(/\r?\n/)[0] ?? caption;
  return normalizeTitleCandidate(firstLine);
}

function normalizeTitleCandidate(value: string): string {
  const normalized = value
    .replace(/[._]+/g, " ")
    .replace(/[()[\]{}]+/g, " ")
    .replace(QUALITY_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cleaned = filterNoiseTokens(normalized).replace(TRAILING_INDEX_PATTERN, "").trim();

  return cleaned || filterNoiseTokens(normalized) || normalized;
}

function filterNoiseTokens(value: string): string {
  return value
    .split(" ")
    .filter((token) => {
      const normalized = token.toLowerCase();

      if (!normalized || /^\d+$/.test(normalized)) {
        return false;
      }

      if (NOISE_TOKENS.has(normalized)) {
        return false;
      }

      for (const noise of NOISE_TOKENS) {
        if (normalized.startsWith(noise)) {
          return false;
        }
      }

      return true;
    })
    .join(" ")
    .trim();
}

function extractYear(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/(?:^|[^\d])(19\d{2}|20\d{2})(?:[^\d]|$)/);

  if (!match) {
    return undefined;
  }

  const year = Number.parseInt(match[1], 10);

  return Number.isFinite(year) ? year : undefined;
}
