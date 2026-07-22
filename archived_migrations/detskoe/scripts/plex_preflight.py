#!/usr/bin/env python3
"""
Phase 1: build Plex-compatible target paths for Детское → Kids (no disk moves).

Mirrors src/metadata/plex-paths.ts naming. Fetches external_ids (imdb/tvdb) for tags.
Writes:
  detskoe-move-plan.csv
  detskoe-move-issues.md

Usage (from repo root):
  python3 archived_migrations/detskoe/scripts/plex_preflight.py
  python3 archived_migrations/detskoe/scripts/plex_preflight.py \\
    --csv archived_migrations/detskoe/detskoe-final.csv \\
    --source-root /mnt/synology/video/Детское --kids-root /mnt/synology/video/Kids
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
CACHE = ARCHIVE / "scripts" / ".cache_tmdb_external_ids.json"


def load_settings() -> dict:
    return json.loads((REPO_ROOT / "config" / "settings.json").read_text(encoding="utf8"))


def sanitize_plex_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned or cleaned in (".", ".."):
        return "Unknown"
    return cleaned


def format_plex_title(title: str, year: int | None) -> str:
    safe = sanitize_plex_name(title)
    return f"{safe} ({year})" if year else safe


def format_plex_id_tags(plex_ids: dict, kind: str) -> str:
    tags: list[str] = []
    if kind == "film":
        if plex_ids.get("imdb"):
            tags.append(f"{{imdb-{plex_ids['imdb']}}}")
        elif plex_ids.get("tmdb"):
            tags.append(f"{{tmdb-{plex_ids['tmdb']}}}")
    else:
        if plex_ids.get("tvdb"):
            tags.append(f"{{tvdb-{plex_ids['tvdb']}}}")
        elif plex_ids.get("tmdb"):
            tags.append(f"{{tmdb-{plex_ids['tmdb']}}}")
    return f" {' '.join(tags)}" if tags else ""


def format_season_dir(season: int) -> str:
    return f"Season {season:02d}"


def format_episode_tag(season: int, episode: int) -> str:
    return f"s{season:02d}e{episode:02d}"


def parse_year(value: str) -> int | None:
    if not value:
        return None
    try:
        y = int(value)
        return y if 1800 <= y <= 2200 else None
    except ValueError:
        return None


def parse_int(value: str) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def extension_of(path: str) -> str:
    m = re.search(r"(\.[A-Za-z0-9]+)$", path)
    return m.group(1) if m else ""


def build_movie_path(kids_root: Path, title: str, year: int | None, ext: str, plex_ids: dict) -> Path:
    display = format_plex_title(title, year)
    tags = format_plex_id_tags(plex_ids, "film")
    folder = sanitize_plex_name(f"{display}{tags}")
    filename = sanitize_plex_name(f"{display}{tags}{ext}")
    return kids_root / "Movies" / folder / filename


def build_tv_path(
    kids_root: Path,
    title: str,
    year: int | None,
    season: int,
    episode: int,
    ext: str,
    plex_ids: dict,
) -> Path:
    display = format_plex_title(title, year)
    tags = format_plex_id_tags(plex_ids, "tv_show")
    show_folder = sanitize_plex_name(f"{display}{tags}")
    ep_tag = format_episode_tag(season, episode)
    filename = sanitize_plex_name(f"{display} - {ep_tag}{ext}")
    return kids_root / "TV Shows" / show_folder / format_season_dir(season) / filename


class ExternalIdsCache:
    def __init__(self, api_key: str, language: str):
        self.api_key = api_key
        self.language = language
        self.data: dict[str, dict] = {}
        if CACHE.exists():
            try:
                self.data = json.loads(CACHE.read_text(encoding="utf8"))
            except json.JSONDecodeError:
                self.data = {}

    def save(self) -> None:
        CACHE.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf8")

    def fetch(self, kind: str, tmdb_id: str) -> dict:
        key = f"{kind}:{tmdb_id}"
        if key in self.data:
            return self.data[key]
        path = f"/movie/{tmdb_id}" if kind == "film" else f"/tv/{tmdb_id}"
        params = {
            "api_key": self.api_key,
            "language": self.language,
            "append_to_response": "external_ids",
        }
        url = f"https://api.themoviedb.org/3{path}?" + urllib.parse.urlencode(params)
        result = {"imdb": None, "tvdb": None, "tmdb": int(tmdb_id), "api_title": None, "api_year": None}
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=20) as resp:
                    body = json.load(resp)
                ext = body.get("external_ids") or {}
                imdb = ext.get("imdb_id") or None
                tvdb = ext.get("tvdb_id")
                result["imdb"] = imdb if imdb else None
                result["tvdb"] = int(tvdb) if tvdb else None
                if kind == "film":
                    result["api_title"] = body.get("title")
                    date = body.get("release_date") or ""
                else:
                    result["api_title"] = body.get("name") or body.get("original_name")
                    date = body.get("first_air_date") or ""
                result["api_year"] = int(date[:4]) if date[:4].isdigit() else None
                break
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 5:
                    time.sleep(min(60, 2**attempt))
                    continue
                break
            except Exception:
                break
        self.data[key] = result
        return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=str(ARCHIVE / "detskoe-final.csv"))
    ap.add_argument("--source-root", default="/mnt/synology/video/Детское")
    ap.add_argument("--kids-root", default="/mnt/synology/video/Kids")
    ap.add_argument("--plan-out", default=str(ARCHIVE / "detskoe-move-plan.csv"))
    ap.add_argument("--issues-out", default=str(ARCHIVE / "detskoe-move-issues.md"))
    args = ap.parse_args()

    settings = load_settings()
    api_key = settings.get("tmdb", {}).get("apiKey", "")
    language = settings.get("tmdb", {}).get("language", "ru-RU")
    if not api_key:
        raise SystemExit("TMDB API key missing in config/settings.json")

    source_root = Path(args.source_root)
    kids_root = Path(args.kids_root)
    cache = ExternalIdsCache(api_key, language)

    rows: list[dict] = []
    with open(args.csv, encoding="utf8") as f:
        for row in csv.DictReader(f, delimiter=";"):
            rows.append(row)

    print(f"Loaded {len(rows)} rows from {args.csv}")

    # Prefetch unique tmdb ids
    needed: set[tuple[str, str]] = set()
    for row in rows:
        kind = row["kind"]
        tid = (row.get("tmdb_id") or "").strip()
        if tid and kind in ("film", "tv_show"):
            needed.add((kind, tid))
    print(f"Fetching external_ids for {len(needed)} unique titles…")
    for i, (kind, tid) in enumerate(sorted(needed), 1):
        cache.fetch(kind, tid)
        if i % 50 == 0 or i == len(needed):
            cache.save()
            print(f"  {i}/{len(needed)}")
    cache.save()

    plan_rows: list[dict] = []
    missing_fields: list[str] = []
    by_target: dict[str, list[str]] = defaultdict(list)
    films_by_tmdb: dict[str, list[str]] = defaultdict(list)

    for row in rows:
        rel = row["path"]
        kind = row["kind"]
        title = (row.get("title") or "").strip()
        year = parse_year(row.get("year") or "")
        season = parse_int(row.get("season") or "")
        episode = parse_int(row.get("episode") or "")
        tmdb_id = (row.get("tmdb_id") or "").strip()
        ext = extension_of(rel)
        source_abs = str(source_root / rel)

        issues_for_row: list[str] = []
        if not title:
            issues_for_row.append("empty title")
        if not tmdb_id:
            issues_for_row.append("empty tmdb_id")
        if kind == "tv_show":
            if season is None:
                issues_for_row.append("empty season")
            if episode is None:
                issues_for_row.append("empty episode")
        if issues_for_row:
            missing_fields.append(f"{rel}: {', '.join(issues_for_row)}")

        plex_ids = {"tmdb": int(tmdb_id)} if tmdb_id.isdigit() else {}
        tag = ""
        if tmdb_id and kind in ("film", "tv_show"):
            ext_ids = cache.fetch(kind, tmdb_id)
            plex_ids = {
                "imdb": ext_ids.get("imdb"),
                "tmdb": ext_ids.get("tmdb") or int(tmdb_id),
                "tvdb": ext_ids.get("tvdb"),
            }
            # Prefer CSV year; fill from API if missing
            if year is None and ext_ids.get("api_year"):
                year = ext_ids["api_year"]
            tag = format_plex_id_tags(plex_ids, kind).strip()

        if kind == "film":
            target = build_movie_path(kids_root, title or "Unknown", year, ext, plex_ids)
            if tmdb_id:
                films_by_tmdb[tmdb_id].append(rel)
        elif kind == "tv_show" and season is not None and episode is not None:
            target = build_tv_path(kids_root, title or "Unknown", year, season, episode, ext, plex_ids)
        else:
            # Fallback: park under Undefined so plan still has a row
            safe = sanitize_plex_name(rel.replace("/", "__"))
            target = kids_root / "Undefined" / safe
            if not tag:
                tag = "(unresolved)"

        target_abs = str(target)
        by_target[target_abs].append(rel)
        plan_rows.append(
            {
                "source_abs": source_abs,
                "target_abs": target_abs,
                "kind": kind,
                "title": title,
                "year": year or "",
                "season": season if season is not None else "",
                "episode": episode if episode is not None else "",
                "tmdb_id": tmdb_id,
                "tag": tag,
                "collision": "",  # filled below
            }
        )

    collision_targets = {t: srcs for t, srcs in by_target.items() if len(srcs) > 1}
    for plan in plan_rows:
        if plan["target_abs"] in collision_targets:
            plan["collision"] = "yes"
        else:
            plan["collision"] = "no"

    with open(args.plan_out, "w", encoding="utf8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "source_abs",
                "target_abs",
                "kind",
                "title",
                "year",
                "season",
                "episode",
                "tmdb_id",
                "tag",
                "collision",
            ],
            delimiter=";",
        )
        w.writeheader()
        w.writerows(plan_rows)

    # Build issues report
    collision_files = sum(len(v) for v in collision_targets.values())
    film_dupes = {tid: paths for tid, paths in films_by_tmdb.items() if len(paths) > 1}

    # Group TV collisions by show+season+episode
    tv_collision_groups: dict[tuple, list[str]] = defaultdict(list)
    for plan in plan_rows:
        if plan["collision"] != "yes" or plan["kind"] != "tv_show":
            continue
        key = (plan["title"], str(plan["season"]), str(plan["episode"]))
        rel = plan["source_abs"].replace(str(source_root) + "/", "")
        tv_collision_groups[key].append(rel)

    # Source folder hint for TV collisions
    def parent_hint(rel: str) -> str:
        parts = rel.split("/")
        return "/".join(parts[:-1]) if len(parts) > 1 else "(root)"

    lines: list[str] = []
    lines.append("# Kids move — preflight issues")
    lines.append("")
    lines.append(f"Source root: `{args.source_root}`")
    lines.append(f"Kids root: `{args.kids_root}`")
    lines.append(f"Input: `{args.csv}` ({len(rows)} files)")
    lines.append(f"Plan: `{args.plan_out}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"| Metric | Count |")
    lines.append(f"|---|---:|")
    lines.append(f"| Total files | {len(rows)} |")
    lines.append(f"| Collision target paths | {len(collision_targets)} |")
    lines.append(f"| Files involved in collisions | {collision_files} |")
    lines.append(f"| Film tmdb_id duplicates | {len(film_dupes)} groups |")
    lines.append(f"| Missing critical fields | {len(missing_fields)} |")
    lines.append("")
    if collision_targets or film_dupes or missing_fields:
        lines.append(
            "> Fix these before Phase 2 `--execute`. With `move`, colliding targets overwrite each other."
        )
        lines.append("")

    lines.append("## 1. Target path collisions (same destination)")
    lines.append("")
    if not collision_targets:
        lines.append("_None._")
    else:
        lines.append(
            f"**{len(collision_targets)} destinations** would receive **{collision_files}** source files."
        )
        lines.append("")
        # Prefer grouping by show key for readability
        shown = 0
        for (title, season, episode), rels in sorted(
            tv_collision_groups.items(), key=lambda kv: -len(kv[1])
        ):
            parents = sorted({parent_hint(r) for r in rels})
            lines.append(f"### `{title}` S{int(season):02d}E{int(episode):02d} — {len(rels)} files")
            lines.append("")
            lines.append(f"Source folders: {', '.join(f'`{p}`' for p in parents)}")
            lines.append("")
            for r in sorted(rels)[:20]:
                lines.append(f"- `{r}`")
            if len(rels) > 20:
                lines.append(f"- … and {len(rels) - 20} more")
            lines.append("")
            shown += 1
            if shown >= 40:
                remaining = len(tv_collision_groups) - shown
                if remaining > 0:
                    lines.append(f"_… {remaining} more TV collision groups (see plan CSV `collision=yes`)._")
                    lines.append("")
                break

        # Non-TV collisions (films / undefined)
        film_coll = [
            (t, srcs)
            for t, srcs in collision_targets.items()
            if not any(p["target_abs"] == t and p["kind"] == "tv_show" for p in plan_rows)
            or any(p["target_abs"] == t and p["kind"] == "film" for p in plan_rows)
        ]
        film_only = []
        for target, srcs in collision_targets.items():
            kinds = {p["kind"] for p in plan_rows if p["target_abs"] == target}
            if "film" in kinds:
                film_only.append((target, srcs))
        if film_only:
            lines.append("### Film target collisions")
            lines.append("")
            for target, srcs in sorted(film_only, key=lambda kv: -len(kv[1])):
                lines.append(f"Target: `{target}`")
                for s in srcs:
                    lines.append(f"- `{s}`")
                lines.append("")

    lines.append("## 2. Film duplicates (same tmdb_id, multiple sources)")
    lines.append("")
    if not film_dupes:
        lines.append("_None._")
    else:
        lines.append(
            "These share one TMDB id and would land in the **same movie folder** "
            "(and may collide on the same filename)."
        )
        lines.append("")
        for tid, paths in sorted(film_dupes.items(), key=lambda kv: -len(kv[1])):
            sample = next((p for p in plan_rows if p["tmdb_id"] == tid and p["kind"] == "film"), None)
            label = sample["title"] if sample else "?"
            tag = sample["tag"] if sample else ""
            lines.append(f"### tmdb-{tid} — «{label}» {tag}")
            lines.append("")
            for p in paths:
                lines.append(f"- `{p}`")
            lines.append("")

    lines.append("## 3. Missing critical fields")
    lines.append("")
    if not missing_fields:
        lines.append("_None._")
    else:
        for line in missing_fields:
            lines.append(f"- `{line}`")
        lines.append("")

    if not collision_targets and not film_dupes and not missing_fields:
        lines.append("## Status")
        lines.append("")
        lines.append("No blockers. Plan is ready for Phase 2 move.")
        lines.append("")

    Path(args.issues_out).write_text("\n".join(lines), encoding="utf8")

    print(f"Wrote {args.plan_out} ({len(plan_rows)} rows)")
    print(f"Wrote {args.issues_out}")
    print(f"Collisions: {len(collision_targets)} targets / {collision_files} files")
    print(f"Film tmdb dupes: {len(film_dupes)} groups")
    print(f"Missing fields: {len(missing_fields)}")


if __name__ == "__main__":
    main()
