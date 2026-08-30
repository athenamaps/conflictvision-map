/* shared/geometry.mjs — coordinate snapping and geodesic area, shared by the editor,
   the viewer and the publisher.

   Not one of the four builders Stage 6 names; it is what those builders stand on.
   snapDeep() is needed by regions.mjs and by history.mjs, and geomAreaKm2()/round3() by
   stats.mjs, so leaving them in editor.html would mean either importing a builder from
   another builder or writing the snap chain out twice — the exact duplication this stage
   exists to remove. It lives here instead, and editor.html imports the whole chain back
   for its own edit paths (which are most of the call sites).

   Two rules hold for every module under shared/:

   1. No DOM and no Leaflet. These functions run in a browser tab, and they run under Node
      in tests and (Stage 8 onward) in the publisher. Anything that reaches for `document`
      or `L` belongs in the page, not here.
   2. `turf` is read off the global, not imported. Both pages load it as a classic
      <script> before their module runs, and Node's test sets globalThis.turf. That is
      what lets the bodies below move across UNCHANGED, `typeof turf === 'undefined'`
      guards and all — a bare `turf` resolves to the global from inside a module exactly
      as it did from inside the page.

   Moved out of editor.html on 2026-08-30 with no change to any body. */

function nowIso()    { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }
function round3(x)   { return Math.round(x * 1000) / 1000; }

// Spherical geodesic area (same formula as turf/geojson-area), returns km²
function ringAreaM2(coords) {
  var R = 6378137, total = 0, len = coords.length;
  if (len < 3) return 0;
  var rad = Math.PI / 180;
  for (var i = 0; i < len; i++) {
    var p1 = coords[i], p2 = coords[(i + 1) % len];
    total += (p2[0] - p1[0]) * rad * (2 + Math.sin(p1[1] * rad) + Math.sin(p2[1] * rad));
  }
  return Math.abs(total * R * R / 2);
}
function geomAreaKm2(geom) {
  if (!geom) return 0;
  var polys = geom.type === 'Polygon' ? [geom.coordinates]
            : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  var m2 = 0;
  polys.forEach(function (rings) {
    rings.forEach(function (ring, i) { m2 += (i === 0 ? 1 : -1) * ringAreaM2(ring); });
  });
  return Math.max(m2, 0) / 1e6;
}

// ─────────────────────────────────────────────────────────────
// COORDINATE GRID SNAP — pin every vertex to a fixed 1e-5° lattice.
//
// turf's boolean ops (union/difference/intersect, run on every weld, cut and meld) return
// exact float64 intersection points, so a single pass leaves runs of vertices millimetres
// apart carrying 17 significant digits each: [24.928833075384567,47.714325061854545],
// [24.928833058581866,47.714325241178315], [24.928833078758046,47.714325647199830] — three
// vertices spanning 6 cm of frontline. Before this existed, 85% of segments in
// control_regions.geojson were under a metre long and the file was 4.3 MB; snapping takes it
// to 0.55 MB with a total-area change of 0.000002%. That is not just disk: Leaflet was
// rendering 111k vertices and every subsequent turf op was chewing through the same noise.
//
// Deliberately a grid snap and NOT turf.simplify. Douglas-Peucker picks which vertices to
// keep based on the ring it is given, so two regions welded along a shared border simplify
// differently from each side and the weld opens up into gaps and overlaps — exactly the
// invariant weldOntoNeighbours() exists to maintain. Rounding is per-vertex and
// deterministic: identical input coordinates land on identical output coordinates, so a
// shared edge stays literally shared. It is also idempotent (snapping twice is snapping
// once), so calling it on every op accumulates no drift.
//
// SNAP_DP = 5 puts the lattice at 1.11 m of latitude and, at 48°N, 0.74 m of longitude —
// worst-case vertex displacement is ~0.7 m, which is well inside the accuracy any of this
// data actually has. Do not raise it without re-checking the file sizes above.
// ─────────────────────────────────────────────────────────────
var SNAP_DP = 5, SNAP_SCALE = Math.pow(10, SNAP_DP);

function snapNum(v) { return Math.round(v * SNAP_SCALE) / SNAP_SCALE; }

