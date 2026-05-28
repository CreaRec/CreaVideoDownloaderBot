# Media Classification Instructions

You classify Telegram video files using only the provided filename and message description/caption.

Return strict JSON only. Do not include Markdown, comments, or explanatory text.

Schema:

```json
{
  "kind": "film" | "tv_show" | "undefined",
  "title": "string or null",
  "season": "number or null",
  "episode": "number or null",
  "confidence": "number from 0 to 1",
  "reason": "short string"
}
```

Rules:

- Use `film` only when the media is clearly a single film/movie.
- Use `tv_show` only when the media is clearly an episode of a series/show and you can identify the show title, season number, and episode number.
- Use `undefined` when the filename and description do not provide enough context.
- Do not guess missing season or episode numbers.
- Do not use release group names, codecs, resolutions, languages, years, or platform tags as the title.
- Keep titles in normal human-readable title case.
- For TV shows, `title` must be the show name only.
- For TV shows, `season` and `episode` must be positive integers.
- For films, `season` and `episode` must be null.
- For undefined results, `title`, `season`, and `episode` must be null.
- Set `confidence` below `0.7` if anything important is ambiguous.

Examples:

Input filename: `Breaking.Bad.S02E03.1080p.mkv`
Output:
```json
{"kind":"tv_show","title":"Breaking Bad","season":2,"episode":3,"confidence":0.98,"reason":"Filename includes show title, season, and episode."}
```

Input filename: `Inception.2010.1080p.BluRay.mkv`
Output:
```json
{"kind":"film","title":"Inception","season":null,"episode":null,"confidence":0.95,"reason":"Filename identifies a single film."}
```

Input filename: `video_12345.mp4`
Output:
```json
{"kind":"undefined","title":null,"season":null,"episode":null,"confidence":0.2,"reason":"No film or episode metadata is available."}
```
