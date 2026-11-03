# -*- coding: utf-8 -*-
"""Build the globe's geometry from Natural Earth 10m data.

    python3 build/build_globe.py data/globe          # add --refresh to re-download

Everything is longitude and latitude: js/app.js projects it onto the globe as
it draws, so nothing here knows about the projection. Levels of detail, each
simplified for the zooms it is drawn at (js/app.js picks by pixels per
degree; see LEVEL_PX there):

  data/globe/base.js     the globe seen whole, with the biggest lakes.
                         Loaded by index.html, so the page opens on land.
  data/globe/l1.js       a continent filling the screen: big rivers, the
                         main state borders. Loaded just after boot ...
  data/globe/l2.js       ... a country filling it: lakes, rivers and state
                         borders. Likewise.
  data/globe/t/C_R.js    the full 10m detail in TILE-degree squares, loaded
                         only where the camera is looking.

A level holds every point the globe needs at its zoom, so the tolerances
step up with it: a level too fine for its zoom draws thousands of points
that land on the same pixel, and that is what makes the globe slow.

Each level holds the same layers: country fills, the outlines between them
(one set of lines per pair of countries a border separates, so a shared
border is drawn once and both sides light up with either country), lakes,
lake shores, rivers and state / province borders.

Neighbouring countries are assembled from the same simplified TopoJSON arcs,
so a shared border has exactly the same vertices on both sides.

Points are stored as integers, q steps per degree, each one a delta from the
last: [lon0, lat0, dlon1, dlat1, ...].
"""
import json
import math
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_map import fold, slug  # noqa: E402
from countries_table import COUNTRIES  # noqa: E402

CACHE = os.path.join(HERE, "cache", "ne")
SOURCES = {
    "countries-10m.json":
        "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-10m.json",
}
NE_GEOJSON = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
for _name in ("ne_10m_lakes", "ne_10m_rivers_lake_centerlines",
              "ne_10m_admin_1_states_provinces_lines"):
    SOURCES[_name + ".geojson"] = NE_GEOJSON + _name + ".geojson"

# Natural Earth features folded into the country that administers or claims
# them, so a click there finds the country the player expects. The last
# three only exist at 10m; without them Baikonur and Guantanamo would be
# grey holes in the land.
MERGE_INTO = {
    "Somaliland": "Somalia",
    "N. Cyprus": "Cyprus",
    "Siachen Glacier": "India",
    "Hong Kong": "China",
    "Macao": "China",
    "Baikonur": "Kazakhstan",
    "Cyprus U.N. Buffer Zone": "Cyprus",
    "USNB Guantanamo Bay": "Cuba",
}

TILE = 5                # tile size, in degrees

# Per level: Douglas-Peucker tolerance (degrees, measured east-west at the
# latitude of the line), the smallest polygon kept (square degrees, likewise)
# and q, the steps per degree points are stored in.
# Each is about half a pixel at the level's most zoomed-in.
BASE = {"tol": 0.06, "speck": 0.004, "q": 100}
L1 = {"tol": 0.025, "speck": 0.0008, "q": 1000}
L2 = {"tol": 0.01, "speck": 0.0001, "q": 1000}
DEEP = {"tol": 0.001, "speck": 0.000001, "q": 10000}

# What each level shows. Natural Earth ranks features by importance: lower
# scalerank / min_zoom is more important. None leaves the layer out.
BASE_LAYERS = {"lakes": 2, "rivers": None, "admin": None}
L1_LAYERS = {"lakes": 4, "rivers": 3, "admin": 3.0}
L2_LAYERS = {"lakes": 6, "rivers": 5, "admin": 5.0}
DEEP_LAYERS = {"lakes": 99, "rivers": 9, "admin": 8.7}
MAJOR_RIVER = 5         # drawn heavier
# Every class of Natural Earth admin-1 line that is a real state / province
# border. "Statistical" ones are borders that also bound a statistical region
# (48 of the 111 US state borders, Texas-New Mexico among them); indicators
# are short stretches such as DC-Virginia along the Potomac.
ADMIN_KINDS = {"Admin-1 boundary", "Admin-1 region boundary", "Admin-1 statistical boundary",
               "Admin-1 statistical meta bounds", "Admin-1 boundary indicator"}

