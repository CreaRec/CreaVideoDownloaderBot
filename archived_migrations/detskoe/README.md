# Archived migration: Детское → Kids (Plex)

Example one-off library migration. **Not used by the production bot** and excluded from the Docker image via `.dockerignore`.

## What this is

Offline analysis + move tooling for `/mnt/synology/video/Детское` → `/mnt/synology/video/Kids` (`Movies/` + `TV Shows/`).

The bot only sees Telegram filenames; these scripts use **full folder paths** as context so bare names like `10.mp4` can be classified.

## Layout

| Path | Role |
|------|------|
| `detskoe-structure.txt` | Source file list from NAS |
| `detskoe-final.csv` | Final classification (TMDB ids, kind, season/episode) |
| `detskoe-move-plan.csv` | Preflight plan: source → Plex target paths |
| `detskoe-move-issues.md` | Preflight summary / issues |
| `detskoe-move-log.csv` | Move run log (if executed) |
| `detskoe-*-*.csv` / `*.md` | Intermediate recognition / pocket passes |
| `scripts/` | Ad-hoc Python tools + API caches |

## Typical flow (reference)

```bash
# Phase 1 — plan only (no disk moves)
python3 archived_migrations/detskoe/scripts/plex_preflight.py \
  --source-root /mnt/synology/video/Детское \
  --kids-root /mnt/synology/video/Kids

# Phase 2 — on the host that mounts the NAS
python3 archived_migrations/detskoe/scripts/plex_move.py --dry-run
python3 archived_migrations/detskoe/scripts/plex_move.py --execute
```

Requires `config/settings.json` in the repo root (TMDB / OpenAI keys) for classification and preflight external-id lookups.

## For a future migration

Copy this folder pattern (`archived_migrations/<name>/`), adapt CSV schema and scripts, keep artifacts out of the app `src/` tree so production builds stay unchanged.
