#!/usr/bin/env python3
"""
Phase 2: move Детское → Kids using detskoe-move-plan.csv (Plex layout).

Default is --dry-run (no changes). Use --execute for real moves.
Never overwrites an existing target. Prunes empty source dirs after move.

Usage (on the machine where /mnt/synology/video is mounted):
  python3 archived_migrations/detskoe/scripts/plex_move.py --dry-run
  python3 archived_migrations/detskoe/scripts/plex_move.py --execute
  python3 archived_migrations/detskoe/scripts/plex_move.py --execute --skip-collisions
"""
from __future__ import annotations

import argparse
import csv
import os
import shutil
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]


def load_plan(path: Path) -> list[dict]:
    with path.open(encoding="utf8") as f:
        return list(csv.DictReader(f, delimiter=";"))


def prune_empty_parents(path: Path, stop_at: Path) -> list[str]:
    """Remove empty parent dirs up to (but not including) stop_at."""
    removed: list[str] = []
    current = path.parent
    stop_at = stop_at.resolve()
    while True:
        try:
            resolved = current.resolve()
        except FileNotFoundError:
            break
        if resolved == stop_at or not str(resolved).startswith(str(stop_at) + os.sep):
            break
        try:
            entries = list(current.iterdir())
        except FileNotFoundError:
            break
        visible = [e for e in entries if not e.name.startswith(".")]
        if visible:
            break
        # remove leftover dotfiles then rmdir
        for e in entries:
            if e.name.startswith(".") and e.is_file():
                try:
                    e.unlink()
                except OSError:
                    pass
        try:
            current.rmdir()
            removed.append(str(current))
        except OSError:
            break
        current = current.parent
    return removed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", default=str(ARCHIVE / "detskoe-move-plan.csv"))
    ap.add_argument("--log", default=str(ARCHIVE / "detskoe-move-log.csv"))
    ap.add_argument("--source-root", default="/mnt/synology/video/Детское")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Plan only, do not move (default)",
    )
    ap.add_argument("--execute", action="store_true", help="Actually move files")
    ap.add_argument(
        "--skip-collisions",
        action="store_true",
        help="Skip rows marked collision=yes (safer until data is fixed)",
    )
    ap.add_argument(
        "--only-ok",
        action="store_true",
        help="Alias for --skip-collisions",
    )
    args = ap.parse_args()
    dry_run = not args.execute
    skip_collisions = args.skip_collisions or args.only_ok
    source_root = Path(args.source_root)

    plan = load_plan(Path(args.plan))
    print(f"Plan rows: {len(plan)}")
    print(f"Mode: {'DRY-RUN' if dry_run else 'EXECUTE'}")
    if skip_collisions:
        print("Skipping collision=yes rows")

    log_rows: list[dict] = []
    counts = {
        "moved": 0,
        "would_move": 0,
        "skipped_collision": 0,
        "skipped_missing_source": 0,
        "skipped_target_exists": 0,
        "error": 0,
    }

    for row in plan:
        source = Path(row["source_abs"])
        target = Path(row["target_abs"])
        collision = (row.get("collision") or "").lower() == "yes"
        status = ""
        detail = ""

        if collision and skip_collisions:
            status = "skipped_collision"
            counts["skipped_collision"] += 1
        elif not source.exists():
            status = "skipped_missing_source"
            detail = "source not found"
            counts["skipped_missing_source"] += 1
        elif target.exists():
            status = "skipped_target_exists"
            detail = "target already exists (no overwrite)"
            counts["skipped_target_exists"] += 1
        elif dry_run:
            status = "would_move"
            counts["would_move"] += 1
        else:
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    status = "skipped_target_exists"
                    detail = "target appeared before move"
                    counts["skipped_target_exists"] += 1
                else:
                    shutil.move(str(source), str(target))
                    pruned = prune_empty_parents(source, source_root)
                    status = "moved"
                    detail = f"pruned={len(pruned)}"
                    counts["moved"] += 1
            except OSError as e:
                status = "error"
                detail = str(e)
                counts["error"] += 1

        log_rows.append(
            {
                "source_abs": str(source),
                "target_abs": str(target),
                "kind": row.get("kind", ""),
                "collision": row.get("collision", ""),
                "status": status,
                "detail": detail,
            }
        )

    with open(args.log, "w", encoding="utf8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["source_abs", "target_abs", "kind", "collision", "status", "detail"],
            delimiter=";",
        )
        w.writeheader()
        w.writerows(log_rows)

    print(f"Wrote {args.log}")
    for k, v in counts.items():
        print(f"  {k}: {v}")
    if dry_run:
        print("\nDry-run only. Re-run with --execute on the NAS host to move files.")
        print("Tip: --skip-collisions to move only non-colliding files first.")


if __name__ == "__main__":
    main()
