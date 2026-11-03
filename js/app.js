/* Wine Guesser - find the world's wine regions on a globe.
 *
 * Everything is client side. The land, borders, lakes and rivers are plain
 * longitude and latitude (data/globe/, built by build/build_globe.py); this
 * file projects them onto an orthographic globe and draws them on a canvas
 * every frame, so the globe can turn. Pins, labels and the line from a guess
 * to its answer are SVG on top, placed through the same projection.
 *
 * The camera and input handling come from Country Guesser, reworked for a
 * globe: the camera is the point the globe faces and a zoom, with north
 * always up. The game is Find the Wine: ten wine regions from data/wines.js,
 * one at a time, each pinned on the globe and scored on how far off it
 * landed from the region's heart (a point: see build/build_wines.py).
 */
(function () {
  'use strict';

  var DATA = window.MAP_DATA;
  var BASE = window.GLOBE_BASE;
  var STRINGS = window.STRINGS || {};     // i18n/en.js, or whatever replaces it
  var NS = 'http://www.w3.org/2000/svg';
  var K_MIN = 1;                 // the whole globe, as big as the screen allows
  var K_MAX = 300;               // ~2,000 px per degree on a laptop
  var GLOBE_FILL = 0.46;         // the globe's radius at K_MIN, of the shorter side
  var ZOOM_STEP = 2.2;           // per button press or key
  var PICK_PX = 13;              // the ring round a picked spot, on screen
  var WINE_PX = 2.5;             // each region's dot, on screen
  var PIN_PX = 4.5;              // the dot where the click landed, on screen
  var MARK_PX = 5;               // a revealed region, and the guess made at it
  var LABEL_PX = 13;             // ... and its name
  var PLACE_GAP = 12;            // between a found region and the card over it
  var ROUNDS = 10;               // regions in a run
  var PER_COUNTRY = 2;           // at most this many from one country in a run
  var MAX_POINTS = 1000;         // for a pin this close or closer ...
  var FULL_KM = 40;
  var FALLOFF_KM = 750;          // ... then e-fold every this many km further
  var REVEAL_DEG = 11;           // the answer is shown at least this wide
  var TAP_SLOP = 6;              // further than this and it was a drag, not a tap
  var COUNT_FROM = 3;            // the countdown a run opens with
  var COUNT_STEP = 800;          // ... one number at a time
  var HOME_FILL = 0.92;          // how much of the screen the region fills
  var HOME = { lon: 10, lat: 25 };   // where the globe faces before any region
  var DAILY_ZONE = 'America/Los_Angeles';   // the daily regions change at midnight here
  // Pixels per degree where each level of detail takes over (base, l1, l2;
  // see build/build_globe.py), and where the full-detail tiles do. The
  // whole globe on a laptop is about 7 px per degree.
  var LEVEL_PX = [0, 12, 30];
  var DEEP_PX = 60;
  var SKIP_PX = 0.6;             // a point this close to the last is not drawn
  var GLOBE_DIR = 'data/globe/';
  var RAD = Math.PI / 180;

  // Line widths, in screen pixels.
  var LINE = {
    graticule: 0.75, limb: 1, coast: 0.7, border: 1.1, picked: 2.2,
    river: 0.8, major: 1.3, shore: 0.5, admin: 0.7
  };

  // ---------------------------------------------------------------- the sphere
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function wrapLon(lon) { return ((lon + 540) % 360 + 360) % 360 - 180; }

  /** Longitude and latitude -> unit vector (x towards 0,0; z to the pole). */
  function vec(lon, lat) {
    var cl = Math.cos(lat * RAD);
    return [cl * Math.cos(lon * RAD), cl * Math.sin(lon * RAD), Math.sin(lat * RAD)];
  }

  function geoOf(v) {
    return { lon: Math.atan2(v[1], v[0]) / RAD, lat: Math.asin(clamp(v[2], -1, 1)) / RAD };
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Great-circle distance in kilometres - what a guess is scored on. */
  function distanceKm(a, b) {
    var dLat = (b.lat - a.lat) * RAD;
    var dLon = (b.lon - a.lon) * RAD;
    var h = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** The point a fraction u of the way along the great circle a -> b. */
  function slerp(a, b, u) {
    var theta = Math.acos(clamp(dot(a, b), -1, 1));
    var s = Math.sin(theta);
    if (s < 1e-6) return a;
    var wa = Math.sin((1 - u) * theta) / s, wb = Math.sin(u * theta) / s;
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
  }

  // ------------------------------------------------------------------ helpers
  function el(name) { return document.createElementNS(NS, name); }
  function $(id) { return document.getElementById(id); }

  function slug(text) { return text.toLowerCase().replace(/\s+/g, '-'); }

  /** One line of wording, by dotted key, with its {tokens} filled in.
   *
   * A missing key returns the key itself: a run with a half-translated file
   * should say which line is missing, not fall silently blank.
   */
  function t(key, vars) {
    var text = key.split('.').reduce(function (node, part) {
      return node && typeof node === 'object' ? node[part] : undefined;
    }, STRINGS);
    if (typeof text !== 'string') return key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (whole, name) {
      return vars[name] === undefined ? whole : vars[name];
    });
  }

  function show(node, visible) {
    node.classList.toggle('hidden', !visible);
  }

  // -------------------------------------------------------------------- state
  var stage = $('stage');
  var canvas = $('globe');
  var ctx = canvas.getContext('2d');
  var svg = $('map');
  var WINES = (window.WINE_DATA && WINE_DATA.wines) || [];

  var countries = DATA.countries.map(function (c) {
    return { id: c.id, name: c.name, region: c.region, inPlay: true };
  });

  var byId = {};
  countries.forEach(function (c) { byId[c.id] = c; });

  var view = { lon: HOME.lon, lat: HOME.lat, k: 1 };   // the camera
  var vw = 1, vh = 1, dpr = 1;   // the stage, in CSS pixels
  var r0 = 1;                    // the globe's radius at K_MIN, in CSS pixels
  var basis = null;              // the camera as vectors: see setBasis()
  var showWines = false;        // every region as a dot, for checking the data
  var selected = null;           // the country the last click landed on
  var pin = null;                // ... and where exactly: { lon, lat }
  var waiting = false;           // the splash is up: the run has not begun
  var mode = 'daily';            // 'daily' or 'practice'
  var countryOnly = false;       // practice where only the country counts
  var day = null;                // the daily run's date, 'YYYY-MM-DD' in DAILY_ZONE
  var countTimer = null;         // ... and the wait between 3, 2 and 1
  var anim = null;
  var rounds = [];               // this run: { wine, guess, km, points, marks }
  var turn = -1;                 // the round being played
  var locked = false;            // ... its guess is in, and the answer showing
  var done = false;              // every round played: the results are in

  // --------------------------------------------------------------- projection
  /* Orthographic, centred on view.lon / view.lat with north up. The camera
   * is three unit vectors: e (east at the centre), n (north at the centre)
   * and c (the centre itself). A point's screen x and y are its components
   * along e and n; along c says whether it faces the viewer. */
  function setBasis() {
    var l = view.lon * RAD, p = view.lat * RAD;
    var sl = Math.sin(l), cl = Math.cos(l), sp = Math.sin(p), cp = Math.cos(p);
    basis = {
      ex: -sl, ey: cl,
      nx: -sp * cl, ny: -sp * sl, nz: cp,
      cx: cp * cl, cy: cp * sl, cz: sp,
      R: view.k * r0, ox: vw / 2, oy: vh / 2
    };
  }

  /** Longitude and latitude -> { x, y } on screen, and whether it faces us. */
  function toScreen(lon, lat) {
    var v = vec(lon, lat), b = basis;
    var x = v[0] * b.ex + v[1] * b.ey;
    var y = v[0] * b.nx + v[1] * b.ny + v[2] * b.nz;
    var z = v[0] * b.cx + v[1] * b.cy + v[2] * b.cz;
    return { x: b.ox + b.R * x, y: b.oy - b.R * y, front: z > 0 };
  }

  /** A point on screen -> { lon, lat }, or null off the edge of the globe. */
  function fromScreen(sx, sy) {
    var b = basis;
    var x = (sx - b.ox) / b.R, y = (b.oy - sy) / b.R, d = x * x + y * y;
    if (d > 1) return null;
    var z = Math.sqrt(1 - d);
    return geoOf([
      x * b.ex + y * b.nx + z * b.cx,
      x * b.ey + y * b.ny + z * b.cy,
      y * b.nz + z * b.cz
    ]);
  }

  /** Turn the globe (at the current zoom) so point g shows at screen point p.
   *
   * Solved exactly, so a dragged spot stays under the pointer. North stays
   * up, so a spot at latitude phi can never sit further than cos(phi) globe
   * radii sideways of the centre: asked for that, it returns false and moves
   * nothing, and the caller falls back on spin().
   */
  function aim(g, p) {
    var R = view.k * r0;
    var x = (p.x - vw / 2) / R, y = (vh / 2 - p.y) / R, d = Math.hypot(x, y);
    if (d > 0.999) { x *= 0.999 / d; y *= 0.999 / d; }
    var phi = g.lat * RAD, cphi = Math.cos(phi);
    // x = cos(phi) sin(dl), where dl is g's longitude less the centre's ...
    if (Math.abs(x) >= cphi) return false;
    var dl = Math.asin(x / cphi);
    // ... and y = A cos(p0) - B sin(p0) = C cos(p0 + delta) for the centre's
    // latitude p0: two answers, of which the one facing us and nearest the
    // current latitude wins.
    var A = Math.sin(phi), B = cphi * Math.cos(dl), C = Math.hypot(A, B);
    var delta = Math.atan2(B, A), a = Math.acos(clamp(y / C, -1, 1));
    var now = view.lat * RAD, best = null;
    [a - delta, -a - delta].forEach(function (p0) {
      p0 = Math.atan2(Math.sin(p0), Math.cos(p0));
      if (Math.abs(p0) > Math.PI / 2) return;
      if (Math.sin(p0) * A + Math.cos(p0) * B <= 0) return;
      if (best === null || Math.abs(p0 - now) < Math.abs(best - now)) best = p0;
    });
    if (best === null) return false;
    view.lat = best / RAD;
    view.lon = wrapLon(g.lon - dl / RAD);
    return true;
  }

  // ------------------------------------------------------------------- shapes
  /* Every ring and line is kept twice: as lon/lat (for the point-in-polygon
   * test a click needs) and as unit vectors (for drawing), with the cap that
   * holds it - a centre and an angular radius - so whatever is round the
   * back of the globe or off screen is skipped without a look at its points.
   */
  function shape(ll) {
    var n = ll.length / 2;
    var xyz = new Float32Array(n * 3);
    var sx = 0, sy = 0, sz = 0;
    var box = [Infinity, Infinity, -Infinity, -Infinity];
    for (var i = 0; i < n; i++) {
      var lon = ll[2 * i], lat = ll[2 * i + 1];
      var cl = Math.cos(lat * RAD);
      var x = cl * Math.cos(lon * RAD), y = cl * Math.sin(lon * RAD), z = Math.sin(lat * RAD);
      xyz[3 * i] = x; xyz[3 * i + 1] = y; xyz[3 * i + 2] = z;
      sx += x; sy += y; sz += z;
      if (lon < box[0]) box[0] = lon;
      if (lat < box[1]) box[1] = lat;
      if (lon > box[2]) box[2] = lon;
      if (lat > box[3]) box[3] = lat;
    }
    var len = Math.hypot(sx, sy, sz);
    if (len < 1e-9) { sx = xyz[0]; sy = xyz[1]; sz = xyz[2]; len = 1; }
    sx /= len; sy /= len; sz /= len;
    var least = 1;
    for (var j = 0; j < n; j++) {
      least = Math.min(least, sx * xyz[3 * j] + sy * xyz[3 * j + 1] + sz * xyz[3 * j + 2]);
    }
    return { ll: ll, xyz: xyz, n: n, cx: sx, cy: sy, cz: sz, r: Math.acos(least), box: box };
  }

  /** [lon0, lat0, dlon, dlat, ...] in steps of 1/q degree -> a shape. */
  function decode(steps, q) {
    var ll = new Float32Array(steps.length);
    var lon = 0, lat = 0;
    for (var i = 0; i < steps.length; i += 2) {
      lon += steps[i];
      lat += steps[i + 1];
      ll[i] = lon / q;
      ll[i + 1] = lat / q;
    }
    return shape(ll);
  }

  /** One level of detail (or one tile) as build_globe.py writes it. */
  function decodeLevel(data) {
    var q = data.q;
    function all(list) { return (list || []).map(function (s) { return decode(s, q); }); }
    return {
      fills: (data.fill || []).map(function (f) {
        return { owner: byId[f[0]] || null, rings: all(f[1]) };
      }),
      edges: (data.edge || []).map(function (e) {
        var sides = e[0].split('|');
        var owners = sides.map(function (id) { return byId[id]; }).filter(Boolean);
        // Land on both sides ("~" is land that is no country): a border,
        // not a coast.
        return { owners: owners, border: !!(sides[0] && sides[1]), lines: all(e[1]) };
      }),
      lakes: all(data.lake),
      shores: all(data.shore),
      rivers: (data.river || []).map(function (r) { return { major: !!r[0], lines: all(r[1]) }; }),
      admin: all(data.admin)
    };
  }

  /** Meridians every 30 degrees, parallels every 30 up to 60. */
  var graticule = (function () {
    var lines = [], lon, lat, ll;
    for (lon = -180; lon < 180; lon += 30) {
      ll = [];
      for (lat = -90; lat <= 90; lat += 2) ll.push(lon, lat);
      lines.push(shape(new Float32Array(ll)));
    }
    for (lat = -60; lat <= 60; lat += 30) {
      ll = [];
      for (lon = -180; lon <= 180; lon += 2) ll.push(lon, lat);
      lines.push(shape(new Float32Array(ll)));
    }
    return lines;
  }());

  // ------------------------------------------------------------------- detail
  /* Levels of detail, chosen by how many pixels a degree covers, each
   * simplified for its zooms - drawing a level too fine for the zoom is what
   * makes the globe slow:
   *
   *   0     data/globe/base.js, the globe seen whole. Loaded by the page.
   *   1, 2  data/globe/l1.js and l2.js: a continent, then a country,
   *         filling the screen, with lakes, rivers and state borders.
   *         Loaded once, just after boot.
   *   deep  data/globe/t/C_R.js: the full 10m detail in squares of `tile`
   *         degrees, loaded only where the camera is looking.
   *
   * Files arrive as <script>s, not fetches, so the page still works opened
   * straight from disk. A level not here yet is stood in for by the finest
   * one that is, and tiles by level 2 until every tile in view has arrived.
   */
  var detail = {
    levels: [decodeLevel(BASE), null, null],
    size: BASE.tile,             // tile size, in degrees
    exists: {},                  // tile name -> true, for tiles with land
    tiles: {},                   // tile name -> its decoded level, once loaded
    asked: {},                   // tile name -> true, once requested
    drawn: [],                   // the levels on screen now: what a click hits ...
    deep: false                  // ... and whether they are tiles
  };
  BASE.tiles.forEach(function (name) { detail.exists[name] = true; });

  function loadScript(src) {
    var script = document.createElement('script');
    script.src = src;
    script.async = true;
    document.head.appendChild(script);
  }

  window.MAP_GLOBE = {
    level: function (index, data) {
      detail.levels[index] = decodeLevel(data);
      draw();
    },
    tile: function (name, data) {
      detail.tiles[name] = decodeLevel(data);
      draw();
    }
  };

  function tileName(lon, lat) {
    var size = detail.size;
    var c = clamp(Math.floor((wrapLon(lon) + 180) / size), 0, 360 / size - 1);
    var r = clamp(Math.floor((90 - lat) / size), 0, 180 / size - 1);
    return c + '_' + r;
  }

  /** The tiles with land that the camera can see, within `reach` radians of
   * the centre of the view. */
  function tilesInView(reach) {
    var size = detail.size;
    var centre = vec(view.lon, view.lat);
    var half = size * Math.SQRT1_2 * RAD;          // centre to corner of a tile
    var span = reach / RAD + size;
    var top = Math.max(0, Math.floor((90 - view.lat - span) / size));
    var bottom = Math.min(180 / size - 1, Math.floor((90 - view.lat + span) / size));
    var names = [];
    for (var r = top; r <= bottom; r++) {
      for (var c = 0; c < 360 / size; c++) {
        var name = c + '_' + r;
        if (!detail.exists[name]) continue;
        var mid = vec(-180 + (c + 0.5) * size, 90 - (r + 0.5) * size);
        if (Math.acos(clamp(dot(centre, mid), -1, 1)) <= reach + half) names.push(name);
      }
    }
    return names;
  }

  /** The finest level that is here and not too fine for this zoom. */
  function levelAt(perDegree) {
    var best = detail.levels[0];
    for (var i = 1; i < LEVEL_PX.length; i++) {
      if (detail.levels[i] && perDegree >= LEVEL_PX[i]) best = detail.levels[i];
    }
    return best;
  }

  /** The levels to draw now: tiles when zoomed far enough in and all of
   * them here, else one whole-globe level. */
  function levelsFor(reach) {
    var perDegree = basis.R * RAD;
    if (perDegree >= DEEP_PX) {
      var names = tilesInView(reach);
      var ready = true;
      names.forEach(function (name) {
        if (detail.tiles[name]) return;
        ready = false;
        if (!detail.asked[name]) {
          detail.asked[name] = true;
          loadScript(GLOBE_DIR + 't/' + name + '.js');
        }
      });
      if (ready) {
        detail.deep = true;
        return names.map(function (name) { return detail.tiles[name]; });
      }
    }
    detail.deep = false;
    return [levelAt(perDegree)];
  }

  // ------------------------------------------------------------------- colour
  /* The canvas cannot use CSS, so the palette is read from the stylesheet's
   * custom properties, and read again when the theme changes. */
  var COLORS = {};
  var PALETTE = ['ocean', 'ocean-edge', 'graticule', 'land', 'land-edge', 'inert',
    'inert-edge', 'pick', 'river', 'admin', 'border'];

  function readColors() {
    var css = getComputedStyle(document.documentElement);
    PALETTE.forEach(function (name) { COLORS[name] = css.getPropertyValue('--' + name).trim(); });
    COLORS.picked = mix(COLORS.pick, COLORS.land, 0.34);
  }

  function rgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** `a` mixed into `b`, a fraction `u` of the way: color-mix in srgb. */
  function mix(a, b, u) {
    if (!/^#[0-9a-f]{3,6}$/i.test(a) || !/^#[0-9a-f]{3,6}$/i.test(b)) return a;
    var x = rgb(a), y = rgb(b);
    return 'rgb(' + [0, 1, 2].map(function (i) {
      return Math.round(x[i] * u + y[i] * (1 - u));
    }).join(',') + ')';
  }

  // ------------------------------------------------------------------ drawing
  var scratch = new Float64Array(4096);

  /** Is any of this shape within `reach` radians of the centre of the view? */
  function inReach(s, reach) {
    var b = basis;
    var d = s.cx * b.cx + s.cy * b.cy + s.cz * b.cz;
    return Math.acos(clamp(d, -1, 1)) <= reach + s.r;
  }

  /** A filled ring. Points round the back are pulled out to the rim, so land
   * running over the horizon fills up to it; a ring wholly round the back is
   * left out. A point within SKIP_PX of the last one kept is dropped: the
   * canvas's cost is in the points it is handed, and a coastline seen from
   * afar packs dozens into a pixel. */
  function tracePolygon(path, s, reach) {
    if (!inReach(s, reach)) return;
    var b = basis, xyz = s.xyz, n = s.n, R = b.R, front = false;
    var skip2 = SKIP_PX * SKIP_PX, m = 0, kx = 0, ky = 0;
    if (scratch.length < 2 * n) scratch = new Float64Array(2 * n);
    for (var i = 0; i < n; i++) {
      var px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      var x = px * b.ex + py * b.ey;
      var y = px * b.nx + py * b.ny + pz * b.nz;
      if (px * b.cx + py * b.cy + pz * b.cz > 0) {
        front = true;
      } else {
        var len = Math.hypot(x, y);
        if (len > 1e-12) { x /= len; y /= len; }
      }
      var sx = b.ox + R * x, sy = b.oy - R * y;
      if (m && (sx - kx) * (sx - kx) + (sy - ky) * (sy - ky) < skip2) continue;
      scratch[2 * m] = kx = sx;
      scratch[2 * m + 1] = ky = sy;
      m++;
    }
    if (!front || m < 3) return;
    path.moveTo(scratch[0], scratch[1]);
    for (var j = 1; j < m; j++) path.lineTo(scratch[2 * j], scratch[2 * j + 1]);
    path.closePath();
  }

  /** A line, broken where it goes round the back, each break ended on the
   * rim. Points within SKIP_PX of the last one drawn are dropped, as for
   * tracePolygon(), except a line's last. */
  function traceLine(path, s, reach) {
    if (!inReach(s, reach)) return;
    var b = basis, xyz = s.xyz, n = s.n, R = b.R;
    var skip2 = SKIP_PX * SKIP_PX, kx = 0, ky = 0;
    var lx = 0, ly = 0, lz = -1;
    for (var i = 0; i < n; i++) {
      var px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      var x = px * b.ex + py * b.ey;
      var y = px * b.nx + py * b.ny + pz * b.nz;
      var z = px * b.cx + py * b.cy + pz * b.cz;
      if (z > 0) {
        var sx = b.ox + R * x, sy = b.oy - R * y;
        if (i === 0) {
          path.moveTo(sx, sy);
        } else if (lz <= 0) {
          var rim = onRim(lx, ly, lz, x, y, z);
          path.moveTo(b.ox + R * rim[0], b.oy - R * rim[1]);
          path.lineTo(sx, sy);
        } else if (i === n - 1 || (sx - kx) * (sx - kx) + (sy - ky) * (sy - ky) >= skip2) {
          path.lineTo(sx, sy);
        } else {
          lx = x; ly = y; lz = z;
          continue;
        }
        kx = sx; ky = sy;
      } else if (i > 0 && lz > 0) {
        var out = onRim(lx, ly, lz, x, y, z);
        path.lineTo(b.ox + R * out[0], b.oy - R * out[1]);
      }
      lx = x; ly = y; lz = z;
    }
  }

  /** Where the step from (x0, y0, z0) to (x1, y1, z1) crosses the rim. */
  function onRim(x0, y0, z0, x1, y1, z1) {
    var u = z0 / (z0 - z1);
    var x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u;
    var len = Math.hypot(x, y) || 1;
    return [x / len, y / len];
  }

  function stroke(path, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(path);
  }

  /** How far from the centre of the view, in radians, the screen reaches. */
  function reachOfScreen() {
    var corner = Math.hypot(vw, vh) / 2 / basis.R;
    return corner >= 1 ? Math.PI / 2 : Math.asin(corner) + 0.01;
  }

  function paintGlobe() {
    var b = basis;
    var reach = reachOfScreen();
    var levels = levelsFor(reach);
    detail.drawn = levels;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    var disc = new Path2D();
    disc.arc(b.ox, b.oy, b.R, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.ocean;
    ctx.fill(disc);

    var grid = new Path2D();
    graticule.forEach(function (s) { traceLine(grid, s, reach); });
    stroke(grid, COLORS.graticule, LINE.graticule);

    // Land in three colours: in play, out of play (and land that is no
    // country at all), and the country picked. One path each, so the tiles
    // and the pieces of a country fill as one with no seams between them.
    var land = { land: new Path2D(), inert: new Path2D(), picked: new Path2D() };
    var edges = {
      coast: new Path2D(), border: new Path2D(), inert: new Path2D(), picked: new Path2D()
    };
    var lakes = new Path2D(), shores = new Path2D(), admin = new Path2D();
    var rivers = new Path2D(), major = new Path2D();
    levels.forEach(function (level) {
      level.fills.forEach(function (f) {
        var key = !f.owner || !f.owner.inPlay ? 'inert' : f.owner === selected ? 'picked' : 'land';
        f.rings.forEach(function (s) { tracePolygon(land[key], s, reach); });
      });
      level.lakes.forEach(function (s) { tracePolygon(lakes, s, reach); });
      level.shores.forEach(function (s) { traceLine(shores, s, reach); });
      level.rivers.forEach(function (r) {
        r.lines.forEach(function (s) { traceLine(r.major ? major : rivers, s, reach); });
      });
      level.admin.forEach(function (s) { traceLine(admin, s, reach); });
      level.edges.forEach(function (e) {
        var key = e.owners.indexOf(selected) >= 0 && selected ? 'picked'
          : !e.owners.some(function (c) { return c.inPlay; }) ? 'inert'
          : e.border ? 'border' : 'coast';
        e.lines.forEach(function (s) { traceLine(edges[key], s, reach); });
      });
    });

    ctx.fillStyle = COLORS.inert;
    ctx.fill(land.inert);
    ctx.fillStyle = COLORS.land;
    ctx.fill(land.land);
    ctx.fillStyle = COLORS.picked;
    ctx.fill(land.picked);
    ctx.fillStyle = COLORS.ocean;
    ctx.fill(lakes);
    stroke(rivers, COLORS.river, LINE.river);
    stroke(major, COLORS.river, LINE.major);
    stroke(shores, COLORS['ocean-edge'], LINE.shore);
    stroke(admin, COLORS.admin, LINE.admin);
    stroke(edges.inert, COLORS['inert-edge'], LINE.coast);
    stroke(edges.coast, COLORS['land-edge'], LINE.coast);
    stroke(edges.border, COLORS.border, LINE.border);
    stroke(edges.picked, COLORS.pick, LINE.picked);
    stroke(disc, COLORS['ocean-edge'], LINE.limb);

    if (showWines) {
      ctx.fillStyle = COLORS.pick;
      WINES.forEach(function (wine) {
        var p = toScreen(wine.lon, wine.lat);
        if (!p.front) return;
        ctx.beginPath();
        ctx.arc(p.x, p.y, WINE_PX, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
  }

  /** Is this point inside any ring of the fill? Rings are flat lon/lat, cut
   * at the date line by the build, and holes count against. */
  function inFill(f, lon, lat) {
    var inside = false;
    f.rings.forEach(function (s) {
      var box = s.box;
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) return;
      var ll = s.ll, n = s.n;
      for (var i = 0, j = n - 1; i < n; j = i++) {
        var xi = ll[2 * i], yi = ll[2 * i + 1], xj = ll[2 * j], yj = ll[2 * j + 1];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    });
    return inside;
  }

  /** The country at a longitude and latitude, in the detail on screen. */
  function countryAt(g) {
    var tile = detail.deep && detail.tiles[tileName(g.lon, g.lat)];
    var levels = tile ? [tile] : detail.deep ? [levelAt(Infinity)] : detail.drawn;
    for (var i = 0; i < levels.length; i++) {
      var fills = levels[i].fills;
      for (var j = 0; j < fills.length; j++) {
        if (inFill(fills[j], g.lon, g.lat)) return fills[j].owner;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ viewport
  function clampK(k) { return Math.max(K_MIN, Math.min(K_MAX, k)); }

  function applyView() {
    view.k = clampK(view.k);
    view.lat = clamp(view.lat, -90, 90);
    view.lon = wrapLon(view.lon);
    setBasis();
    draw();
  }

  /** Size the canvas and the overlay to the stage. */
  function resize() {
    var box = stage.getBoundingClientRect();
    vw = Math.max(1, box.width);
    vh = Math.max(1, box.height);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    svg.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);
    r0 = GLOBE_FILL * Math.min(vw, vh);
    applyView();
  }

  /** A point on screen -> stage pixels. */
  function toMap(clientX, clientY) {
    var box = svg.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  }

  function centre() { return { x: vw / 2, y: vh / 2 }; }

  function zoomAbout(point, factor) {
    var g = fromScreen(point.x, point.y);
    view.k = clampK(view.k * factor);
    if (g) aim(g, point);
    applyView();
  }

  /** Turn by a drag with no spot to hold on to - it started off the globe,
   * or the spot cannot follow the pointer (see aim()): a globe's radius of
   * drag turns it a radian. */
  function spin(dx, dy) {
    var R = view.k * r0;
    view.lon -= dx / R / RAD / Math.max(0.2, Math.cos(view.lat * RAD));
    view.lat = clamp(view.lat + dy / R / RAD, -90, 90);
  }

  /** The camera that frames these points: faced at their middle, zoomed in
   * until they fill `fill` of the screen, but never narrower than `minDeg`
   * degrees. */
  function viewFor(points, fill, minDeg) {
    var sum = [0, 0, 0];
    points.forEach(function (p) {
      var v = vec(p.lon, p.lat);
      sum[0] += v[0]; sum[1] += v[1]; sum[2] += v[2];
    });
    var len = Math.hypot(sum[0], sum[1], sum[2]);
    var mid = len > 1e-9 ? geoOf([sum[0] / len, sum[1] / len, sum[2] / len]) : points[0];
    var c = vec(mid.lon, mid.lat);
    var l = mid.lon * RAD, p0 = mid.lat * RAD;
    var e = [-Math.sin(l), Math.cos(l), 0];
    var n = [-Math.sin(p0) * Math.cos(l), -Math.sin(p0) * Math.sin(l), Math.cos(p0)];
    var half = Math.sin((minDeg || 0) * RAD / 2), mx = half, my = half, back = false;
    points.forEach(function (p) {
      var v = vec(p.lon, p.lat);
      if (dot(v, c) <= 0) back = true;
      mx = Math.max(mx, Math.abs(dot(v, e)));
      my = Math.max(my, Math.abs(dot(v, n)));
    });
    var k = back ? K_MIN : (fill || 0.8) * Math.min(vw / 2 / (r0 * mx || 1), vh / 2 / (r0 * my || 1));
    return { lon: mid.lon, lat: mid.lat, k: clampK(k) };
  }

  /** The edges of a region's lon/lat window, as points to frame. */
  function regionView(region) {
    var w = DATA.windows[region], points = [];
    for (var i = 0; i <= 24; i++) {
      var u = i / 24;
      var lon = w[0] + (w[2] - w[0]) * u, lat = w[1] + (w[3] - w[1]) * u;
      points.push({ lon: lon, lat: w[1] }, { lon: lon, lat: w[3] },
        { lon: w[0], lat: lat }, { lon: w[2], lat: lat });
    }
    return viewFor(points, HOME_FILL);
  }

  /** Where the camera stands to look at the whole globe, turned no further
   * than it is. A run opens here, and the fit button comes back to it. */
  function homeView() {
    return { lon: view.lon, lat: view.lat, k: K_MIN };
  }

  /** Fly along the great circle between the two centres. A long trip pulls
   * back on the way, so the globe can be seen turning under the camera. */
  function flyTo(target, ms) {
    var a = vec(view.lon, view.lat), b = vec(target.lon, target.lat);
    var theta = Math.acos(clamp(dot(a, b), -1, 1));
    var k0 = Math.log(view.k), k1 = Math.log(clampK(target.k));
    var travel = Math.log(clampK(Math.min(view.k, target.k, 1.2 / Math.max(theta, 1e-6))));
    var dip = Math.max(0, (k0 + k1) / 2 - travel);
    var t0 = performance.now();
    var span = ms === undefined ? 520 + 260 * Math.min(1, theta) : ms;
    if (anim) cancelAnimationFrame(anim);
    function step(now) {
      var u = span > 0 ? Math.min(1, (now - t0) / span) : 1;
      var e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      var g = geoOf(slerp(a, b, e));
      view.lon = g.lon;
      view.lat = g.lat;
      view.k = Math.exp(k0 + (k1 - k0) * e - 4 * e * (1 - e) * dip);
      applyView();
      if (u < 1) anim = requestAnimationFrame(step);
    }
    anim = requestAnimationFrame(step);
  }

  /** There with no journey: for boot, and for a region chosen behind the
   * splash, where there is nothing to watch the camera travel over. */
  function jumpTo(target) {
    if (anim) cancelAnimationFrame(anim);
    view.lon = target.lon;
    view.lat = target.lat;
    view.k = target.k;
    applyView();
  }

  // ----------------------------------------------------------------- markers
  var pending = false;

  function draw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      render();
    });
  }

  function render() {
    setBasis();
    paintGlobe();
    $('zoom-readout').textContent =
      t('map.zoomLevel', { zoom: view.k < 10 ? view.k.toFixed(1) : Math.round(view.k) });

    // Markers are SVG over the canvas, in stage pixels: placed through the
    // projection every frame, and hidden while round the back.
    var card = locked && !done ? rounds[turn] : null;
    rounds.forEach(function (r) {
      if (!r.marks) return;
      var guess = toScreen(r.guess.lon, r.guess.lat);
      var at = toScreen(r.wine.lon, r.wine.lat);
      r.marks.line.setAttribute('d', arcPath(r.guess, r.wine));
      dotAt(r.marks.guess, guess, MARK_PX);
      dotAt(r.marks.target, at, MARK_PX);
      // The card over the region carries its name, so the label stands down.
      r.marks.label.style.display = at.front && r !== card ? '' : 'none';
      place(r.marks.label, {
        x: at.x, y: at.y - LABEL_PX * 0.75,
        'font-size': LABEL_PX, 'stroke-width': LABEL_PX * 0.28
      });
    });
    placeCard(card);

    var ring = $('pick-ring');
    var dot = $('pin-dot');
    show(ring, !!pin);
    show(dot, !!pin);
    if (!pin) return;
    var spot = toScreen(pin.lon, pin.lat);
    dotAt(ring, spot, PICK_PX);
    dotAt(dot, spot, PIN_PX);
  }

  /** The card over the region just found: in stage pixels, through the
   * camera, like the marks. It sits above the region, drops below it rather than run
   * off the top, and slides sideways to stay on screen. */
  function placeCard(r) {
    var node = $('place');
    var at = r && toScreen(r.wine.lon, r.wine.lat);
    node.hidden = !at || !at.front;
    if (node.hidden) return;
    var w = node.offsetWidth, h = node.offsetHeight;
    var below = at.y - PLACE_GAP - h < 8;
    var x = clamp(at.x, w / 2 + 8, vw - w / 2 - 8);
    node.classList.toggle('below', below);
    node.style.left = x + 'px';
    node.style.top = (below ? at.y + PLACE_GAP : at.y - PLACE_GAP - h) + 'px';
    node.style.setProperty('--tail', (at.x - x + w / 2) + 'px');
  }

  /** The words on that card: where the region is, and the grapes it is
   * known for. A grape the region calls by a local name comes as
   * [local, international] and is shown with both. */
  function fillCard(wine) {
    var country = byId[wine.country];
    var countryName = country ? country.name : '';
    var grapes = wine.grapes || [];
    $('place-name').textContent = wine.name;
    $('place-where').textContent = wine.division
      ? t('place.where', { division: wine.division, country: countryName })
      : countryName;
    $('place-grapes').textContent = grapes.length
      ? t('place.grapes', { grapes: grapes.map(grapeName).join(t('place.grapeJoin')) })
      : '';
    $('place-grapes').hidden = !grapes.length;
  }

  function grapeName(grape) {
    return typeof grape === 'string' ? grape
      : t('place.grapeAka', { grape: grape[0], aka: grape[1] });
  }

  function place(node, attrs) {
    Object.keys(attrs).forEach(function (name) {
      var value = attrs[name];
      node.setAttribute(name, typeof value === 'number' ? value.toFixed(2) : value);
    });
  }

  function dotAt(node, p, r) {
    node.style.display = p.front ? '' : 'none';
    place(node, { cx: p.x, cy: p.y, r: r });
  }

  /** The great circle from a to b as path data, broken round the back. */
  function arcPath(a, b) {
    var va = vec(a.lon, a.lat), vb = vec(b.lon, b.lat);
    var steps = Math.max(2, Math.ceil(Math.acos(clamp(dot(va, vb), -1, 1)) / RAD));
    var d = '', open = false;
    for (var i = 0; i <= steps; i++) {
      var g = geoOf(slerp(va, vb, i / steps));
      var p = toScreen(g.lon, g.lat);
      if (!p.front) { open = false; continue; }
      d += (open ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      open = true;
    }
    return d;
  }

  // ------------------------------------------------------------------ picking
  /** Light up the country a click landed on, if any. */
  function light(c) {
    selected = c;
    draw();
  }

  /** A click on the globe: the pin goes wherever it fell, land or sea, and
   * moves with every click until the guess is locked in. */
  function onTap(clientX, clientY) {
    if (waiting || locked || turn < 0) return;
    var p = toMap(clientX, clientY);
    var geo = fromScreen(p.x, p.y);
    if (!geo) {
      clearPin();
      showRound();
      say(t('round.offMap'));
      return;
    }
    var hit = countryAt(geo);
    if (countryOnly && !hit) {
      // Only a country can be the answer: the sea leaves nothing picked.
      clearPin();
      showRound();
      say(t('round.notCountry'));
      return;
    }
    pin = { lon: geo.lon, lat: geo.lat };
    light(hit && hit.inPlay ? hit : null);
    showRound();
  }

  function clearPin() {
    pin = null;
    light(null);
  }

  // --------------------------------------------------------------------- game
  /** Points for a pin this far from the region: full marks within FULL_KM,
   * then falling away smoothly - 100 km off is worth ~920, 1,000 km ~280. */
  function pointsFor(km) {
    if (km <= FULL_KM) return MAX_POINTS;
    return Math.round(MAX_POINTS * Math.exp(-(km - FULL_KM) / FALLOFF_KM));
  }

  /** ROUNDS regions from the whole world, no repeats. Famous regions come
   * up more often (weighted by score squared, so Bordeaux is about six
   * times as likely as the bottom of the list), and no country gets more than
   * PER_COUNTRY of them. `random` stands in for Math.random. */
  function pickWines(random) {
    var named = {};
    var pool = WINES.filter(function (c) {
      if (named[c.name]) return false;     // one of each name: see nearestNamed()
      named[c.name] = true;
      return true;
    });
    var chosen = [];
    var perCountry = {};
    while (chosen.length < ROUNDS && pool.length) {
      var open = pool.filter(function (c) { return (perCountry[c.country] || 0) < PER_COUNTRY; });
      if (!open.length) open = pool;
      var total = open.reduce(function (sum, c) { return sum + c.score * c.score; }, 0);
      var roll = random() * total;
      var pick = open[open.length - 1];
      for (var i = 0; i < open.length; i++) {
        roll -= open[i].score * open[i].score;
        if (roll <= 0) { pick = open[i]; break; }
      }
      chosen.push(pick);
      perCountry[pick.country] = (perCountry[pick.country] || 0) + 1;
      pool.splice(pool.indexOf(pick), 1);
    }
    return chosen;
  }

  /** The player is only given a name, so a guess counts against whichever
   * region of that name it landed nearest. The list is in rank order, so
   * the region asked for is the best known of its name. */
  function nearestNamed(wine, guess) {
    var best = wine, bestKm = distanceKm(guess, wine);
    WINES.forEach(function (c) {
      if (c.name !== wine.name || c === wine) return;
      var km = distanceKm(guess, c);
      if (km < bestKm) { best = c; bestKm = km; }
    });
    return best;
  }

  /** Today's date where the daily run turns over, as 'YYYY-MM-DD'. */
  function dailyDay(now) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: DAILY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  /** A day's date for the player to read, e.g. "October 19". */
  function dayName(key) {
    return new Date(key + 'T12:00:00Z').toLocaleDateString(STRINGS.lang || 'en',
      { month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  function modeName() {
    if (mode === 'daily') return t('mode.daily', { date: dayName(day) });
    return t(countryOnly ? 'mode.practiceCountry' : 'mode.practice');
  }

  /** A random number generator that always gives the same numbers for the
   * same text: the string is hashed (cyrb53's mixing) into a seed for
   * mulberry32. Everyone playing the same day gets the same regions. */
  function seededRandom(text) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    var a = h1 >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The region of this one's name in a country, if the list has one. */
  function sameNameIn(wine, countryId) {
    return WINES.filter(function (c) {
      return c.name === wine.name && c.country === countryId;
    })[0] || null;
  }

  function newRun() {
    clearMarks();
    var random = mode === 'daily' ? seededRandom('wine:' + day) : Math.random;
    rounds = pickWines(random).map(function (wine) {
      // The hint is one of the region's facts, drawn now so it stays put.
      var facts = wine.facts || [];
      return { wine: wine, fact: facts[Math.floor(random() * facts.length)] };
    });
    turn = -1;
    showScore();
    nextTurn();
  }

  function nextTurn() {
    turn += 1;
    locked = false;
    clearPin();
    rounds.forEach(function (r) {
      if (r.marks) r.marks.group.classList.add('past');
    });
    flyTo(homeView());
    showRound();
  }

  /** The guess is in: show the region, a line from the pin, and the score. */
  function lockIn() {
    if (!pin || locked) return;
    var r = rounds[turn];
    r.guess = { lon: pin.lon, lat: pin.lat };
    if (countryOnly) {
      // The country is the answer: full marks or none. Of two regions of the
      // name, the one in the country picked counts, as nearestNamed() does.
      r.picked = selected && selected.id;
      r.wine = sameNameIn(r.wine, r.picked) || r.wine;
      r.right = r.picked === r.wine.country;
      r.km = distanceKm(r.guess, r.wine);
      r.points = r.right ? 1 : 0;
    } else {
      r.wine = nearestNamed(r.wine, r.guess);
      r.km = distanceKm(r.guess, r.wine);
      r.points = pointsFor(r.km);
    }
    locked = true;
    clearPin();
    fillCard(r.wine);
    addMarks(r);
    showScore();
    showRound();
    flyTo(viewFor([r.guess, r.wine], 0.6, REVEAL_DEG), 700);
  }

  function finish() {
    done = true;
    rounds.forEach(function (r) {
      if (r.marks) r.marks.group.classList.remove('past');
    });
    flyTo(homeView());
    showResults();
  }

  /** The one button under the map: lock in, then next, then results. */
  function go() {
    if (waiting || turn < 0) return;
    if (!locked) lockIn();
    else if (turn < rounds.length - 1) nextTurn();
    else if (!done) finish();
    else showResults();
  }

  $('round-go').addEventListener('click', go);

  function addMarks(r) {
    var g = el('g');
    g.setAttribute('class', 'mark');
    // Positions and sizes are set in render(), through the camera. The line
    // is the great circle from the guess to the region.
    var line = el('path');
    line.setAttribute('class', 'mark-line');
    var guess = el('circle');
    guess.setAttribute('class', 'mark-guess');
    var target = el('circle');
    target.setAttribute('class', 'mark-wine');
    var label = el('text');
    label.setAttribute('class', 'label mark-label');
    label.textContent = r.wine.name;
    [line, guess, target, label].forEach(function (node) { g.appendChild(node); });
    $('marks').appendChild(g);
    r.marks = { group: g, line: line, guess: guess, target: target, label: label };
    draw();
  }

  function clearMarks() {
    $('marks').textContent = '';
    rounds = [];
    turn = -1;
    locked = false;
    done = false;
  }

  function num(n) {
    return n.toLocaleString(STRINGS.lang || 'en');
  }

  function totalPoints() {
    return rounds.reduce(function (sum, r) { return sum + (r.points || 0); }, 0);
  }

  function showScore() {
    $('score').textContent = num(totalPoints());
  }

  /** The region asked for and its hint, over the top of the map, and the line
   * and button under it - both follow the round through placing, locked in
   * and done. */
  function showRound() {
    var r = rounds[turn];
    $('round').hidden = !r;
    $('target').hidden = !r;
    if (!r) return;
    $('hint').hidden = !r.fact;
    $('target-count').textContent = t('round.count', { n: turn + 1, total: rounds.length });
    $('target-name').textContent = r.wine.name;
    $('hint').textContent = r.fact || '';

    var button = $('round-go');
    if (locked) {
      var home = byId[r.wine.country];
      say(!countryOnly ? t('round.result', { km: num(Math.round(r.km)), points: num(r.points) })
        : r.right ? t('round.right', { points: num(r.points) })
        : t('round.wrong', { country: home ? home.name : '', points: num(r.points) }));
      button.textContent = t(turn < rounds.length - 1 ? 'round.next' : 'round.results');
      button.disabled = false;
    } else {
      say(t(countryOnly ? (pin ? 'round.readyCountry' : 'round.promptCountry')
        : (pin ? 'round.ready' : 'round.prompt')));
      button.textContent = t('round.lock');
      button.disabled = !pin;
    }
  }

  function say(text) {
    $('round-line').textContent = text;
  }

  // ------------------------------------------------------------------ results
  var results = $('results');

  function showResults() {
    var list = $('results-list');
    list.textContent = '';
    rounds.forEach(function (r) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="name"></span><span class="km"></span><b class="points"></b>';
      var country = byId[r.wine.country];
      li.querySelector('.name').textContent = r.wine.name + (country ? ', ' + country.name : '');
      li.querySelector('.km').textContent = countryOnly
        ? t(r.right ? 'results.right' : 'results.wrong')
        : t('results.km', { km: num(Math.round(r.km)) });
      li.querySelector('.points').textContent = t('results.points', { points: num(r.points) });
      list.appendChild(li);
    });
    $('results-total').textContent = num(totalPoints());
    $('results-max').textContent = t('results.outOf', { max: num((countryOnly ? 1 : MAX_POINTS) * rounds.length) });
    $('results-line').textContent = t('results.line', { mode: modeName() });
    var share = $('results-share');
    share.hidden = mode !== 'daily';
    share.classList.remove('done');
    share.textContent = t('results.share');
    results.hidden = false;
    $('results-again').focus();
  }

  /** A coloured square for how close a pin was, by its points. */
  function markFor(points) {
    var share = points / MAX_POINTS;
    return share >= 1 ? '\u{1F3AF}'      // dart: full marks
      : share >= .75 ? '\u{1F7E9}'       // green
      : share >= .4 ? '\u{1F7E8}'        // yellow
      : share >= .15 ? '\u{1F7E7}'       // orange
      : '\u{1F7E5}';                     // red
  }

  /** The day's run as text to paste: no region names, just distances. */
  function shareText() {
    var lines = [
      t('share.head', { date: dayName(day) }),
      t('share.score', { total: num(totalPoints()), max: num(MAX_POINTS * rounds.length) }),
      rounds.map(function (r) { return markFor(r.points); }).join(''),
      ''
    ];
    rounds.forEach(function (r, i) {
      lines.push(t('share.row', { n: i + 1, mark: markFor(r.points), km: num(Math.round(r.km)) }));
    });
    if (/^https?:/.test(location.protocol)) lines.push('', location.origin + location.pathname);
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* reported below */ }
      document.body.removeChild(area);
      ok ? resolve() : reject();
    });
  }

  $('results-share').addEventListener('click', function () {
    var button = this;
    copyText(shareText()).then(function () {
      button.textContent = t('results.copied');
      button.classList.add('done');
    }, function () {
      button.textContent = t('results.copyFailed');
    });
  });

  $('results-look').addEventListener('click', function () {
    results.hidden = true;
  });

  $('results-again').addEventListener('click', function () {
    results.hidden = true;
    waiting = false;
    reset();
  });

  // -------------------------------------------------------------------- panel
  var rows = {};

  DATA.regions.forEach(function (region) {
    var li = document.createElement('li');
    li.style.setProperty('--region', 'var(--' + slug(region) + ')');
    li.innerHTML = '<i class="swatch"></i><span class="name"></span>' +
      '<span class="count"></span><span class="meter"><i></i></span>';
    li.querySelector('.name').textContent = region;
    li.addEventListener('click', function () {
      flyTo(regionView(region));
    });
    $('regions').appendChild(li);
    rows[region] = { li: li };
  });

  // ------------------------------------------------------------------- input
  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var step = ev.deltaMode === 1 ? ev.deltaY * 0.1 : ev.deltaY * 0.0048;
    zoomAbout(toMap(ev.clientX, ev.clientY), Math.exp(-step));
  }, { passive: false });

  var touches = new Map();
  var dragFrom = null;
  var pinchFrom = null;
  var tapFrom = null;      // a press that has not yet turned into a drag

  function pinchState() {
    var pts = Array.from(touches.values());
    var dx = pts[0].x - pts[1].x;
    var dy = pts[0].y - pts[1].y;
    return {
      dist: Math.max(1, Math.hypot(dx, dy)),
      mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
    };
  }

  svg.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    // Some mobile browsers refuse capture for a second finger; a throw here
    // would lose the pinch, so carry on without it.
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* uncaptured */ }
    if (touches.size === 1) {
      dragFrom = { x: ev.clientX, y: ev.clientY };
      tapFrom = { x: ev.clientX, y: ev.clientY };
      svg.classList.add('dragging');
    } else if (touches.size === 2) {
      dragFrom = null;
      tapFrom = null;                 // two fingers: a pinch, never a tap
      pinchFrom = pinchState();
    }
  });

  svg.addEventListener('pointermove', function (ev) {
    if (!touches.has(ev.pointerId)) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (tapFrom && Math.hypot(ev.clientX - tapFrom.x, ev.clientY - tapFrom.y) > TAP_SLOP) {
      tapFrom = null;                 // the hand moved: this is a pan
    }

    if (touches.size === 2 && pinchFrom) {
      var now = pinchState();
      zoomAbout(toMap(now.mid.x, now.mid.y), now.dist / pinchFrom.dist);
      pinchFrom = now;
      return;
    }
    if (dragFrom) {
      // Keep the spot that was under the pointer under it.
      var from = toMap(dragFrom.x, dragFrom.y);
      var to = toMap(ev.clientX, ev.clientY);
      var grabbed = fromScreen(from.x, from.y);
      if (!grabbed || !aim(grabbed, to)) spin(to.x - from.x, to.y - from.y);
      dragFrom = { x: ev.clientX, y: ev.clientY };
      applyView();
    }
  });

  function endPointer(ev) {
    touches.delete(ev.pointerId);
    if (touches.size < 2) pinchFrom = null;
    if (touches.size === 0) {
      dragFrom = null;
      svg.classList.remove('dragging');
    } else if (touches.size === 1) {
      var only = Array.from(touches.values())[0];
      dragFrom = { x: only.x, y: only.y };
    }
  }

  svg.addEventListener('pointerup', function (ev) {
    var tap = tapFrom;
    tapFrom = null;
    endPointer(ev);
    if (tap && !touches.size) onTap(ev.clientX, ev.clientY);
  });

  svg.addEventListener('pointercancel', function (ev) {
    tapFrom = null;
    endPointer(ev);
  });

  // iOS Safari zooms the whole page on a pinch whatever touch-action says,
  // through its own gesture events and the touches under them. Hold both
  // back over the stage so the pinch reaches the globe instead.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    stage.addEventListener(type, function (ev) { ev.preventDefault(); });
  });
  stage.addEventListener('touchmove', function (ev) {
    if (ev.touches.length > 1) ev.preventDefault();
  }, { passive: false });

  svg.addEventListener('dblclick', function (ev) {
    zoomAbout(toMap(ev.clientX, ev.clientY), 2.4);
  });

  $('zoom-in').addEventListener('click', function () {
    zoomAbout(centre(), ZOOM_STEP);
  });
  $('zoom-out').addEventListener('click', function () {
    zoomAbout(centre(), 1 / ZOOM_STEP);
  });
  $('zoom-fit').addEventListener('click', function () {
    flyTo(homeView());
  });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  else window.addEventListener('resize', resize);

  // The palette lives in the stylesheet; a change of theme changes it.
  if (window.matchMedia) {
    var scheme = window.matchMedia('(prefers-color-scheme: dark)');
    var recolor = function () { readColors(); draw(); };
    if (scheme.addEventListener) scheme.addEventListener('change', recolor);
    else if (scheme.addListener) scheme.addListener(recolor);
  }

  window.addEventListener('keydown', function (ev) {
    if (waiting) return;
    if (!results.hidden) {
      if (ev.key === 'Escape') results.hidden = true;
      return;
    }
    if (ev.key === '+' || ev.key === '=') zoomAbout(centre(), ZOOM_STEP);
    else if (ev.key === '-') zoomAbout(centre(), 1 / ZOOM_STEP);
    else if (ev.key === '0') flyTo(homeView());
    else if (ev.key === 'Enter' || ev.key === ' ') {
      if (ev.target.tagName === 'BUTTON') return;   // the button does it itself
      ev.preventDefault();
      go();
    } else if (ev.key === 'Escape' && !locked) {
      clearPin();
      showRound();
    }
  });

  // ------------------------------------------------------------------ splash
  /* Every run opens behind a splash, then a countdown into the first region. */
  var splash = $('splash');
  var countEl = $('countdown');
  var dailyEl = $('splash-daily');

  var kindsEl = $('practice-kinds');
  var practiceEl = $('splash-practice');

  /** Practice is picked: offer its two kinds, which start the run. */
  function showKinds(open) {
    kindsEl.hidden = !open;
    practiceEl.setAttribute('aria-expanded', String(open));
    if (open) $('practice-normal').focus();
  }

  /** Hold the run at the splash until the player picks daily or practice. */
  function arm() {
    clearTimeout(countTimer);
    waiting = true;
    countEl.textContent = '';
    splash.classList.remove('counting');
    $('splash-line').textContent = t('splash.pickLine', { n: ROUNDS });
    $('splash-daily-line').textContent = t('splash.dailyLine', { date: dayName(dailyDay(new Date())) });
    splash.hidden = false;
    showKinds(false);
    dailyEl.focus();
  }

  /** 3, 2, 1. The class comes off and goes back on so each number animates. */
  function countIn(n) {
    if (n <= 0) {
      splash.hidden = true;
      splash.classList.remove('counting');
      countEl.textContent = '';
      launch();
      return;
    }
    countEl.classList.remove('tick');
    void countEl.offsetWidth;
    countEl.textContent = t('splash.count', { n: n });
    countEl.classList.add('tick');
    countTimer = setTimeout(function () { countIn(n - 1); }, COUNT_STEP);
  }

  /** Into a run of `which` mode: 'daily', 'practice' or 'country' (the
   * country-only practice). The daily regions are the date's at the moment
   * the player starts, so a run begun at 11:59 pm keeps its regions. */
  function begin(which) {
    if (!waiting || splash.classList.contains('counting')) return;
    mode = which === 'practice' || which === 'country' ? 'practice' : 'daily';
    countryOnly = which === 'country';
    day = dailyDay(new Date());
    $('mode-tag').textContent = modeName();
    splash.classList.add('counting');
    countIn(COUNT_FROM);
  }

  dailyEl.addEventListener('click', function () { begin('daily'); });
  practiceEl.addEventListener('click', function () { showKinds(kindsEl.hidden); });
  $('practice-normal').addEventListener('click', function () { begin('practice'); });
  $('practice-country').addEventListener('click', function () { begin('country'); });

  function launch() {
    waiting = false;
    newRun();
  }

  /** Back to the splash, with nothing on the map. */
  function reset() {
    clearMarks();
    clearPin();
    showRound();
    showScore();
    results.hidden = true;
    if (!waiting) arm();
  }

  $('reset').addEventListener('click', function () {
    waiting = false;
    reset();
  });

  /* Wording the markup ships empty: data-t sets an element's text, and
   * data-t-<attr> sets one attribute, so <title>, the aria labels and the
   * zoom tooltips all come from the same file as everything else. */
  var T_ATTRS = ['title', 'placeholder', 'aria-label'];

  function translateStatic() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-t]'), function (node) {
      node.textContent = t(node.getAttribute('data-t'));
    });
    T_ATTRS.forEach(function (name) {
      var mark = 'data-t-' + name;
      Array.prototype.forEach.call(document.querySelectorAll('[' + mark + ']'), function (node) {
        node.setAttribute(name, t(node.getAttribute(mark)));
      });
    });
    document.documentElement.lang = STRINGS.lang || 'en';
  }

  // --------------------------------------------------------------------- boot
  translateStatic();
  readColors();
  resize();
  jumpTo(homeView());
  reset();                   // arms the splash
  setTimeout(function () {
    loadScript(GLOBE_DIR + 'l1.js');
    loadScript(GLOBE_DIR + 'l2.js');
  }, 0);

  // Handle for the console (and for whatever drives the game later).
  window.WineGuesser = {
    countries: countries,
    byId: byId,
    windows: DATA.windows,
    regions: DATA.regions,
    toScreen: toScreen,
    fromScreen: fromScreen,
    distanceKm: distanceKm,
    viewFor: viewFor,
    flyTo: flyTo,
    showRegion: function (region, ms) { flyTo(regionView(region), ms); },
    /** Fly to a longitude and latitude, `span` degrees across. */
    showPlace: function (lon, lat, span, ms) {
      flyTo(viewFor([{ lon: lon, lat: lat }], 1, span || 8), ms);
    },
    /** Show every region in the list as a dot, for checking the data. */
    showAllWines: function (on) { showWines = on !== false; draw(); },
    start: begin,
    reset: reset,
    get waiting() { return waiting; },
    get pin() { return pin && { lon: pin.lon, lat: pin.lat, country: selected && selected.id }; },
    wines: WINES,
    get rounds() { return rounds; },
    get view() { return { lon: view.lon, lat: view.lat, k: view.k }; }
  };
})();
