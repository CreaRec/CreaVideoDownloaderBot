# Docker + GHCR deployment

The bot runs as a Docker container pulled from GitHub Container Registry (GHCR). Releases happen only through GitHub Actions when changes land on `main`. There is no local deploy script.

Image: `ghcr.io/crearec/crea-video-downloader`

## How a release works

1. Merge or push to `main`.
2. Actions runs tests and builds the image.
3. Actions pushes tags `main` and `sha-<short>` to GHCR.
4. Actions copies `docker-compose.yml` to the server, sets `IMAGE_TAG`, then runs `docker compose pull && docker compose up -d`.

Secrets stay on the server in `config/settings.json`. Downloads and app state are host volumes.

## One-time server bootstrap

Use the same Linux user that already runs Docker/Portainer (`crearec`). Do not create a separate service user.

### 1. GitHub / GHCR

After the first successful `publish` job:

1. Open the `crea-video-downloader` package under your GitHub user/org.
2. Link it to the `CreaVideoDownloaderBot` repository if needed.
3. Keep the package **Private**.
4. Create a PAT with `read:packages` for the server to pull the image.

### 2. Docker login on the server

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u CreaRec --password-stdin
docker compose version
```

### 3. Deploy directory

Default path: `/home/crearec/crea-video-downloader-bot`

```sh
mkdir -p /home/crearec/crea-video-downloader-bot/{config,data}
cd /home/crearec/crea-video-downloader-bot
```

Copy `docker-compose.yml` from the repo once (Actions will refresh it on later deploys).

Create `.env` from [`.env.example`](../.env.example):

```sh
DOWNLOAD_DIR=/mnt/synology/video
IMAGE=ghcr.io/crearec/crea-video-downloader
IMAGE_TAG=main
```

Place your existing `config/settings.json` (with Telegram credentials and GramJS sessions). Set:

```json
"download": {
  "directory": "/downloads"
}
```

`DOWNLOAD_DIR` on the host is mounted at `/downloads` inside the container.

Ensure `data/` and `DOWNLOAD_DIR` are writable by the container user (`node`, UID 1000).

### 4. Stop the old systemd unit

```sh
sudo systemctl disable --now telegram-video-downloader
```

Later deploys also attempt this if the unit still exists.

### 5. First start

Either:

```sh
cd /home/crearec/crea-video-downloader-bot
docker compose pull
docker compose up -d
```

Or merge to `main` and let Actions deploy.

Check Portainer, `docker compose logs -f`, and send `/start` in Telegram.

After the container is stable, you can remove any old full source checkout (`node_modules`, `dist`, etc.) from the server and keep only this thin deploy directory.

## Day-to-day operations

Deploy: merge to `main`.

On the server (or via Portainer):

```sh
cd /home/crearec/crea-video-downloader-bot
docker compose ps
docker compose logs -f
docker compose restart
```

After editing `config/settings.json`, restart the container so settings reload:

```sh
docker compose restart
```

The Telegram `/restart` command exits the process; Compose `restart: unless-stopped` brings the container back.

## GramJS login

The production image does not include the login CLI tooling path for interactive use. To add or refresh a session:

1. On a machine with a full checkout and Node 24+, point at a copy of the server `config/settings.json` (or edit it over SSH with Node installed temporarily).
2. Run `npm run login -- --user-id <telegram_user_id>`.
3. Copy the updated `settings.json` back to the server deploy directory.
4. `docker compose restart`.

## GitHub Actions secrets

| Secret | Purpose |
|--------|---------|
| `DEPLOY_SSH_KEY` | Private key for SSH deploy |
| `DEPLOY_HOST` | Tailscale IP or MagicDNS hostname of the server (for example `100.118.169.52`) |
| `DEPLOY_USER` | SSH user (for example `crearec`) |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (Trust credentials) for ephemeral CI nodes |
| `TS_OAUTH_SECRET` | Tailscale OAuth client secret (Trust credentials) |

Deploy joins the tailnet with `tag:ci` via [`tailscale/github-action`](https://github.com/tailscale/github-action), then SSHs to `DEPLOY_HOST`. Create the OAuth client under Tailscale **Settings → Trust credentials** (not legacy OAuth clients).

GHCR push uses the workflow `GITHUB_TOKEN` (`packages: write`). No extra registry secret is required for publish.