TERRITORY = "~"         # owner prefix for land that is not one of the 197


# ------------------------------------------------------------------ sources
def fetch(refresh):
    os.makedirs(CACHE, exist_ok=True)
    for name, url in SOURCES.items():
        path = os.path.join(CACHE, name)
        if refresh or not os.path.exists(path):
            print("fetching %s" % url)
            with urllib.request.urlopen(url) as resp, open(path, "wb") as out:
                out.write(resp.read())


def load_geojson(name):
    with open(os.path.join(CACHE, name), encoding="utf-8") as fh:
        return json.load(fh)["features"]


def load_topology(path):
    with open(path, encoding="utf-8") as fh:
        topo = json.load(fh)
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return topo, arcs


def ring_coords(arc_indexes, arcs):
    pts = []
    for i in arc_indexes:
        seq = arcs[~i][::-1] if i < 0 else arcs[i]
        pts.extend(seq[1:] if pts else seq)
    return pts


def topo_polygons(geom, arcs):
    """Feature -> list of polygons, each a list of rings in lon/lat."""
    if geom["type"] == "Polygon":
        raw = [geom["arcs"]]
    elif geom["type"] == "MultiPolygon":
        raw = geom["arcs"]
    else:
        return []
    return [[ring_coords(r, arcs) for r in poly] for poly in raw]


def lines_of(geom):
    if not geom:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def geojson_polygons(geom):
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


# ----------------------------------------------------------------- geometry
def simplify(points, tol):
    """Douglas-Peucker on lon/lat, east-west distances scaled by cos(lat).

    The line is split at any jump across the date line first, so a stretch
    either side of it is simplified on its own and the jump survives.
    """
    if tol <= 0 or len(points) < 3:
        return list(points)
    runs = [[points[0]]]
    for prev, cur in zip(points, points[1:]):
        if abs(cur[0] - prev[0]) > 180:
            runs.append([cur])
        else:
            runs[-1].append(cur)
    out = []
    for run in runs:
        out.extend(run[i] for i in simplify_idx(run, tol))
    return out


def simplify_idx(points, tol):
    n = len(points)
    if n < 3:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = points[lo][0], points[lo][1]
        bx, by = points[hi][0], points[hi][1]
        k = math.cos(math.radians((ay + by) / 2))
        dx, dy = (bx - ax) * k, by - ay
        span = dx * dx + dy * dy
        worst, wi = -1.0, lo
        for i in range(lo + 1, hi):
            px, py = (points[i][0] - ax) * k, points[i][1] - ay
            if span == 0:
                d2 = px * px + py * py
            else:
                t = (px * dx + py * dy) / span
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2
            if d2 > worst:
                worst, wi = d2, i
        if worst > tol2:
            keep[wi] = True
            stack.append((lo, wi))
            stack.append((wi, hi))
    return [i for i in range(n) if keep[i]]


def area(ring):
    """Area in square degrees, east-west scaled at the ring's latitude."""
    k = math.cos(math.radians(sum(p[1] for p in ring) / len(ring)))
    total = 0.0
    prev = ring[-1]
    for cur in ring:
        total += prev[0] * cur[1] - cur[0] * prev[1]
        prev = cur
    return abs(total) / 2 * k