// Snap one ring/line, dropping vertices that collapse onto their predecessor. Returns null
// when what is left is no longer a ring (needs 3 distinct corners) or a line (needs 2
// distinct ends) — the caller decides whether losing that part matters.
function snapRing(ring, closed) {
  if (!ring || !ring.length) return null;
  var out = [], i, p, x, y;
  for (i = 0; i < ring.length; i++) {
    p = ring[i];
    if (!p || p.length < 2) continue;
    x = snapNum(p[0]); y = snapNum(p[1]);
    if (out.length && out[out.length - 1][0] === x && out[out.length - 1][1] === y) continue;
    out.push([x, y]);
  }
  if (closed) {
    // The seam vertex is a duplicate by definition, so it is stripped above and re-added
    // here — that also repairs a ring whose input seam had drifted apart in the low digits.
    if (out.length && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    if (out.length < 3) return null;
    out.push([out[0][0], out[0][1]]);
    return out;
  }
  return out.length < 2 ? null : out;
}

// Snap a geometry in place-free fashion (always returns fresh arrays). null means every part
// degenerated — for a Polygon that is a sub-metre boolean-op crumb, not territory.
function snapGeom(geom) {
  if (!geom || !geom.coordinates) return geom || null;
  var t = geom.type, i, rings, polys;
  if (t === 'Polygon') {
    rings = [];
    for (i = 0; i < geom.coordinates.length; i++) {
      var r = snapRing(geom.coordinates[i], true);
      // A hole that collapses is dropped on its own; a collapsed outer ring kills the polygon.
      if (!r) { if (i === 0) return null; continue; }
      rings.push(r);
    }
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (t === 'MultiPolygon') {
    polys = [];
    for (i = 0; i < geom.coordinates.length; i++) {
      var sub = snapGeom({ type: 'Polygon', coordinates: geom.coordinates[i] });
      if (sub) polys.push(sub.coordinates);
    }
    if (!polys.length) return null;
    // Collapsing to a single part is left alone: a MultiPolygon with one member is valid
    // GeoJSON, and rewriting the type here would churn the diff on every save.
    return { type: 'MultiPolygon', coordinates: polys };
  }
  if (t === 'LineString') {
    var ls = snapRing(geom.coordinates, false);
    return ls ? { type: 'LineString', coordinates: ls } : null;
  }
  if (t === 'MultiLineString') {
    var lines = [];
    for (i = 0; i < geom.coordinates.length; i++) {
      var l = snapRing(geom.coordinates[i], false);
      if (l) lines.push(l);
    }
    return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
  }
  if (t === 'Point') return { type: 'Point', coordinates: [snapNum(geom.coordinates[0]), snapNum(geom.coordinates[1])] };
  return geom;
}

// Snap without ever handing back null and without trading validity for bytes — the only
// entry point the rest of the file uses. Call sites are mid-edit and would rather keep an
// unsnapped crumb than lose the operator's feature out from under them.
//
// Rounding moves each vertex by up to ~0.7 m, which is occasionally enough to push one
// across an edge that passed close by: the shape stays where it was but picks up a
// self-intersection. That is not cosmetic — a self-intersecting polygon is undefined
// behaviour for turf's boolean ops (see repairForBoolean below), and Canvas's nonzero fill
// rule punches a phantom hole through legitimately-owned territory wherever overlapping
// windings cancel, which is the whole reason the Repair geometry button exists. Measured
// over a cut against all 63 regions this happens once; the offline migration
// (snap_coordinate_grid.py) avoids it entirely by using GEOS snap-rounding, which re-nodes
// the geometry afterwards, but there is no GEOS in the browser. So: check, and keep the
// unsnapped geometry on the rare occasion snapping would make it worse. A few long-tailed
// vertices in one feature cost far less than a hole in the map.
//
// The fast path carries this. Every producer snaps its own output, so by the time anything
// is re-snapped it is usually already on the lattice, the comparison is a cheap string
// equality, and turf.kinks (24 ms on the largest region here, and quadratic) never runs.
function snapGuarded(geom) {
  var s = snapGeom(geom);
  if (!s) return geom;
  if (JSON.stringify(s) === JSON.stringify(geom)) return geom;
  if (kinkCount(s) > kinkCount(geom)) return geom;
  return s;
}

// Walk a whole FeatureCollection-shaped object, snapping every geometry. Used by the save
// path as a backstop and by the timeline, whose geometries are nested several levels down
// inside events and changes rather than sitting in a flat features array.
function snapDeep(o) {
  if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) o[i] = snapDeep(o[i]); return o; }
  if (o && typeof o === 'object') {
    if (typeof o.type === 'string' && o.coordinates) return snapGuarded(o);
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) o[k] = snapDeep(o[k]);
    return o;
  }
  return o;
}

function kinkCount(geom) {
  if (typeof turf === 'undefined' || !geom) return 0;
  try { return turf.kinks({ type: 'Feature', properties: {}, geometry: geom }).features.length; }
  catch (e) { return 0; }
}

export {
  nowIso, round3,
  ringAreaM2, geomAreaKm2,
  SNAP_DP, SNAP_SCALE, snapNum, snapRing, snapGeom, snapGuarded, snapDeep,
  kinkCount,
};
