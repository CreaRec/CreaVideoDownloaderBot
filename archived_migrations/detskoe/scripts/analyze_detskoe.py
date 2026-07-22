#!/usr/bin/env python3
"""
Local recognition-ceiling analyzer for the "Детское" library.

NOT for production. This intentionally uses the FULL PATH (folder names + season
folders + filename) as context — unlike the app, which only sees the Telegram
filename. Goal: understand what COULD be recognized if folder context were used.

Pipeline mirrors the app conceptually:
  parse (kind/title/season/episode)  ->  TMDB resolve (ru-RU)  ->  Plex path.

Usage (from repo root):
  TMDB_API_KEY=xxx python3 archived_migrations/detskoe/scripts/analyze_detskoe.py
If TMDB_API_KEY is unset it is read from config/settings.json.
"""
from __future__ import annotations
import json, os, re, sys, urllib.parse, urllib.request
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

ROOT_MARKER = "Детское/"
LANG = "ru-RU"

# Top-level folders that are SERIES -> query used for TMDB /search/tv.
SERIES_TV_QUERY = {
    "Смешарики": "Смешарики",
    "Paw Patrol": "Щенячий патруль",
    "Том и Джерри": "Том и Джерри",
    "Фиксики": "Фиксики",
    "Леди-Баг": "Леди Баг и Супер-Кот",
    "Блуи": "Блуи",
    "Простоквашино": "Простоквашино",
    "Чип и Дейл спешат на помощь": "Чип и Дейл спешат на помощь",
    "Маша и медведь": "Маша и медведь",
    "Вуншпунш": "Вуншпунш",
    "Ну погоди": "Ну, погоди!",
    "Академия единорогов": "Академия единорогов",
    "Незнайка": "Незнайка",
    "Котенок гав": "Котёнок по имени Гав",
}

# Sub-folder that is actually a DISTINCT show (spin-off) -> its own tv query.
SUBFOLDER_TV_QUERY = {
    "Монстры за работой": "Монстры за работой",
}

# Top-level folders that are FILM franchises named with bare numbers.
FILM_FRANCHISE = {
    "Шрэк", "Ледниковый период", "Мадагаскар", "Отель Трансильвания",
    "Балто", "Тайная жизнь домашних животных", "Король лев",
}

JUNK = [
    "Полное дублирование", "Профессиональный многоголосый", "Дублированный",
    "Перевод 1", "Перевод 2", "Перевод", "Оригинал", "Провайдер 2", "Провайдер",
    "Невафильм", "Нева 1", "Пифагор", "iTunes", "MovieDalen", "Videofilm Ltd",
    "Zone Vision", "TVShows", "Netflix", "Мосфильм", "Первый канал", "ОРТ",
    "Мегафильм", "многоголосый",
]


def read_api_key() -> str:
    key = os.environ.get("TMDB_API_KEY")
    if key:
        return key
    cfg = json.loads((REPO_ROOT / "config" / "settings.json").read_text(encoding="utf8"))
    return cfg.get("tmdb", {}).get("apiKey", "")


API_KEY = read_api_key()
_cache: dict[str, dict | None] = {}


def tmdb(path: str, params: dict) -> dict | None:
    params = {"api_key": API_KEY, "language": LANG, **params}
    url = f"https://api.themoviedb.org/3{path}?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.load(r)
    except Exception:
        return None


def search_tv(query: str) -> dict | None:
    ck = "tv::" + query
    if ck in _cache:
        return _cache[ck]
    data = tmdb("/search/tv", {"query": query})
    res = (data or {}).get("results") or []
    out = None
    if res:
        top = res[0]
        out = {"tmdb": top["id"], "title": top.get("name"),
               "year": (top.get("first_air_date") or "")[:4]}
    _cache[ck] = out
    return out


def search_movie(query: str) -> dict | None:
    ck = "mv::" + query
    if ck in _cache:
        return _cache[ck]
    data = tmdb("/search/movie", {"query": query})
    res = (data or {}).get("results") or []
    out = None
    if res:
        top = res[0]
        out = {"tmdb": top["id"], "title": top.get("title"),
               "year": (top.get("release_date") or "")[:4]}
    _cache[ck] = out
    return out


def clean_movie_title(name: str) -> str:
    n = re.sub(r"\.[A-Za-z0-9]+$", "", name)
    n = n.replace("_", " ").replace("｜", " ").replace("|", " ")
    n = re.sub(r"\[[^\]]*\]", " ", n)
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"\b\d?q\d{3,4}\b", " ", n)
    n = re.sub(r"\bs\d+s\d+\w*\b", " ", n)
    n = re.sub(r"\b(1080p|720p|480p)\b", " ", n)
    n = re.sub(r"^\d+\.\s*", "", n)          # leading "1. "
    for j in JUNK:
        i = n.lower().find(j.lower())
        if i != -1:
            n = n[:i]
    return re.sub(r"\s+", " ", n).strip(" -:.")


def detect_season(dir_segments: list[str]) -> tuple[int | None, bool]:
    """Return (season, explicit). explicit=False means assumed."""
    for seg in dir_segments:
        m = re.search(r"(?:^|[._ ])S(\d{1,2})(?:[._ ]|$)", seg)
        if m:
            return int(m.group(1)), True
        m = re.search(r"Season[ _]?(\d+)", seg, re.I)
        if m:
            return int(m.group(1)), True
        m = re.search(r"Сезон\s?(\d+)", seg, re.I)
        if m:
            return int(m.group(1)), True
    for seg in dir_segments:
        if re.fullmatch(r"\d{1,2}", seg.strip()):
            return int(seg.strip()), True
    return None, False


