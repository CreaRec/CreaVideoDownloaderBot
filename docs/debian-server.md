# Debian Server Deployment

This guide installs the downloader as a systemd process on Debian.

The examples use `/opt/telegram-video-downloader` for the app and `/var/lib/telegram-video-downloader` for downloaded files. Adjust paths if needed, then update the systemd unit and `config/settings.json` to match.

## 1. Install Node.js

Install Node.js 22.9.0 or newer and npm 11.16.0. One common approach is NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g npm@11.16.0
node --version
npm --version
```

## 2. Create A Service User

```sh
sudo useradd --system --home /opt/telegram-video-downloader --shell /usr/sbin/nologin telegramvideo
sudo mkdir -p /opt/telegram-video-downloader /var/lib/telegram-video-downloader
sudo chown -R telegramvideo:telegramvideo /opt/telegram-video-downloader /var/lib/telegram-video-downloader
```

## 3. Copy And Build The Project

From your local machine or your server checkout, place the project in `/opt/telegram-video-downloader`.

On the server:

```sh
cd /opt/telegram-video-downloader
sudo -u telegramvideo npm install
sudo -u telegramvideo npm run build
```

For a production install after building, you can remove dev dependencies:

```sh
sudo -u telegramvideo npm prune --omit=dev
```

## 4. Configure Settings

```sh
cd /opt/telegram-video-downloader
sudo -u telegramvideo cp config/settings.example.json config/settings.json
sudo -u telegramvideo nano config/settings.json
```

Set:

- `telegram.apiId`
- `telegram.apiHash`
- `telegram.botToken`
- `telegram.botUsername`
- `telegram.allowedUserIds`
- `download.directory`, for example `/var/lib/telegram-video-downloader`

Validate settings:

```sh
sudo -u telegramvideo npm run validate:settings
```

## 5. Create The GramJS Session

Run the login helper on the server:

```sh
cd /opt/telegram-video-downloader
sudo -u telegramvideo npm run login
```

Complete the Telegram login prompts. The script writes `telegram.stringSession` into `config/settings.json`.

You can also run `npm run login` locally and copy the resulting `telegram.stringSession` value into the server settings file.

## 6. Install The systemd Unit

```sh
sudo cp deploy/telegram-video-downloader.service /etc/systemd/system/telegram-video-downloader.service
sudo systemctl daemon-reload
sudo systemctl enable telegram-video-downloader
sudo systemctl start telegram-video-downloader
```

Check status and logs:

```sh
sudo systemctl status telegram-video-downloader
sudo journalctl -u telegram-video-downloader -f
```

The installed unit uses `Restart=always`, so the private `/restart` bot command can exit the Node process and systemd will bring it back after `RestartSec`. It also uses `RuntimeMaxSec=24h` to recycle the long-running Telegram client once per day.

## 7. Updating The Service

```sh
cd /opt/telegram-video-downloader
sudo -u telegramvideo npm install
sudo -u telegramvideo npm run build
sudo systemctl restart telegram-video-downloader
```

After editing `config/settings.json`, restart the service so the app reloads the new settings:

```sh
sudo systemctl restart telegram-video-downloader
```

## Scripted Deployment

To deploy or update the app without cloning the repository on the server, run this from your local project root:

```sh
./scripts/deploy.sh
```

By default, the script connects to `192.168.1.135`, rsyncs the project to `/home/crearec/crea-video-downloader-bot`, builds on the server, installs the `telegram-video-downloader` systemd unit, and restarts the service. It runs `npm test` locally first and aborts if tests fail.

Use `--remote` to connect via `crearec.app` instead of the local network IP:

```sh
./scripts/deploy.sh --remote
```

Override any of: `SERVER_HOST`, `SSH_USER`, `REMOTE_APP_DIR`, `SERVICE_NAME`.

```sh
SERVER_HOST=192.168.1.135 SSH_USER=crearec REMOTE_APP_DIR=/home/crearec/crea-video-downloader-bot ./scripts/deploy.sh
```

Set optional `DEPLOY_PASSWORD` in a local `.env` file (or export it) to skip SSH/sudo prompts during deploy; you need `sshpass` installed locally. When `DEPLOY_PASSWORD` is unset, deploy asks for passwords interactively.

The deploy script reuses one SSH connection and one `sudo` session on the server, so you should only be prompted for the server login password once and the sudo password once (if password auth is used). For zero prompts, use SSH keys and passwordless sudo for the deploy user, or `DEPLOY_PASSWORD` with `sshpass`.

The deploy script never overwrites `config/settings.json` on the server. If it is missing, the remote deploy script seeds it from `config/settings.example.json` so you can edit it on the server before the bot can start.

**Server prerequisite:** Node.js 22.9.0 or newer and npm must already be installed on the server (see section 1 above). The deploy script does not install Node.js for you.

## GitHub Actions CI/CD

Merging into `main` triggers an automatic deploy to the production server via [`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml).

**On every push and pull request:** the `test` job runs `npm ci` and `npm test`.