def flatten(ring):
    """A ring as a flat lon/lat polygon, for clipping into tiles and for the
    page's point-in-polygon test.

    Natural Earth cuts land at +-180, but stitched rings still step straight
    from 179.9 to -179.9. A ring that crosses and comes back is split there,
    each piece closed along the meridian. A ring that crosses once goes all
    the way round a pole (Antarctica): it is closed through that pole.
    """
    jumps = [i for i in range(len(ring) - 1) if abs(ring[i + 1][0] - ring[i][0]) > 180]
    if not jumps:
        return [ring]
    if len(jumps) % 2:
        i = jumps[0]
        body = ring[i + 1:] + ring[1:i + 1]
        pole = -90.0 if sum(p[1] for p in ring) < 0 else 90.0
        return [body + [(math.copysign(180.0, body[-1][0]), pole),
                        (math.copysign(180.0, body[0][0]), pole)]]
    pieces = [[ring[0]]]
    for prev, cur in zip(ring, ring[1:]):
        if abs(cur[0] - prev[0]) > 180:
            pieces.append([cur])
        else:
            pieces[-1].append(cur)
    if len(pieces) > 1 and abs(pieces[0][0][0] - pieces[-1][-1][0]) <= 180:
        pieces[0] = pieces[-1] + pieces[0]       # the ring closed mid-piece
        pieces.pop()
    return [piece for piece in pieces if len(piece) >= 3]


def flat_polygons(polygons, speck):
    """Polygons -> flat lon/lat polygons, cut at the date line, specks gone."""
    out = []
    for rings in polygons:
        outers = flatten(rings[0])
        holes = [h for ring in rings[1:] for h in flatten(ring)
                 if len(h) >= 3 and area(h) >= speck]
        for outer in outers:
            if len(outer) >= 3 and area(outer) >= speck:
                # Holes cannot straddle the date line; give each to its side.
                side = [h for h in holes if (h[0][0] < 0) == (outer[0][0] < 0)] \
                    if len(outers) > 1 else holes
                out.append([outer] + side)
    return out


def seam(a, b):
    """True for an edge that is a cut in the data, not a coast or border:
    along the date line, or into a pole."""
    on_line = abs(abs(a[0]) - 180) < 1e-4 and abs(abs(b[0]) - 180) < 1e-4
    at_pole = abs(abs(a[1]) - 90) < 1e-4 or abs(abs(b[1]) - 90) < 1e-4
    return on_line or at_pole


def clip_axis(ring, axis, lo, hi):
    """Sutherland-Hodgman against lo <= coord[axis] <= hi."""
    for bound, keep_above in ((lo, True), (hi, False)):
        if not ring:
            return ring
        out = []
        prev = ring[-1]
        prev_in = (prev[axis] >= bound) if keep_above else (prev[axis] <= bound)
        for cur in ring:
            cur_in = (cur[axis] >= bound) if keep_above else (cur[axis] <= bound)
            if cur_in != prev_in:
                t = (bound - prev[axis]) / (cur[axis] - prev[axis])
                other = 1 - axis
                cut = [0.0, 0.0]
                cut[axis] = bound
                cut[other] = prev[other] + t * (cur[other] - prev[other])
                out.append(tuple(cut))
            if cur_in:
                out.append(cur)
            prev, prev_in = cur, cur_in
        ring = out
    return ring


