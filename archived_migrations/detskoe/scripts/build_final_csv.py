#!/usr/bin/env python3
"""
Merge all analysis passes into a single detskoe-final.csv (one row per file):
  base 1st OpenAI pass  ->  franchise/pocket overrides  ->  TMDB id resolve  ->  manual fixes.
Then assert the row count equals the number of files in detskoe-structure.txt.

NOT for production; ad-hoc analysis.
"""
from __future__ import annotations
import csv, json, re, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ARCHIVE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

STRUCT = ARCHIVE / "detskoe-structure.txt"
S = json.loads((REPO_ROOT / "config" / "settings.json").read_text(encoding="utf8"))
TMDB_KEY = S["tmdb"]["apiKey"]


def rels_from_structure() -> list[str]:
    out = []
    for line in STRUCT.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(line.split("Детское/", 1)[1] if "Детское/" in line else line)
    return out


def base_from_cache() -> dict:
    recs = {}
    for l in (ARCHIVE / "scripts" / ".cache_openai.jsonl").read_text(encoding="utf8").splitlines():
        if not l.strip():
            continue
        r = json.loads(l)
        if "error" in r:
            recs[r["rel"]] = {"kind": "undefined", "title": "", "year": "",
                              "season": "", "episode": "", "tmdb": "", "source": "error"}
            continue
        n = r["norm"]
        recs[r["rel"]] = {
            "kind": n["kind"], "title": n.get("title") or "", "year": n.get("year") or "",
            "season": n.get("season") or "", "episode": n.get("episode") or "",
            "tmdb": "", "source": "openai-pass1",
        }
    return recs


def apply_overrides(recs: dict):
    with open(ARCHIVE / "detskoe-franchise-films.csv", encoding="utf8") as f:
        for row in csv.DictReader(f, delimiter=";"):
            recs[row["path"]] = {"kind": "film", "title": row["model_title"],
                                 "year": row["model_year"], "season": "", "episode": "",
                                 "tmdb": row["tmdb_id"] or "", "source": "franchise"}
    with open(ARCHIVE / "detskoe-pocket1-series.csv", encoding="utf8") as f:
        for row in csv.DictReader(f, delimiter=";"):
            recs[row["path"]] = {"kind": "tv_show", "title": row["show"],
                                 "year": "", "season": row["season"], "episode": row["episode"],
                                 "tmdb": row["tmdb_id"] or "", "source": "pocket1"}
    with open(ARCHIVE / "detskoe-pocket2-films.csv", encoding="utf8") as f:
        for row in csv.DictReader(f, delimiter=";"):
            recs[row["path"]] = {"kind": "film", "title": row["model_title"],
                                 "year": row["model_year"], "season": "", "episode": "",
                                 "tmdb": row["tmdb_id"] or "", "source": "pocket2"}


_cache = {}
def tmdb_search(kind: str, title: str, year=None):
    key = (kind, title, year)
    if key in _cache:
        return _cache[key]
    ep = "tv" if kind == "tv_show" else "movie"
    p = {"api_key": TMDB_KEY, "language": "ru-RU", "query": title}
    if year and ep == "movie":
        p["year"] = year
    url = f"https://api.themoviedb.org/3/search/{ep}?" + urllib.parse.urlencode(p)
    val = ""
    for i in range(5):
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                res = json.load(r).get("results") or []
            val = str(res[0]["id"]) if res else ""
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < 4:
                time.sleep(2 ** i); continue
            break
        except Exception:
            break
    _cache[key] = val
    return val


# Manual fixes: exact rel path -> patch (borderline/typo cases). Prefix rule for the folder.
MANUAL_PREFIX = {
    "Котенок гав/": {"title": "Котёнок по имени Гав", "tmdb": "99955"},
}
MANUAL = {
    "Орион и Тьма (Netflix)[s1s1q720].mp4":
        {"kind": "film", "title": "Орион и Тьма", "season": "", "episode": "", "tmdb": "1139829"},
    "Чипполино.mp4":
        {"kind": "film", "title": "Чиполлино", "query": ("movie", "Чиполлино")},
    "Фиксики/ФиксиКИНО_Вселенная_приключений_Оригиналq480.mp4":
        {"kind": "film", "title": "ФиксиКИНО. Вселенная приключений", "tmdb": "966226"},
    "Paw Patrol/Улётная_помощь.mp4":
        {"kind": "film", "title": "Щенячий патруль: Улётная помощь", "tmdb": "743439"},
    # user-provided links (borderline):
    "Paw Patrol/На_старт,_внимание,_марш!.mp4":
        {"kind": "tv_show", "title": "Щенячий патруль: Спасение с воздуха",
         "season": "", "episode": "", "tmdb": "306769"},
    "Леди-Баг/из_Альтернативной_Вселенной_Приключения_в.mp4":
        {"kind": "film", "title": "Леди Баг и Супер-Кот: Приключения в альтернативной вселенной",
         "tmdb": "1147400"},
}


def main():
    rels = rels_from_structure()
    recs = base_from_cache()
    apply_overrides(recs)

    # resolve tmdb for anything still missing
    for rel in rels:
        d = recs.get(rel)
        if not d or d["tmdb"] or not d["title"] or d["kind"] == "undefined":
            continue
        d["tmdb"] = tmdb_search(d["kind"], d["title"], d["year"])

    # manual fixes (win over everything)
    for rel in rels:
        d = recs.get(rel)
        if d is None:
            continue
        for prefix, patch in MANUAL_PREFIX.items():
            if rel.startswith(prefix):
                d.update({k: v for k, v in patch.items() if k != "query"})
                d["source"] = "manual"
        if rel in MANUAL:
            patch = dict(MANUAL[rel])
            q = patch.pop("query", None)
            d.update(patch)
            if q and not patch.get("tmdb"):
                d["tmdb"] = tmdb_search(q[0], q[1])
            d["source"] = "manual"

    out = ARCHIVE / "detskoe-final.csv"
    with out.open("w", encoding="utf8") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["path", "kind", "title", "year", "season", "episode", "tmdb_id", "source"])
        for rel in rels:
            d = recs.get(rel) or {"kind": "MISSING", "title": "", "year": "",
                                  "season": "", "episode": "", "tmdb": "", "source": ""}
            w.writerow([rel, d["kind"], d["title"], d["year"], d["season"],
                        d["episode"], d["tmdb"], d["source"]])

    # verification + summary
    n_struct = len(rels)
    n_csv = sum(1 for _ in out.read_text(encoding="utf8").splitlines()) - 1
    from collections import Counter
    kinds = Counter(recs[r]["kind"] for r in rels if r in recs)
    no_tmdb = [r for r in rels if recs.get(r, {}).get("kind") in ("film", "tv_show")
               and not recs[r]["tmdb"]]
    print(f"files in detskoe-structure.txt : {n_struct}")
    print(f"rows in detskoe-final.csv      : {n_csv}")
    print(f"MATCH: {n_struct == n_csv}")
    print("kinds:", dict(kinds))
    print(f"still without tmdb id: {len(no_tmdb)}")
    for r in no_tmdb:
        print("   ", r, "->", recs[r]["kind"], recs[r]["title"])


if __name__ == "__main__":
    main()
