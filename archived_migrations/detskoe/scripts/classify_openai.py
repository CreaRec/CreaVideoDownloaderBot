#!/usr/bin/env python3
"""
Real classifier run: send every file to the SAME OpenAI classifier the app uses
(config/media-classification-instructions.md), but feed the FULL PATH context
(folder names + season folder + filename) via the description field.

NOT for production; ad-hoc analysis. Results are cached so re-runs are cheap.

Usage (from repo root):
  python3 archived_migrations/detskoe/scripts/classify_openai.py [--limit N] [--workers 8]
"""
from __future__ import annotations
import argparse, json, random, re, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

ROOT_MARKER = "Детское/"
MIN_CONFIDENCE = 0.7
CACHE = ARCHIVE / "scripts" / ".cache_openai.jsonl"
SETTINGS = REPO_ROOT / "config" / "settings.json"

cfg = json.loads(SETTINGS.read_text(encoding="utf8"))
API_KEY = cfg["openai"]["apiKey"]
MODEL = cfg["openai"].get("model", "gpt-4o-mini")
INSTR_PATH = cfg["openai"].get("instructionsPath", "config/media-classification-instructions.md")
_instr = Path(INSTR_PATH)
if not _instr.is_absolute():
    _instr = REPO_ROOT / _instr
INSTRUCTIONS = _instr.read_text(encoding="utf8")

_lock = threading.Lock()


def build_input(rel: str) -> dict:
    parts = rel.split("/")
    filename = parts[-1]
    dir_parts = parts[:-1]
    description = (
        "Контекст из файловой системы (используй имена папок как название "
        "мультфильма/мультсериала и номер сезона, номер серии бери из имени файла).\n"
        f"Полный путь: Детское/{rel}\n"
        f"Папки: {' / '.join(dir_parts) if dir_parts else '(нет)'}\n"
        f"Имя файла: {filename}"
    )
    return {"filename": filename, "description": description}


def call_openai(payload: dict) -> dict:
    body = json.dumps({
        "model": MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": INSTRUCTIONS},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
    }).encode("utf8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions", data=body,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    attempts = 8
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < attempts - 1:
                time.sleep(min(60, 2 ** i) + random.uniform(0, 1.5))
                continue
            raise
    raise RuntimeError("unreachable")


def normalize(resp: dict) -> dict:
    """Mirror src/metadata/media-classifier.ts normalizeClassification."""
    conf = resp.get("confidence") or 0
    kind = resp.get("kind")
    if conf < MIN_CONFIDENCE:
        return {"kind": "undefined", "reason": resp.get("reason", "low confidence")}
    if kind == "film" and resp.get("title"):
        return {"kind": "film", "title": resp["title"], "year": resp.get("year")}
    if kind == "tv_show" and resp.get("title") and resp.get("season") and resp.get("episode"):
        return {"kind": "tv_show", "title": resp["title"], "year": resp.get("year"),
                "season": resp["season"], "episode": resp["episode"],
                "episodeTitle": resp.get("episodeTitle")}
    return {"kind": "undefined", "reason": resp.get("reason", "missing fields")}


def load_cache() -> dict:
    done = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding="utf8").splitlines():
            if line.strip():
                rec = json.loads(line)
                done[rec["rel"]] = rec
    return done


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", default=str(ARCHIVE / "detskoe-structure.txt"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    lines = [l.strip() for l in Path(args.src).read_text(encoding="utf8").splitlines() if l.strip()]
    rels = []
    for line in lines:
        idx = line.find(ROOT_MARKER)
        rels.append(line[idx + len(ROOT_MARKER):] if idx != -1 else line)
    if args.limit:
        rels = rels[:args.limit]

    done = load_cache()
    todo = [r for r in rels if r not in done or "error" in done[r]]
    print(f"total={len(rels)} cached_ok={len(rels)-len(todo)} todo={len(todo)}")

    counter = {"n": 0, "err": 0}

    def work(rel: str):
        try:
            raw = call_openai(build_input(rel))
            norm = normalize(raw)
            rec = {"rel": rel, "raw": raw, "norm": norm}
        except Exception as e:
            rec = {"rel": rel, "error": str(e)}
        with _lock:
            with CACHE.open("a", encoding="utf8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            counter["n"] += 1
            if "error" in rec:
                counter["err"] += 1
            if counter["n"] % 50 == 0 or counter["n"] == len(todo):
                print(f"  {counter['n']}/{len(todo)} done (errors={counter['err']})", flush=True)
        return rec

    if todo:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            list(ex.map(work, todo))

    # Summarize from cache.
    done = load_cache()
    counts = {"film": 0, "tv_show": 0, "undefined": 0, "error": 0}
    rows = []
    for rel in rels:
        rec = done.get(rel)
        if not rec or "error" in (rec or {}):
            counts["error"] += 1
            rows.append((rel, "error", rec.get("error", "") if rec else "missing", "", "", ""))
            continue
        n = rec["norm"]
        counts[n["kind"]] += 1
        detail = ""
        if n["kind"] == "tv_show":
            detail = f"S{int(n['season']):02d}E{int(n['episode']):02d}"
        rows.append((rel, n["kind"], n.get("title") or "", str(n.get("year") or ""),
                     detail, str(rec["raw"].get("confidence") or "")))

    out = ARCHIVE / "detskoe-openai-classification.csv"
    with out.open("w", encoding="utf8") as f:
        f.write("path;kind;title;year;detail;confidence\n")
        for r in rows:
            f.write(";".join(r) + "\n")

    total = len(rels)
    print(f"\n=== REAL OpenAI classification (path context), model={MODEL} ===")
    print(f"TOTAL: {total}")
    for k in ("tv_show", "film", "undefined", "error"):
        print(f"  {k:9}: {counts[k]:5} ({counts[k]*100/total:.1f}%)")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
