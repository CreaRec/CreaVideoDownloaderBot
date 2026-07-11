# Debian / Docker operations

Useful commands for the Telegram Video Downloader container on the Debian server.

Deploy directory (default): `/home/crearec/crea-video-downloader-bot`

Releases are deployed only by GitHub Actions on `main`. There is no local deploy helper script. You can also use Portainer for the same container.

## Container control

On the server:

```sh
cd /home/crearec/crea-video-downloader-bot
docker compose ps
docker compose logs -f
docker compose logs --tail=100
docker compose restart
docker compose stop
docker compose up -d
```

Pull a specific tag manually (normally Actions sets `IMAGE_TAG` in `.env`):

```sh
cd /home/crearec/crea-video-downloader-bot
# edit IMAGE_TAG in .env, then:
docker compose pull
docker compose up -d
```

You can also restart from Telegram with `/restart` as an allowed user. Compose `restart: unless-stopped` brings the container back.

## Config changes

```sh
cd /home/crearec/crea-video-downloader-bot
nano config/settings.json
docker compose restart
```

`download.directory` inside settings must stay `/downloads` (the in-container mount). Change the host path via `DOWNLOAD_DIR` in `.env`, then recreate:

```sh
docker compose up -d
```

## Deploy / update

Merge to `main`. Actions builds, pushes to GHCR, and runs pull/up on the server.

## Troubleshooting

```sh
cd /home/crearec/crea-video-downloader-bot
docker compose ps
docker compose logs --tail=100
```

Cannot pull from GHCR:

```sh
docker login ghcr.io -u CreaRec
```

Missing `.env` or `config/settings.json` causes the Actions deploy step to fail with an explicit error — bootstrap those files once (see [docker.md](docker.md)).

Old systemd unit still running (two bots):

```sh
sudo systemctl disable --now telegram-video-downloader
docker compose ps
```

Permission errors writing downloads or `data/`: ensure the host paths are writable by UID 1000 (`node` in the image).
