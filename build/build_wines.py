# -*- coding: utf-8 -*-
"""Compile the wine regions the game asks about, ranked by how well known
they are.

    python3 build/build_wines.py data/wines.js

The regions themselves - which, where, and the grapes they are known for -
are written by hand in build/wines_table.py: Wikidata has no list worth
crawling (see there). This looks each one up only to rank it, from the
same two signals City Guesser uses:

  * English Wikipedia pageviews over the last twelve months - what people
    actually look up.
  * Wikidata sitelinks - how many Wikipedias carry an article, which keeps
    the ranking from being only English-speaking.

Each is turned into a percentile over the table and weighted. The bottom
of the table is still a region worth asking about, so the score is lifted
onto FLOOR..1 rather than 0..1: js/app.js picks by score squared, and a
region scoring nothing would never come up.

Wikidata also checks the table: a region whose Wikidata country is not the
table's, or whose Wikidata coordinates sit more than CHECK_KM from the
table's, is reported (a fair few have no coordinates at all - that is why
the table carries its own). Responses are cached under build/cache/, so a
rebuild is quick; --refresh fetches everything again.

The facts a player can ask for as a hint are written by hand, not fetched:
build/wines_facts.json, keyed by Wikidata id, three short sentences per
region that name neither the region, its country nor its state/province.
Every region, with its score and anything the checks found, goes to
build/wines_review.csv.
"""
import csv
import datetime
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_map import normalize_answer, slug  # noqa: E402
from countries_table import COUNTRIES, MERGE_INTO  # noqa: E402
from wines_table import WINES  # noqa: E402

W_VIEWS = 0.65            # weight of the English pageview percentile
W_LINKS = 0.35            # ... and of the sitelink percentile
FLOOR = 0.4               # the score of the least known region in the table
CHECK_KM = 150            # Wikidata's point this far from the table's is reported
BATCH = 150               # Wikidata items per detail query
VIEW_THREADS = 4          # parallel pageview requests

# Words too common in region names to give one away in a fact.
GENERIC = {"valley", "county", "hills", "river", "region", "peninsula", "lakes",
           "hill", "country", "coast", "santa", "saint", "central", "della", "di"}

