# Debian Server Deployment

Production runs the bot in Docker on Debian. Releases are published to GHCR and pulled by GitHub Actions. See [docker.md](docker.md) for the full guide and one-time bootstrap.

This page is a short server-oriented summary. Local deploy scripts are not used.

## Layout

Default deploy directory: `/home/crearec/crea-video-downloader-bot`

| Path | Role |
|------|------|
| `docker-compose.yml` | Synced from git by Actions |
| `.env` | `DOWNLOAD_DIR`, `IMAGE`, `IMAGE_TAG` (never overwritten by Actions except `IMAGE_TAG`) |
| `config/settings.json` | Secrets and GramJS sessions (never overwritten by Actions) |
| `data/` | App state volume |
| host `DOWNLOAD_DIR` (for example `/mnt/synology/video`) | Mounted at `/downloads` in the container |

Host user: `crearec` (same user as other Docker/Portainer stacks). No separate `telegramvideo` system user.

## Prerequisites

- Docker Engine + Compose plugin (already required for Portainer stacks)
- `crearec` can run `docker compose` without sudo
- `docker login ghcr.io` with a PAT that has `read:packages` (private image)
- Passwordless sudo for `systemctl` only if the old systemd unit must still be disabled during migration

Node.js is **not** required on the server for runtime. It is only needed if you run `npm run login` on the host.

## Migrate from systemd

1. Complete the bootstrap in [docker.md](docker.md) (`.env`, settings with `download.directory: "/downloads"`, GHCR login).
2. `sudo systemctl disable --now telegram-video-downloader`
3. Start the container (`docker compose up -d` or wait for Actions)
4. Confirm downloads still land under the Synology mount
5. Remove the old full app checkout if it is no longer needed

## GitHub Actions

Push/merge to `main` runs:

1. `test` — `npm test` and a non-pushing Docker build
2. `publish` — push `ghcr.io/crearec/crea-video-downloader:main` and `:sha-<short>`
3. `deploy` — join Tailscale (`tag:ci`), SCP `docker-compose.yml`, set `IMAGE_TAG`, `docker compose pull && up -d`

Required secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST` (Tailscale IP or MagicDNS), `DEPLOY_USER`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`. See [docker.md](docker.md) for details.

Actions never overwrites `config/settings.json`.

## Plex + Synology storage

Production example:

```
//DS223/video  →  /mnt/synology/video
```

Server `.env`:

```sh
DOWNLOAD_DIR=/mnt/synology/video
```

`config/settings.json`:

```json
{
  "download": {
    "directory": "/downloads"
  }
}
```

Plex libraries:

- Movies → `/mnt/synology/video/Movies`
- TV Shows → `/mnt/synology/video/TV Shows`

## Notes

- Keep `config/settings.json` readable only by the deploy user.
- Each allowed Telegram user needs an entry in `telegram.userSessions` (see [docker.md](docker.md) for login).
- `/restart` in Telegram exits the process; Docker restarts the container.