**On push to `main` only:** the `deploy` job runs after tests pass. GitHub Actions sets `CI=true` on the runner; `scripts/deploy.sh` forwards `CI`/`GITHUB_ACTIONS` to the remote script and skips forced TTY (`-tt`) when `DEPLOY_PASSWORD` is unset. The workflow then:

1. Writes the deploy SSH private key from GitHub Secrets
2. Opens an SSH ControlMaster socket authenticated with that key
3. Calls `./scripts/deploy.sh --remote`, which reuses the existing socket for rsync and remote build/restart

Required GitHub Secrets (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `DEPLOY_SSH_KEY` | Private deploy key (matching the public key in server `authorized_keys`) |
| `DEPLOY_HOST` | Server hostname, for example `crearec.app` |
| `DEPLOY_USER` | SSH user, for example `crearec` |

**Server prerequisites for CI deploy** (one-time setup):

- Public deploy key in `~/.ssh/authorized_keys` for the deploy user
- Passwordless sudo for deploy commands. **The sudoers username must match `DEPLOY_USER` in GitHub Secrets exactly** (for example `crearec`).

  On the server, as a user with sudo access, run:

  ```sh
  DEPLOY_USER=crearec   # must match GitHub secret DEPLOY_USER
  command -v cp systemctl journalctl

  sudo tee "/etc/sudoers.d/${DEPLOY_USER}-deploy" > /dev/null <<EOF
  ${DEPLOY_USER} ALL=(ALL) NOPASSWD: /bin/cp, /usr/bin/cp, /bin/systemctl, /usr/bin/systemctl, /usr/bin/journalctl
  EOF
  sudo chmod 440 "/etc/sudoers.d/${DEPLOY_USER}-deploy"
  sudo visudo -c -f "/etc/sudoers.d/${DEPLOY_USER}-deploy"
  ```

  Then **as the deploy user** (not root), verify no password is asked:

  ```sh
  sudo -n systemctl --version
  sudo -n cp --version
  sudo -n systemctl status telegram-video-downloader
  ```

  If those fail, check: wrong username in sudoers, file permissions not `440`, or binary paths differ from `command -v` output. For a home server, a broader rule also works:

  ```
  crearec ALL=(ALL) NOPASSWD: ALL
  ```

- Node.js, `config/settings.json`, and GramJS session already configured on the server

`DEPLOY_PASSWORD` is not used in CI. The workflow never overwrites `config/settings.json` on the server.

After a successful deploy, verify the service:

```sh
./scripts/service-debian.sh --remote status
./scripts/service-debian.sh --remote logs
```

## Service Helper Script

From your local project root, use `scripts/service-debian.sh` to manage the remote systemd service over SSH:

```sh
./scripts/service-debian.sh restart
./scripts/service-debian.sh start
./scripts/service-debian.sh status
./scripts/service-debian.sh logs
./scripts/service-debian.sh stop
./scripts/service-debian.sh --remote status
```

The script defaults to `SERVER_HOST=192.168.1.135`, `SSH_USER=crearec`, and `SERVICE_NAME=telegram-video-downloader`. Override them when needed:

```sh
SERVER_HOST=192.168.1.135 SSH_USER=crearec ./scripts/service-debian.sh restart
```

Optional `DEPLOY_PASSWORD` in local `.env` (or env) works the same way as in `scripts/deploy.sh`.

For a quick operations reference, see `docs/debian-commands.md`.

## Notes

- Keep `config/settings.json` readable only by the service user.
- If you change `download.directory`, redeploy so `ReadWritePaths` in the installed systemd unit is updated from `deploy/telegram-video-downloader.service`.
- The bot only processes messages from `telegram.allowedUserIds`.
- The `/restart` command is restricted to `telegram.allowedUserIds` and depends on systemd restarting the process.

## Plex + Synology Storage

Production example on a Debian server with Synology NAS:

```
//DS223/video  →  /mnt/synology/video
```

Recommended `config/settings.json` values:

```json
{
  "download": {
    "directory": "/mnt/synology/video"
  },
  "openai": {
    "apiKey": "..."
  },
  "tmdb": {
    "apiKey": "...",
    "language": "ru-RU"
  }
}
```

Plex libraries:

- Movies → `/mnt/synology/video/Movies`
- TV Shows → `/mnt/synology/video/TV Shows`

Get a free TMDB API key from <https://www.themoviedb.org/settings/api>.

### Migrating From `bot/Film` and `bot/TVShow`

After deploying the Plex layout update:

```sh
cd /home/crearec/crea-video-downloader-bot
npx tsx scripts/migrate-to-plex.ts --dry-run
npx tsx scripts/migrate-to-plex.ts
```

Defaults:

- `--source /mnt/synology/video/bot`
- `--dest /mnt/synology/video`

The script copies files into enriched Plex paths using the migration-specific OpenAI prompt in `config/media-migration-instructions.md`, plus TMDB. Non-video files and dotfiles are ignored. TV shows are resolved once per `TVShow/<name>/` folder so every episode gets the same series match. Use `--no-enrich` for path-only parsing without network calls.

After migration, change `download.directory` from `/mnt/synology/video/bot` to `/mnt/synology/video`, redeploy, scan Plex libraries, and remove the old `bot/` folder manually once verified.