CACHE = os.path.join(HERE, "cache")
REVIEW = os.path.join(HERE, "wines_review.csv")
FACTS = os.path.join(HERE, "wines_facts.json")
TOPO = os.path.join(HERE, "countries-50m.json")
SPARQL = "https://qlever.dev/api/wikidata"
PREFIXES = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
"""
PAGEVIEWS = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
             "en.wikipedia/all-access/user/{title}/monthly/{start}/{end}")
AGENT = "WineGuesser-build/1.0 (https://github.com/mmunson2/CountryGuesser)"

ENTITY = "http://www.wikidata.org/entity/"


# ------------------------------------------------------------------ fetching
def fetch(url, data=None, tries=8):
    request = urllib.request.Request(url, data=data, headers={
        "User-Agent": AGENT,
        "Accept": "application/sparql-results+json, application/json",
    })
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            if err.code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                raise
            wait = err.headers.get("Retry-After")
            if wait and wait.isdigit():
                time.sleep(int(wait))
                continue
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
        time.sleep(min(60, 2 ** attempt))


def sparql(query):
    """Rows of {variable: value}, from QLever's copy of Wikidata.

    QLever rather than query.wikidata.org, as in City Guesser's build: it
    answers in seconds, but wants its prefixes spelled out.
    """
    body = urllib.parse.urlencode({"query": PREFIXES + query}).encode()
    rows = fetch(SPARQL, data=body)["results"]["bindings"]
    return [{k: v["value"] for k, v in row.items()} for row in rows]


def cached(name, refresh, make):
    path = os.path.join(CACHE, name)
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    value = make()
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False)
    return value


def qid(uri):
    return uri[len(ENTITY):] if uri.startswith(ENTITY) else uri


# ----------------------------------------------------------------- wikidata
def details(ids, refresh):
    """English article, sitelinks, coordinates and countries of each region.

    The cache is topped up rather than rebuilt: a region added to the table
    is fetched on its own.
    """
    path = os.path.join(CACHE, "details.json")
    out = {}
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            out = json.load(f)
    todo = sorted(set(ids) - set(out))
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        print("  details %d-%d of %d" % (i + 1, i + len(chunk), len(todo)), file=sys.stderr)
        for q in chunk:
            out[q] = None            # stays None if Wikidata has no such item
        rows = sparql("""
            SELECT ?item ?links
              (SAMPLE(?title) AS ?article) (SAMPLE(?coord) AS ?where)
              (GROUP_CONCAT(DISTINCT STR(?country); SEPARATOR=" ") AS ?countries)
            WHERE {
              VALUES ?item { %s }
              ?item wikibase:sitelinks ?links .
              OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ;
                            schema:name ?title }
              OPTIONAL { ?item wdt:P625 ?coord }
              OPTIONAL { ?item wdt:P17 ?country }
            }
            GROUP BY ?item ?links""" % " ".join("wd:" + q for q in chunk))
        for r in rows:
            out[qid(r["item"])] = {
                "article": r.get("article"),
                "sitelinks": int(r["links"]),
                "coord": r.get("where"),
                "countries": [qid(c) for c in r.get("countries", "").split()],
            }
    if todo:
        os.makedirs(CACHE, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
    return out


def countries_of_world(refresh):
    """Every country Wikidata knows: {qid: {numeric, names, capitals}}."""
    def make():
        rows = sparql("""
            SELECT ?c ?num ?label ?alias ?cap WHERE {
              { ?c wdt:P31 wd:Q3624078 } UNION { ?c wdt:P31 wd:Q6256 }
              OPTIONAL { ?c wdt:P299 ?num }
              OPTIONAL { ?c rdfs:label ?label . FILTER(LANG(?label) = "en") }
              OPTIONAL { ?c skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
              OPTIONAL { ?c wdt:P36 ?cap }
            }""")
        out = {}
        for r in rows:
            entry = out.setdefault(qid(r["c"]), {"numeric": None, "names": [], "capitals": []})
            if r.get("num"):
                entry["numeric"] = r["num"]
            for key in ("label", "alias"):
                if r.get(key) and r[key] not in entry["names"]:
                    entry["names"].append(r[key])
            if r.get("cap") and qid(r["cap"]) not in entry["capitals"]:
                entry["capitals"].append(qid(r["cap"]))
        return out
    return cached("countries.json", refresh, make)


# ---------------------------------------------------------------- pageviews
def view_window(today=None):
    """The last twelve whole months, as the API wants them."""
    today = today or datetime.date.today()
    end = today.replace(day=1) - datetime.timedelta(days=1)
    start = datetime.date(end.year - 1, end.month, 1) + datetime.timedelta(days=32)
    start = start.replace(day=1)
    return start.strftime("%Y%m%d"), end.strftime("%Y%m%d")


def pageviews(titles, refresh):
    start, end = view_window()
    name = "pageviews-%s-%s.json" % (start, end)
    path = os.path.join(CACHE, name)
    have = {}
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            have = json.load(f)
    missing = sorted(set(titles) - set(have))

    def one(title):
        url = PAGEVIEWS.format(title=urllib.parse.quote(title.replace(" ", "_"), safe=""),
                               start=start, end=end)
        data = fetch(url)
        return title, sum(i["views"] for i in data["items"]) if data else 0

    if missing:
        print("  pageviews for %d articles (%s-%s)" % (len(missing), start, end),
              file=sys.stderr)
        os.makedirs(CACHE, exist_ok=True)

        def keep():
            with open(path, "w", encoding="utf-8") as f:
                json.dump(have, f, ensure_ascii=False)

        # Saved as it goes, so a run cut short by rate limits picks up here.
        try:
            with ThreadPoolExecutor(VIEW_THREADS) as pool:
                for done, (title, views) in enumerate(pool.map(one, missing), 1):
                    have[title] = views
                    if done % 250 == 0:
                        print("    %d / %d" % (done, len(missing)), file=sys.stderr)
                        keep()
        finally:
            keep()
    return have


# --------------------------------------------------------------- countries
def country_matcher(world):
    """Wikidata country qid -> the game's country slug.

    By ISO 3166 numeric code through the map's own TopoJSON ids first, then
    by English name or alias for the countries that have no code there.
    """
    with open(TOPO, encoding="utf-8") as f:
        topo = json.load(f)
    by_ne = {}
    for ne_name, display, region, aliases in COUNTRIES:
        info = {"id": slug(display), "region": region, "name": display}
        if ne_name:
            by_ne[ne_name] = info
        for extra, parent in MERGE_INTO.items():
            if parent == ne_name:
                by_ne[extra] = info
    by_numeric = {}
    for g in topo["objects"]["countries"]["geometries"]:
        if g.get("id") and g["properties"]["name"] in by_ne:
            by_numeric[g["id"]] = by_ne[g["properties"]["name"]]

    by_name = {}
    for ne_name, display, region, aliases in COUNTRIES:
        info = {"id": slug(display), "region": region, "name": display}
        for answer in [display] + list(aliases):
            by_name.setdefault(normalize_answer(answer), info)

    table = {}
    for q, c in world.items():
        hit = by_numeric.get(c["numeric"]) if c["numeric"] else None
        if not hit:
            for name in c["names"]:
                hit = by_name.get(normalize_answer(name))
                if hit:
                    break
        if hit:
            table[q] = hit
    return table


# ------------------------------------------------------------------- scoring
def percentiles(values):
    """{key: value} -> {key: 0..1}, ties sharing the same rank."""
    order = sorted(set(values.values()))
    if len(order) < 2:
        return {k: 1.0 for k in values}
    place = {v: i / (len(order) - 1) for i, v in enumerate(order)}
    return {k: place[v] for k, v in values.items()}


def parse_point(text):
    # "Point(lon lat)"
    lon, lat = text[text.index("(") + 1:text.index(")")].split()
    return float(lon), float(lat)


def distance_km(a, b):
    (lon1, lat1), (lon2, lat2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = (math.sin((p2 - p1) / 2) ** 2 +
         math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6371 * math.asin(min(1, math.sqrt(h)))


def giveaways(fact, name, country, division):
    """The words in a fact that name its own region, country or division."""
    text = " %s " % normalize_answer(fact)
    words = [name, country] + ([division] if division else [])
    words += [w for w in normalize_answer(name).split() if len(w) > 3 and w not in GENERIC]
    return sorted({normalize_answer(w) for w in words if " %s " % normalize_answer(w) in text})


# ---------------------------------------------------------------------- main
def check_table():
    """The table, as dicts, or SystemExit on a row no build should get past."""
    games = {display: {"id": slug(display), "region": region}
             for _, display, region, _ in COUNTRIES}
    rows, seen, bad = [], set(), []
    for q, name, country, division, lon, lat, grapes in WINES:
        if q in seen:
            bad.append("%s (%s) is in the table twice" % (q, name))
        seen.add(q)
        if country not in games:
            bad.append("%s: no country %r in build/countries_table.py" % (name, country))
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            bad.append("%s: %s, %s is not a longitude and latitude" % (name, lon, lat))
        rows.append({"id": q, "name": name, "country": games[country]["id"],
                     "countryName": country, "region": games[country]["region"],
                     "division": division, "lon": lon, "lat": lat, "grapes": list(grapes)})
    if bad:
        raise SystemExit("build/wines_table.py:\n  " + "\n  ".join(bad))
    return rows


def main(dst, refresh=False):
    table = check_table()
    print("%d regions in the table" % len(table), file=sys.stderr)
    info = details([w["id"] for w in table], refresh)
    match = country_matcher(countries_of_world(refresh))
    with open(FACTS, encoding="utf-8") as f:
        facts = json.load(f)

    review = {}
    for w in table:
        d = info.get(w["id"]) or {}
        notes = []
        if not d:
            notes.append("no such Wikidata item")
        elif not d["article"]:
            notes.append("no English Wikipedia article")
        wd_countries = {match[c]["name"] for c in d.get("countries", []) if c in match}
        if wd_countries and w["countryName"] not in wd_countries:
            notes.append("Wikidata says %s" % " / ".join(sorted(wd_countries)))
        km = None
        if d.get("coord"):
            km = distance_km((w["lon"], w["lat"]), parse_point(d["coord"]))
            if km > CHECK_KM:
                notes.append("Wikidata's point is %d km off" % km)
        for fact in facts.get(w["id"], {}).get("facts", []):
            named = giveaways(fact, w["name"], w["countryName"], w["division"])
            if named:
                notes.append("a fact names %s" % ", ".join(named))
        w["article"] = d.get("article")
        w["sitelinks"] = d.get("sitelinks", 0)
        review[w["id"]] = {"qid": w["id"], "name": w["name"], "country": w["countryName"],
                           "article": w["article"] or "", "sitelinks": w["sitelinks"],
                           "wikidata_km": "" if km is None else round(km),
                           "notes": "; ".join(notes)}

    views = pageviews([w["article"] for w in table if w["article"]], refresh)
    view_pct = percentiles({w["id"]: views.get(w["article"], 0) for w in table})
    link_pct = percentiles({w["id"]: w["sitelinks"] for w in table})
    for w in table:
        w["views"] = views.get(w["article"], 0)
        raw = W_VIEWS * view_pct[w["id"]] + W_LINKS * link_pct[w["id"]]
        w["score"] = FLOOR + (1 - FLOOR) * raw
        review[w["id"]].update({"views": w["views"], "score": round(w["score"], 4)})

    table.sort(key=lambda w: -w["score"])
    wines = []
    for rank, w in enumerate(table, 1):
        wines.append({
            "id": w["id"],
            "name": w["name"],
            "country": w["country"],
            "region": w["region"],
            "lon": round(w["lon"], 4),
            "lat": round(w["lat"], 4),
            "division": w["division"],
            "grapes": w["grapes"],
            "rank": rank,
            "score": round(w["score"], 4),
            "facts": facts.get(w["id"], {}).get("facts", []),
        })
        review[w["id"]]["rank"] = rank

    with open(REVIEW, "w", encoding="utf-8", newline="") as f:
        fields = ["rank", "qid", "name", "country", "score", "views", "sitelinks",
                  "article", "wikidata_km", "notes"]
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sorted(review.values(), key=lambda r: r["rank"]))

    start, end = view_window()
    payload = {
        "built": datetime.date.today().isoformat(),
        "pageviews": [start, end],
        "wines": wines,
    }
    with open(dst, "w", encoding="utf-8") as f:
        f.write("/* Generated by build/build_wines.py - do not edit by hand. */\n")
        f.write("window.WINE_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    print("%d regions -> %s (review: %s)" % (len(wines), dst, os.path.relpath(REVIEW)),
          file=sys.stderr)
    noted = [r for r in review.values() if r["notes"]]
    if noted:
        print("%d to look at:" % len(noted), file=sys.stderr)
        for r in sorted(noted, key=lambda r: r["rank"]):
            print("  %s (%s): %s" % (r["name"], r["qid"], r["notes"]), file=sys.stderr)
    factless = sorted(w["name"] for w in wines if not w["facts"])
    if factless:
        print("no facts for %d (add them to %s): %s" % (
            len(factless), os.path.relpath(FACTS), ", ".join(factless)), file=sys.stderr)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit("usage: build_wines.py [--refresh] OUT.js")
    main(args[0], refresh="--refresh" in sys.argv)
