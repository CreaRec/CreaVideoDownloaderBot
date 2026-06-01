# Debian App Management Commands

Useful commands for managing the Telegram Video Downloader on a Debian server.

The systemd service name is `telegram-video-downloader`. If you used the scripted deployment, the default app directory is `/home/crearec/crea-video-downloader-bot`. If you installed manually, the app directory may be `/opt/telegram-video-downloader`.

## Local Helper Script

Run these from your local project root. The script connects to the Debian server over SSH and runs the matching systemd command.

```sh
./scripts/service-debian.sh restart
./scripts/service-debian.sh start
./scripts/service-debian.sh status
./scripts/service-debian.sh logs
./scripts/service-debian.sh stop
```

Override the default server, SSH user, or service name:

```sh
SERVER_HOST=192.168.1.135 SSH_USER=crearec ./scripts/service-debian.sh restart
SERVICE_NAME=telegram-video-downloader ./scripts/service-debian.sh status
```

## Service Control

Run these directly on the Debian server.

```sh
sudo systemctl start telegram-video-downloader
sudo systemctl stop telegram-video-downloader
sudo systemctl restart telegram-video-downloader
sudo systemctl status telegram-video-downloader
```

You can also restart the service remotely from Telegram by sending `/restart` as an allowed user. The bot replies before exiting, and systemd starts it again automatically.

Enable or disable start at boot:

```sh
sudo systemctl enable telegram-video-downloader
sudo systemctl disable telegram-video-downloader
```

Reload systemd after editing `/etc/systemd/system/telegram-video-downloader.service`:

```sh
sudo systemctl daemon-reload
sudo systemctl restart telegram-video-downloader
```

## Logs

Follow live logs:

```sh
sudo journalctl -u telegram-video-downloader -f
```

Show recent logs:

```sh
sudo journalctl -u telegram-video-downloader -n 100 --no-pager
```

Show logs since boot:

```sh
sudo journalctl -u telegram-video-downloader -b --no-pager
```

## Config Changes

Edit settings:

```sh
cd /home/crearec/crea-video-downloader-bot
nano config/settings.json
```

If using the manual `/opt` install:

```sh
cd /opt/telegram-video-downloader
sudo -u telegramvideo nano config/settings.json
```

Validate settings if dev dependencies are installed:

```sh
npm run validate:settings
```

Restart after changing settings:

```sh
sudo systemctl restart telegram-video-downloader
```

## Deploy Or Update

From your local project root:

```sh
./scripts/deploy-debian.sh
```

Override deploy defaults:

```sh
SSH_USER=crearec SERVER_HOST=192.168.1.135 REMOTE_APP_DIR=/home/crearec/crea-video-downloader-bot ./scripts/deploy-debian.sh
```

## Troubleshooting

Check whether the service is active:

```sh
systemctl is-active telegram-video-downloader
```

Check whether the service is enabled at boot:

```sh
systemctl is-enabled telegram-video-downloader
```

Inspect the installed service file:

```sh
systemctl cat telegram-video-downloader
```

Check the Node.js and npm versions:

```sh
node --version
npm --version
```

For this project, Node.js should be at least `v22.9.0` and npm should be `11.16.0` or newer.
