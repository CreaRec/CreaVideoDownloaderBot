# Local Development

Use this guide to run the downloader on your local machine before deploying it to Debian.

## 1. Install Dependencies

```sh
npm install
```

## 2. Create Settings

```sh
cp config/settings.example.json config/settings.json
```

Edit `config/settings.json`:

- Set `telegram.apiId` and `telegram.apiHash` from <https://my.telegram.org>.
- Set `telegram.botToken` and `telegram.botUsername` from BotFather.
- Set `telegram.allowedUserIds` to your numeric Telegram user ID.
- Set `download.directory` to the folder where videos should be saved.
- Set `OPENAI_API_KEY` in your shell, or set `openai.apiKey` in `config/settings.json`, so the bot can classify media filenames and captions.
- Optional: set `TMDB_API_KEY` or `tmdb.apiKey` for verified Plex metadata IDs.

Validate the file:

```sh
npm run validate:settings
```

## 3. Create The GramJS Session

Run:

```sh
npm run login
```

The script will ask for your Telegram phone number, login code, and two-step verification password if your account uses one. It saves the generated GramJS string session into `config/settings.json`.

Keep `config/settings.json` private.

## 4. Start Locally

```sh
npm run dev
```

Send or forward a video to your bot from one of the configured `allowedUserIds`. The service logs the output path after the download completes.

With OpenAI configured, downloads are saved under the configured download directory in Plex-compatible layout:

- Films: `Movies/Inception (2010) {imdb-tt1375666}/Inception (2010) {imdb-tt1375666}.mkv`
- TV shows: `TV Shows/Breaking Bad (2008) {tvdb-81189}/Season 03/Breaking Bad (2008) - s03e04 - Episode Title.mkv`
- Unclear files: `Undefined/<original filename>.<ext>`

The classifier instructions live in `config/media-classification-instructions.md`. Edit that file if you want to adjust how filenames and captions are interpreted.

## Troubleshooting

- If the service says the settings file cannot be read, confirm `config/settings.json` exists or set `SETTINGS_PATH=/path/to/settings.json`.
- If GramJS cannot find the bot chat, open Telegram with the same user account and start a private chat with the bot first.
- If downloads fail for unauthorized users, add your numeric Telegram user ID to `telegram.allowedUserIds`.
- If files are not written, check that `download.directory` exists or that the service user can create it.
- If every file is saved to `Undefined`, confirm `OPENAI_API_KEY` is set and check the logs for classifier errors.
- If Plex matching is weak, confirm `TMDB_API_KEY` is set and that Plex libraries use the **Plex Movie** / **Plex TV Series** agents.