def clip_segment(a, b, box):
    """Liang-Barsky: the part of segment a-b inside box, or None."""
    x0, y0, x1, y1 = box
    t0, t1 = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dy, a[1] - y0), (dy, y1 - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return ((a[0] + t0 * dx, a[1] + t0 * dy), (a[0] + t1 * dx, a[1] + t1 * dy))


def split_line(line):
    """A line broken wherever it jumps the date line."""
    out = [[]]
    for p in line:
        if out[-1] and abs(p[0] - out[-1][-1][0]) > 180:
            out.append([])
        out[-1].append((p[0], p[1]))
    return [o for o in out if len(o) >= 2]


def chain(segments):
    """Join consecutive segments that touch into lines."""
    lines = []
    for a, b in segments:
        if lines and lines[-1][-1] == a:
            lines[-1].append(b)
        elif lines and lines[-1][-1] == b:
            lines[-1].append(a)
        else:
            lines.append([a, b])
    return lines


# ------------------------------------------------------------------ writing
def encode(points, q, closed):
    """Points -> [lon0, lat0, dlon, dlat, ...] in integer steps of 1/q deg."""
    out, last = [], None
    for lon, lat in points:
        cur = (round(lon * q), round(lat * q))
        if cur == last:
            continue
        if last is None:
            out += [cur[0], cur[1]]
        else:
            out += [cur[0] - last[0], cur[1] - last[1]]
        last = cur
    if closed and len(out) >= 4 and sum(out[2::2]) == 0 and sum(out[3::2]) == 0:
        del out[-2:]                        # the closing point repeats the first
    need = 6 if closed else 4
    return out if len(out) >= need else None


def encode_all(shapes, q, closed):
    return [e for e in (encode(s, q, closed) for s in shapes) if e]


# ------------------------------------------------------------------- land
def owners(features):
    """[(owner, [ne keys])] for every piece of land: the 197 by slug, the
    rest (Antarctica, Greenland, Gibraltar...) as TERRITORY + slug."""
    merged = {}
    for extra, parent in MERGE_INTO.items():
        merged.setdefault(fold(parent), []).append(fold(extra))
    used, table = set(), []
    for ne_name, display, _region, _aliases in COUNTRIES:
        keys = [fold(ne_name)] if ne_name else [fold(display)]
        if ne_name and keys[0] not in features:
            raise SystemExit("no Natural Earth feature named %r" % ne_name)
        keys += merged.get(keys[0], [])
        keys = [key for key in keys if key in features]
        used.update(keys)
        table.append((slug(display), keys))
    for key in features:
        if key not in used:
            table.append((TERRITORY + slug(key), [key]))
    return table


def land(level):
    """{owner: flat polygons} at one level of detail."""
    topo, arcs = load_topology(os.path.join(CACHE, "countries-10m.json"))
    arcs = [simplify(a, level["tol"]) for a in arcs]
    features = {fold(g["properties"]["name"]): g
                for g in topo["objects"]["countries"]["geometries"]}
    out = {}
    for owner, keys in owners(features):
        polygons = []
        for key in keys:
            polygons += topo_polygons(features[key], arcs)
        flat = flat_polygons(polygons, level["speck"])
        if flat:
            out[owner] = flat
    return out


def outlines(pieces):
    """Outline segments, each once, tagged with the owners either side.

    Returns {"a|b": [segments]}: b is "" along a coast, a territory counts
    as "~" (so a border with one is still a border, not a coast), and a seam
    inside one owner (Somaliland against Somalia) is dropped.
    """
    seen, order = {}, []
    for owner, polygons in pieces.items():
        for rings in polygons:
            for ring in rings:
                for i in range(len(ring)):
                    a, b = ring[i], ring[(i + 1) % len(ring)]
                    if a == b or seam(a, b):
                        continue
                    key = (a, b) if a <= b else (b, a)
                    if key not in seen:
                        seen[key] = []
                        order.append(key)
                    seen[key].append(owner)
    grouped = {}
    for key in order:
        found = seen[key]
        if len(found) >= 2 and found[0] == found[1]:
            continue
        names = [TERRITORY if o.startswith(TERRITORY) else o for o in found[:2]]
        if len(names) == 1:
            names.append("")
        tag = "|".join(sorted(names, reverse=True))
        grouped.setdefault(tag, []).append(key)
    return grouped


def overlays(level, layers):
    """Lakes (flat polygons), rivers ([(major, line)]) and admin lines."""
    tol, speck = level["tol"], level["speck"]
    lakes, rivers, admin = [], [], []
    if layers["lakes"] is not None:
        for f in load_geojson("ne_10m_lakes.geojson"):
            rank = f["properties"].get("scalerank")
            if rank is None or rank > layers["lakes"]:
                continue
            for rings in geojson_polygons(f["geometry"]):
                rings = [simplify([tuple(p[:2]) for p in ring], tol) for ring in rings]
                lakes += flat_polygons([rings], speck)
    if layers["rivers"] is not None:
        for f in load_geojson("ne_10m_rivers_lake_centerlines.geojson"):
            p = f["properties"]
            rank = p.get("scalerank")
            if rank is None or rank > layers["rivers"] \
                    or not p.get("featurecla", "").startswith("River"):
                continue
            for line in lines_of(f["geometry"]):
                for part in split_line(simplify([tuple(q[:2]) for q in line], tol)):
                    rivers.append((rank <= MAJOR_RIVER, part))
    if layers["admin"] is not None:
        for f in load_geojson("ne_10m_admin_1_states_provinces_lines.geojson"):
            p = f["properties"]
            if p.get("FEATURECLA") not in ADMIN_KINDS \
                    or (p.get("MIN_ZOOM") or 99) > layers["admin"]:
                continue
            for line in lines_of(f["geometry"]):
                admin += split_line(simplify([tuple(q[:2]) for q in line], tol))
    return lakes, rivers, admin


def payload(fills, edges, lakes, shores, rivers, admin, q):
    """One level, or one tile, as written to disk."""
    out = {"q": q}
    out["fill"] = [[owner if not owner.startswith(TERRITORY) else "",
                    encode_all([ring for rings in polys for ring in rings], q, True)]
                   for owner, polys in sorted(fills.items())]
    out["fill"] = [f for f in out["fill"] if f[1]]
    out["edge"] = [[tag, encode_all(chain(segs), q, False)]
                   for tag, segs in sorted(edges.items())]
    out["lake"] = encode_all([ring for rings in lakes for ring in rings], q, True)
    out["shore"] = encode_all(shores, q, False)
    out["river"] = [[1, encode_all([l for major, l in rivers if major], q, False)],
                    [0, encode_all([l for major, l in rivers if not major], q, False)]]
    out["admin"] = encode_all(admin, q, False)
    return {k: v for k, v in out.items() if v}


def points(data):
    """Points in a level: what it costs to draw every frame."""
    def count(x):
        if isinstance(x, list) and x and all(isinstance(v, int) for v in x[:2]) and len(x) > 2:
            return len(x) // 2
        if isinstance(x, list):
            return sum(count(v) for v in x)
        return 0
    return sum(count(v) for k, v in data.items() if k not in ("q", "tile", "tiles"))


def write_js(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("// Generated by build/build_globe.py - do not edit by hand.\n")
        fh.write(text)
    return len(text)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def build_level(level, layers):
    fills = land(level)
    edges = outlines(fills)
    lakes, rivers, admin = overlays(level, layers)
    shores = [ring + ring[:1] for rings in lakes for ring in rings]
    return payload(fills, edges, lakes, shores, rivers, admin, level["q"])


# ------------------------------------------------------------------- tiles
class Tiles:
    """TILE-degree squares: column c from -180 eastwards, row r from 90 south."""

    def __init__(self):
        self.cols = 360 // TILE
        self.rows = 180 // TILE
        self.data = {}

    def bucket(self, c, r, layer, key):
        return self.data.setdefault((c, r), {}).setdefault(layer, {}).setdefault(key, [])

    def box(self, c, r):
        return (-180 + c * TILE, 90 - (r + 1) * TILE, -180 + (c + 1) * TILE, 90 - r * TILE)

    def span(self, xs, ys):
        c0 = max(0, int((min(xs) + 180) // TILE))
        c1 = min(self.cols - 1, int((max(xs) + 180) // TILE))
        r0 = max(0, int((90 - max(ys)) // TILE))
        r1 = min(self.rows - 1, int((90 - min(ys)) // TILE))
        return c0, c1, r0, r1

    def add_polygons(self, layer, key, polygons):
        """Clip flat polygons to the grid: by row first, then by column."""
        for rings in polygons:
            c0, c1, r0, r1 = self.span([p[0] for p in rings[0]], [p[1] for p in rings[0]])
            for r in range(r0, r1 + 1):
                _x0, y0, _x1, y1 = self.box(0, r)
                band = [clip_axis(ring, 1, y0, y1) for ring in rings]
                if len(band[0]) < 3:
                    continue
                for c in range(c0, c1 + 1):
                    x0, _y0, x1, _y1 = self.box(c, r)
                    cut = [clip_axis(ring, 0, x0, x1) for ring in band]
                    if len(cut[0]) < 3:
                        continue
                    self.bucket(c, r, layer, key).append([ring for ring in cut if len(ring) >= 3])

    def add_segments(self, layer, key, segments):
        for a, b in segments:
            c0, c1, r0, r1 = self.span((a[0], b[0]), (a[1], b[1]))
            for c in range(c0, c1 + 1):
                for r in range(r0, r1 + 1):
                    part = clip_segment(a, b, self.box(c, r))
                    if part and part[0] != part[1]:
                        self.bucket(c, r, layer, key).append(part)

    def add_lines(self, layer, key, lines):
        for line in lines:
            self.add_segments(layer, key, list(zip(line, line[1:])))


def build_tiles(dst):
    q = DEEP["q"]
    tiles = Tiles()
    fills = land(DEEP)
    for owner, polygons in fills.items():
        tiles.add_polygons("fill", owner, polygons)
    for tag, segments in outlines(fills).items():
        tiles.add_segments("edge", tag, segments)
    lakes, rivers, admin = overlays(DEEP, DEEP_LAYERS)
    for rings in lakes:
        tiles.add_polygons("lake", "", [rings])
        tiles.add_lines("shore", "", [ring + ring[:1] for ring in rings])
    for major, line in rivers:
        tiles.add_lines("river", major, [line])
    tiles.add_lines("admin", "", admin)

    folder = os.path.join(dst, "t")
    os.makedirs(folder, exist_ok=True)
    for name in os.listdir(folder):
        if name.endswith(".js"):
            os.remove(os.path.join(folder, name))

    names, total, biggest = [], 0, (0, "")
    for (c, r), layers in sorted(tiles.data.items()):
        if not layers.get("fill"):
            continue                    # open ocean: nothing worth a file
        get = lambda name: layers.get(name, {})  # noqa: E731
        out = payload(
            {owner: polys for owner, polys in get("fill").items()},
            {tag: segs for tag, segs in get("edge").items()},
            [rings for rings_list in get("lake").values() for rings in rings_list],
            chain(get("shore").get("", [])),
            [(major, line) for major, segs in get("river").items() for line in chain(segs)],
            chain(get("admin").get("", [])),
            q)
        name = "%d_%d" % (c, r)
        size = write_js(os.path.join(folder, name + ".js"),
                        "MAP_GLOBE.tile(%s,%s);\n" % (dumps(name), dumps(out)))
        names.append(name)
        total += size
        biggest = max(biggest, (size, name))
    print("tiles: %d, %.1f MB, largest %s at %.0f KB"
          % (len(names), total / 1e6, biggest[1], biggest[0] / 1024))
    return names


def main(argv):
    refresh = "--refresh" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    dst = args[0]
    fetch(refresh)
    os.makedirs(dst, exist_ok=True)

    names = build_tiles(dst)

    base = build_level(BASE, BASE_LAYERS)
    base["tile"] = TILE
    base["tiles"] = names
    size = write_js(os.path.join(dst, "base.js"), "window.GLOBE_BASE = %s;\n" % dumps(base))
    print("base: %.0f KB, %d points" % (size / 1024, points(base)))

    for index, (level, layers) in enumerate(((L1, L1_LAYERS), (L2, L2_LAYERS)), 1):
        data = build_level(level, layers)
        size = write_js(os.path.join(dst, "l%d.js" % index),
                        "MAP_GLOBE.level(%d,%s);\n" % (index, dumps(data)))
        print("l%d: %.0f KB, %d points" % (index, size / 1024, points(data)))

    stale = os.path.join(dst, "mid.js")
    if os.path.exists(stale):
        os.remove(stale)


if __name__ == "__main__":
    main(sys.argv[1:])
