#!/usr/bin/env python3
"""
Recover the two remaining 'undefined' pockets from the real OpenAI run, each with
a tailored instruction:

  Pocket 1 (numeric episodes in folders WITHOUT a season number):
      instruction allows assuming season = 1 when no explicit season in path,
      and infers show title from folder. -> tv_show + TMDB tv id.

  Pocket 2 (descriptive single films/specials misread as series episodes):
      instruction says "standalone film/special, ignore series-folder context".
      -> film + TMDB movie id.

NOT for production; ad-hoc analysis. Reads pockets from scripts/.cache_openai.jsonl.
"""
from __future__ import annotations
import json, re, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

S = json.loads((REPO_ROOT / "config" / "settings.json").read_text(encoding="utf8"))
OA_KEY = S["openai"]["apiKey"]
MODEL = S["openai"].get("model", "gpt-4o-mini")
TMDB_KEY = S["tmdb"]["apiKey"]
FRAN = {"Шрэк", "Ледниковый период", "Мадагаскар", "Отель Трансильвания",
        "Балто", "Тайная жизнь домашних животных"}

SYS_SERIES = """Тебе дают путь к файлу-эпизоду детского мультсериала (папки + имя файла).
Определи сериал по именам папок и номер серии по имени файла. Верни строго JSON:
{"title": "каноничное русское название сериала", "season": число, "episode": число,
 "confidence": 0..1, "reason": "кратко"}
Правила:
- Название сериала бери из имён папок (очисти от служебных слов вроде "(сериал)").
- season: если в пути ЯВНО указан сезон (Season N / Сезон N / SNN) — используй его.
  Если сезон не указан, но это явно один цельный сезонный набор — ставь season = 1.
  Папка "Новый сезон" означает более поздний сезон: если точный номер неизвестен, ставь 1.
- episode: число из имени файла.
- Это ЭПИЗОД сериала, а не фильм. confidence ставь высоким, если сериал и номер серии ясны."""

SYS_FILM = """Тебе дают путь к файлу (папки + имя файла). Это САМОСТОЯТЕЛЬНЫЙ
полнометражный фильм ИЛИ киноспецвыпуск (полнометражка/короткометражка), а НЕ серия сериала —
даже если файл лежит внутри папки сериала. Не требуй номер сезона/серии.
Определи конкретный фильм. Верни строго JSON:
{"title": "русское название фильма", "original_title": "оригинал",
 "year": число или null, "confidence": 0..1, "reason": "кратко"}
Правила:
- Игнорируй теги озвучки/качества/провайдера (Дублированный, Провайдер 2, q720, Оригинал и т.п.).
- Имя папки может быть частью названия (напр. "Мадагаскар / Пингвины Мадагаскара").
- Если это классический советский мультфильм — верни его каноничное название и год."""


def chat(system: str, payload: dict) -> dict:
    body = json.dumps({
        "model": MODEL, "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
    }).encode("utf8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions", data=body,
        headers={"Authorization": f"Bearer {OA_KEY}", "Content-Type": "application/json"},
        method="POST")
    for i in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(json.load(r)["choices"][0]["message"]["content"])
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < 5:
                time.sleep(2 ** i); continue
            raise
    raise RuntimeError("unreachable")


def tmdb(kind: str, title: str, year=None) -> dict | None:
    p = {"api_key": TMDB_KEY, "language": "ru-RU", "query": title}
    if year and kind == "movie":
        p["year"] = year
    url = f"https://api.themoviedb.org/3/search/{kind}?" + urllib.parse.urlencode(p)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            res = (json.load(r).get("results") or [])
    except Exception:
        return None
    if not res:
        return None
    t = res[0]
    name = t.get("title") or t.get("name")
    date = t.get("release_date") or t.get("first_air_date") or ""
    return {"tmdb": t["id"], "title": name, "year": date[:4]}


def load_pockets():
    recs = {}
    for l in (ARCHIVE / "scripts" / ".cache_openai.jsonl").read_text(encoding="utf8").splitlines():
        if l.strip():
            r = json.loads(l); recs[r["rel"]] = r
    p1, p2 = {}, []
    for rel, r in recs.items():
        if "error" in r or r["norm"]["kind"] != "undefined":
            continue
        parts = rel.split("/"); top = parts[0]
        stem = re.sub(r"\.[A-Za-z0-9]+$", "", parts[-1])
        if re.fullmatch(r"\d+", stem):
            if top in FRAN:
                continue
            p1.setdefault("/".join(parts[:-1]), []).append(rel)
        else:
            p2.append(rel)
    return p1, p2


def main():
    p1, p2 = load_pockets()
    tv_cache = {}
    rows1 = []

    print("=== POCKET 1: episodes in folders without season ===")
    for folder, rels in sorted(p1.items(), key=lambda kv: -len(kv[1])):
        sample = rels[0]
        meta = chat(SYS_SERIES, {"path": "Детское/" + sample,
                                 "folders": folder, "note": "определи сериал и сезон"})
        show = meta.get("title", "")
        season = meta.get("season") or 1
        if show not in tv_cache:
            tv_cache[show] = tmdb("tv", show)
        v = tv_cache[show]
        vs = f"{v['title']} ({v['year']}) [tmdb-{v['tmdb']}]" if v else "(TMDB miss)"
        print(f"{len(rels):4}  {folder}  -> {show} S{int(season):02d}  | TMDB: {vs}")
        for rel in rels:
            ep = int(re.sub(r"\.[A-Za-z0-9]+$", "", rel.split('/')[-1]))
            rows1.append((rel, show, season, ep, v))

    print("\n=== POCKET 2: standalone films/specials ===")
    rows2 = []
    for rel in sorted(p2):
        r = chat(SYS_FILM, {"path": "Детское/" + rel})
        title = r.get("title", "")
        v = tmdb("movie", title, r.get("year"))
        vs = f"{v['title']} ({v['year']}) [tmdb-{v['tmdb']}]" if v else "(TMDB miss)"
        print(f"{rel:60} -> {title} ({r.get('year')}) conf={r.get('confidence')}  | TMDB: {vs}")
        rows2.append((rel, title, r.get("year"), r.get("confidence"), v))

    with (ARCHIVE / "detskoe-pocket1-series.csv").open("w", encoding="utf8") as f:
        f.write("path;show;season;episode;tmdb_title;tmdb_year;tmdb_id\n")
        for rel, show, season, ep, v in rows1:
            v = v or {}
            f.write(";".join(map(str, [rel, show, season, ep, v.get("title", ""),
                                       v.get("year", ""), v.get("tmdb", "")])) + "\n")
    with (ARCHIVE / "detskoe-pocket2-films.csv").open("w", encoding="utf8") as f:
        f.write("path;model_title;model_year;confidence;tmdb_title;tmdb_year;tmdb_id\n")
        for rel, title, year, conf, v in rows2:
            v = v or {}
            f.write(";".join(map(str, [rel, title, year or "", conf or "", v.get("title", ""),
                                       v.get("year", ""), v.get("tmdb", "")])) + "\n")
    print(f"\nPocket1 recovered: {len(rows1)} episodes;  Pocket2: {len(rows2)} films")
    print("Wrote detskoe-pocket1-series.csv, detskoe-pocket2-films.csv")


if __name__ == "__main__":
    main()