def detect_episode(stem: str) -> tuple[int | None, int | None, str | None]:
    """Return (episode, season_from_name, note)."""
    m = re.match(r"s(\d+)s(\d+)", stem, re.I)          # Маша: s1s10
    if m:
        return int(m.group(2)), int(m.group(1)), None
    m = re.search(r"S(\d+)E(\d+)", stem, re.I)
    if m:
        return int(m.group(2)), int(m.group(1)), None
    if re.fullmatch(r"\d+", stem):
        return int(stem), None, None
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", stem)        # 127-129
    if m:
        return int(m.group(1)), None, f"диапазон {m.group(1)}-{m.group(2)}"
    return None, None, None


def classify(rel_path: str) -> dict:
    parts = rel_path.split("/")
    top = parts[0]
    filename = parts[-1]
    dir_segments = parts[:-1]
    stem = re.sub(r"\.[A-Za-z0-9]+$", "", filename)

    ep, season_from_name, note = detect_episode(stem)
    season_from_dir, explicit = detect_season(dir_segments)
    parent = dir_segments[-1] if dir_segments else ""

    # Spin-off subfolder = its own show.
    if parent in SUBFOLDER_TV_QUERY:
        season = season_from_name or season_from_dir or 1
        info = search_tv(SUBFOLDER_TV_QUERY[parent])
        return _tv(rel_path, SUBFOLDER_TV_QUERY[parent], season, ep, info,
                   explicit or season_from_name is not None, note)

    is_series = (top in SERIES_TV_QUERY) or explicit or ("сериал" in parent.lower())

    # TV show branch.
    if is_series and ep is not None:
        season = season_from_name or season_from_dir or 1
        query = SERIES_TV_QUERY.get(top, top)
        info = search_tv(query)
        assumed = not (explicit or season_from_name is not None)
        return _tv(rel_path, query, season, ep, info, not assumed, note)

    # Film franchise with numeric names (Shrek/1.mp4 ...).
    if top in FILM_FRANCHISE and ep is not None:
        info = search_movie(top)
        return {"path": rel_path, "kind": "film", "title": top,
                "detail": f"часть {ep} франшизы",
                "tmdb": info and info["tmdb"], "match": info,
                "note": "числовое имя: конкретный фильм определяется по порядку"}

    # Descriptive filename -> film.
    if ep is None:
        title = clean_movie_title(filename)
        info = search_movie(title) if title else None
        return {"path": rel_path, "kind": "film", "title": title,
                "detail": None, "tmdb": info and info["tmdb"], "match": info,
                "note": None if title else "не удалось извлечь название"}

    # Numeric name, no series context, not a known franchise -> ambiguous.
    return {"path": rel_path, "kind": "undefined", "title": None,
            "detail": None, "tmdb": None, "match": None,
            "note": "числовое имя без контекста сезона/шоу"}


def _tv(path, title, season, ep, info, confident, note):
    return {"path": path, "kind": "tv_show",
            "title": info["title"] if info else title,
            "detail": f"S{season:02d}E{ep:02d}",
            "season": season, "episode": ep,
            "tmdb": info and info["tmdb"], "match": info,
            "note": note if confident else (note + "; " if note else "") + "сезон предположительно"}


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else str(ARCHIVE / "detskoe-structure.txt"))
    lines = [l.strip() for l in src.read_text(encoding="utf8").splitlines() if l.strip()]

    results = []
    for line in lines:
        idx = line.find(ROOT_MARKER)
        rel = line[idx + len(ROOT_MARKER):] if idx != -1 else line
        results.append(classify(rel))

    counts = {"film": 0, "tv_show": 0, "undefined": 0}
    for r in results:
        counts[r["kind"]] += 1

    # Console summary.
    total = len(results)
    print(f"TOTAL: {total}")
    for k in ("tv_show", "film", "undefined"):
        print(f"  {k:9}: {counts[k]:5}  ({counts[k]*100/total:.1f}%)")

    # CSV.
    csv = ARCHIVE / "detskoe-recognition-full.csv"
    with csv.open("w", encoding="utf8") as f:
        f.write("path;kind;title;detail;tmdb;match_title;match_year;note\n")
        for r in results:
            m = r.get("match") or {}
            f.write(";".join([
                r["path"], r["kind"], str(r.get("title") or ""),
                str(r.get("detail") or ""), str(r.get("tmdb") or ""),
                str(m.get("title") or ""), str(m.get("year") or ""),
                str(r.get("note") or ""),
            ]) + "\n")
    print(f"Wrote {csv}")

    # Per-show grouping for TV.
    shows: dict[str, dict] = {}
    for r in results:
        if r["kind"] != "tv_show":
            continue
        key = r["title"]
        s = shows.setdefault(key, {"count": 0, "seasons": set(),
                                    "tmdb": r.get("tmdb"),
                                    "year": (r.get("match") or {}).get("year")})
        s["count"] += 1
        if r.get("season"):
            s["seasons"].add(r["season"])

    print("\n=== TV SHOWS (recognized via path) ===")
    for name, s in sorted(shows.items(), key=lambda kv: -kv[1]["count"]):
        seasons = ",".join(str(x) for x in sorted(s["seasons"]))
        print(f"  {s['count']:4}  {name} ({s['year']}) [tmdb-{s['tmdb']}]  сезоны: {seasons}")

    unresolved = [r for r in results if r["tmdb"] is None]
    print(f"\nUNRESOLVED (no TMDB / undefined): {len(unresolved)}")
    for r in unresolved:
        print(f"  [{r['kind']}] {r['path']}  -- {r.get('note') or ''}")


if __name__ == "__main__":
    main()
