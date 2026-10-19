const PLEX_ID_TAG_PATTERN = /\{(imdb|tmdb|tvdb)-[^}]+\}/gi;
const TRAILING_YEAR_PATTERN = /\s*\((\d{4})\)\s*$/;

export function normalizeMediaTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripPlexIdTagsFromFolderName(folderName: string): string {
  return folderName.replace(PLEX_ID_TAG_PATTERN, "").replace(/\s+/g, " ").trim();
}

export function parseTitleAndYearFromFolderDisplayName(displayName: string): { title: string; year?: number } {
  const withoutTags = stripPlexIdTagsFromFolderName(displayName);
  const yearMatch = withoutTags.match(TRAILING_YEAR_PATTERN);

  if (!yearMatch) {
    return { title: withoutTags.trim() };
  }

  const year = Number.parseInt(yearMatch[1], 10);
  const title = withoutTags.slice(0, yearMatch.index).trim();

  return {
    title,
    year: Number.isFinite(year) ? year : undefined,
  };
}
