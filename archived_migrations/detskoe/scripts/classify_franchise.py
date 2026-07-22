#!/usr/bin/env python3
"""
Second pass for numeric-named franchise films (Шрэк/1.mp4 = 1st Shrek film ...).
Special instruction: folder = franchise, filename number = release-order index.
Then verify the returned title against TMDB (ru-RU).

NOT for production; ad-hoc analysis.
"""
from __future__ import annotations
import json, re, time, urllib.parse, urllib.request
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

STRUCT = ARCHIVE / "detskoe-structure.txt"
SETTINGS = json.loads((REPO_ROOT / "config" / "settings.json").read_text(encoding="utf8"))
OA_KEY = SETTINGS["openai"]["apiKey"]
MODEL = SETTINGS["openai"].get("model", "gpt-4o-mini")
TMDB_KEY = SETTINGS["tmdb"]["apiKey"]

FRANCHISES = {
    "Шрэк", "Ледниковый период", "Мадагаскар", "Отель Трансильвания",
    "Балто", "Тайная жизнь домашних животных", "Король лев",
}

SYSTEM = """Ты возвращаешь ПОЛНУЮ фильмографию киновселенной/франшизы по порядку выхода.
На вход даётся название франшизы (имя папки, часто по-русски).
Верни строго JSON:
{"films": [{"title": "русское название", "original_title": "оригинал", "year": число}, ...]}
Правила:
- Только полнометражные фильмы ОСНОВНОЙ линейки, отсортированные по дате премьеры (самый ранний — первый).
- Не добавляй спин-оффы, короткометражки и сериалы.
- Индекс в массиве соответствует порядковому номеру фильма (первый элемент = 1-й фильм).
- Русское название — как в российском прокате.
- Отвечай только JSON."""


def franchise_files():
    out = []
    for line in STRUCT.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if "Детское/" not in line:
            continue
        rel = line.split("Детское/", 1)[1]
        parts = rel.split("/")
        top = parts[0]
        stem = re.sub(r"\.[A-Za-z0-9]+$", "", parts[-1])
        if top in FRANCHISES and re.fullmatch(r"\d+", stem):
            out.append((rel, top, int(stem)))
    return sorted(out)


_filmography_cache: dict[str, list] = {}


def franchise_filmography(franchise: str) -> list:
    if franchise in _filmography_cache:
        return _filmography_cache[franchise]
    body = json.dumps({
        "model": MODEL, "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps({"franchise": franchise}, ensure_ascii=False)},
        ],
    }).encode("utf8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions", data=body,
        headers={"Authorization": f"Bearer {OA_KEY}", "Content-Type": "application/json"},
        method="POST")
    for i in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            films = json.loads(data["choices"][0]["message"]["content"]).get("films", [])
            _filmography_cache[franchise] = films
            return films
        except urllib.error.HTTPError as e:  # type: ignore
            if e.code == 429 and i < 5:
                time.sleep(2 ** i); continue
            raise
    raise RuntimeError("unreachable")


def tmdb_verify(title: str, year=None) -> dict | None:
    params = {"api_key": TMDB_KEY, "language": "ru-RU", "query": title}
    if year:
        params["year"] = year
    url = "https://api.themoviedb.org/3/search/movie?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            data = json.load(r)
    except Exception:
        return None
    res = data.get("results") or []
    if not res:
        return None
    t = res[0]
    return {"tmdb": t["id"], "title": t.get("title"), "year": (t.get("release_date") or "")[:4]}


def main():
    files = franchise_files()
    print(f"franchise numeric files: {len(files)}\n")
    rows = []
    for rel, franchise, n in files:
        films = franchise_filmography(franchise)
        film = films[n - 1] if 0 < n <= len(films) else None
        title = (film or {}).get("title", "") if film else ""
        year = (film or {}).get("year") if film else None
        v = tmdb_verify(title, year) if title else None
        rows.append((rel, franchise, n, title, year, v))
        vs = f"{v['title']} ({v['year']}) [tmdb-{v['tmdb']}]" if v else "(TMDB miss)"
        flag = "" if film else "  !! номер вне списка франшизы"
        print(f"{rel:45} => {title} ({year})  | TMDB: {vs}{flag}")

    out = ARCHIVE / "detskoe-franchise-films.csv"
    with out.open("w", encoding="utf8") as f:
        f.write("path;franchise;n;model_title;model_year;tmdb_title;tmdb_year;tmdb_id\n")
        for rel, fr, n, title, year, v in rows:
            v = v or {}
            f.write(";".join(map(str, [rel, fr, n, title, year or "",
                                       v.get("title", ""), v.get("year", ""), v.get("tmdb", "")])) + "\n")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    import urllib.error
    main()
