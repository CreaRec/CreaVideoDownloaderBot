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
- Set `download.directory` to the folder where videos should be saved.
- Set `openai.apiKey` in `config/settings.json` so the bot can classify media filenames and captions.
- Optional: set `tmdb.apiKey` for verified Plex metadata IDs.

Validate the file:

```sh
npm run validate:settings
```

## 3. Create GramJS Sessions

Run for each user who should access the bot:

```sh
npm run login -- --user-id <telegram_user_id>
```

If `--user-id` is omitted and exactly one user exists in `telegram.userSessions`, the script re-authenticates that user.

The script will ask for that user's Telegram phone number, login code, and two-step verification password if the account uses one. It saves the generated GramJS string session into `telegram.userSessions` in `config/settings.json`.

Keep `config/settings.json` private.

## 4. Start Locally

```sh
npm run dev
```

Send or forward a video to your bot from a user listed in `telegram.userSessions`. The service logs the output path after the download completes.

With OpenAI configured, downloads are saved under the configured download directory in Plex-compatible layout:

- Films: `Movies/Inception (2010) {imdb-tt1375666}/Inception (2010) {imdb-tt1375666}.mkv`
- TV shows: `TV Shows/Breaking Bad (2008) {tvdb-81189}/Season 03/Breaking Bad (2008) - s03e04 - Episode Title.mkv`
- Unclear files: `Undefined/<original filename>.<ext>`

The classifier instructions live in `config/media-classification-instructions.md`. Edit that file if you want to adjust how filenames and captions are interpreted.

## Troubleshooting

- If the service says the settings file cannot be read, confirm `config/settings.json` exists or set `SETTINGS_PATH=/path/to/settings.json`.
- If GramJS cannot find the bot chat, open Telegram with the same user account and start a private chat with the bot first.
- If downloads fail for unauthorized users, add that user with `npm run login -- --user-id <telegram_user_id>`.
- If downloads fail for an allowed user with `does not contain downloadable media`, refresh that user's GramJS session with `npm run login -- --user-id <telegram_user_id>` and restart the service.
- If the service fails to start with no GramJS sessions, run `npm run login -- --user-id <telegram_user_id>`.
- If files are not written, check that `download.directory` exists or that the service user can create it.
- If every file is saved to `Undefined`, confirm `openai.apiKey` is set in `config/settings.json` and check the logs for classifier errors.
- If Plex matching is weak, confirm `tmdb.apiKey` is set and that Plex libraries use the **Plex Movie** / **Plex TV Series** agents.
