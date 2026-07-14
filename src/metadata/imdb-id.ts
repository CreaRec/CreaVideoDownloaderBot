const IMDB_TITLE_URL_PATTERN = /(?:https?:\/\/)?(?:www\.)?imdb\.com\/title\/(tt\d{7,})\b/i;
const IMDB_ID_PATTERN = /\b(tt\d{7,})\b/i;

/** Extract an IMDb title id from a URL or raw `tt…` text. */
export function parseImdbId(text: string | undefined): string | undefined {
  const value = text?.trim();

  if (!value) {
    return undefined;
  }

  const fromUrl = value.match(IMDB_TITLE_URL_PATTERN)?.[1];

  if (fromUrl) {
    return fromUrl.toLowerCase();
  }

  const fromBareId = value.match(IMDB_ID_PATTERN)?.[1];

  return fromBareId?.toLowerCase();
}
