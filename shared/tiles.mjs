/* shared/tiles.mjs — the fills/{z}/{x}/{y}.json pyramid, shared by the editor and the
   publisher.

   Two arguments replace two globals and nothing else moved: the FeatureCollection to cut,
   and the `built` timestamp (so a test can pin it and compare the tree byte for byte).
   See geometry.mjs for the rules every module here follows, including why `turf` is still
   read off the global.

   CONVENTIONS §10's three paired rules about this code — a true polygon intersection and
   never turf.bboxClip, no overlap margin, props.json carrying `o` — are untouched by the
   move and are spelled out in the comments below.

   Moved out of editor.html on 2026-08-30 with no change to any body. */

import { nowIso } from './geometry.mjs';
import { orderRegions } from './regions.mjs';

// ─────────────────────────────────────────────────────────────
// FILL TILES — the published rendering projection of control_regions.geojson
// ─────────────────────────────────────────────────────────────
// map.html used to fetch the whole file (578 KB, 156 KB gzipped) on load and on every 60 s
// poll, then spend 1.3 s in its own closeGaps() re-deriving the same 15 m buffer every other
// reader had already derived. This cuts the fills into a fills/{z}/{x}/{y}.json pyramid at
// publish time, with that buffer baked in, so a reader downloads only the tiles their viewport
// covers and the browser does no geometry work at all. Measured on 2026-08-13 against the file
// it replaces: opening z7 view 27.9 KB instead of 156 KB (12.5 KB on a phone), z12 view of the
// front 0.9 KB, fills on screen in ~120 ms instead of ~1450 ms. The whole set is 1402 files /
// 606 KB gzipped, and a typical single-settlement save rewrites ~8 of them.
//
// This is a DELIVERY change and nothing else. Colours, patterns, draw order, the recent-change
// highlight and the 15 m gap close are all exactly what they were; verified 2026-08-13, and
// re-verified 2026-08-17 against the merged geometry, by rendering both versions into
// map.html's own fills canvas across eight views and diffing the pixels — coverage
// 99.959-100%, hard differences 0.004-0.156%, and each hatch band colour's share of the
// painted area within 0.019 percentage points between the two. That last figure is what says
// the pattern phase survives the cut: Leaflet fills every shape from one shared CanvasPattern
// anchored to the canvas, not to the polygon, so splitting a polygon across tiles cannot shift
// its stripes. What residual there is at the low zooms is the 0.4 px simplification those
// zooms are published at — switch it off and the z7 figures collapse to 0. See
// ARCHITECTURE.md §3.10 for the full table and the two traps in re-running it.
//
// Four decisions here are load-bearing:
//
//   1. **Simplify first, then clip.** Simplifying the clipped pieces instead would move each
//      side of a shared tile edge by a different amount and open a crack along every seam.
//      Simplifying the whole feature first means both tiles cut the same line in the same place.
//   2. **Clip exactly at the tile edge, no overlap margin.** Pieces then stay spatially
//      disjoint, which is what keeps CONVENTIONS §10's draw order safe once tiles arrive in
//      whatever order the network delivers them: within a tile the features are in regionsFC
//      order so oblast washes still come first, and across tiles nothing overlaps to bury.
//      A margin would also double-draw the antialiased edges of the attack hatch's transparent
//      gaps, darkening a band along every seam.
//   3. **turf.intersect, NOT turf.bboxClip.** bboxClip is 24x faster and gets the area right,
//      and it still cannot be used: it joins a ring that leaves and re-enters the tile with a
//      zero-width bridge along the tile edge, which has no area but is still on the path, and
//      Leaflet strokes the path. fillClipToBox() below has the full record and the
//      measurement. This bullet said the opposite until the pixel diff found it.
//   4. **The top zoom is published unsimplified.** Nothing exists above it — Leaflet is
//      drawing vectors, so zooming past FILL_TILE_MAX_Z reuses those tiles rather than
//      upscaling an image — which makes that level the one a reader can inspect at z18.
//      Every zoom below it is simplified to 0.4 px of its OWN scale, where 0.4 px is the
//      most that measured clean in the pixel diff.
var FILL_DIR = 'fills';
var FILL_TILE_MIN_Z = 4;    // the whole country is 2 tiles here; below it the same set is reused
var FILL_TILE_MAX_Z = 10;   // 1000 tiles, unsimplified. z9 is a third the files but doubles the
                            // cost of the close-up front view, which is the view most read
var FILL_TILE_SIMPLIFY_PX = 0.4;
var FILL_GAP_CLOSE_M = 15;  // must equal map.html's GAP_CLOSE_M — this is that buffer, moved here

var FILL_MERC_R = 6378137, FILL_MERC_HALF = Math.PI * FILL_MERC_R;
function fillLngToMerc(lng) { return lng * FILL_MERC_HALF / 180; }
function fillLatToMerc(lat) {
  var l = Math.max(-85.051129, Math.min(85.051129, lat));
  return Math.log(Math.tan((90 + l) * Math.PI / 360)) * FILL_MERC_R;
}
function fillMercToLng(x) { return x * 180 / FILL_MERC_HALF; }
function fillMercToLat(y) {
  return (2 * Math.atan(Math.exp(y / FILL_MERC_R)) - Math.PI / 2) * 180 / Math.PI;
}
// The clip box is the tile's exact bounds — no overlap margin, deliberately, and this was
// arrived at the hard way.
//
// Cutting a polygon at a tile edge creates boundary the polygon never had, and every fill is
// stroked 1 px in its own colour (factionStyle()'s hairline closer), so that invented edge
// gets painted. Measured at z10: a contested pocket crossing the x=618/619 boundary drew a
// 2 px line of hatch ALONG the seam, 528 pixels of it, over ground the file says is nothing
// but solid Ukraine blue.
//
// Growing the boxes so neighbouring tiles overlap looks like the fix and is not. It moves the
// invented edge onto the neighbour's copy of the same feature, which does hide it — but two
// overlapping pieces are then drawn twice, and Leaflet fills polygons with the **even-odd**
// rule, so an overlap is punched out as a hole rather than painted twice. Even where even-odd
// is not reached, the attack hatch's transparent gaps double-blend across the whole overlap
// band: measured, it made that view worse (0.12% -> 0.29% of pixels differing hard).
//
// What actually works is on the rendering side: map.html merges every piece of one feature
// back into a single MultiPolygon before drawing, so the cuts become INTERIOR edges of one
// canvas path, filled in one pass with no seam, and the 1 px stroke that used to paint them
// now lands on that feature's own fill in its own colour and disappears. That merge is what
// makes exact clipping correct, and exact clipping is what keeps the merge's even-odd fill
// honest. The two belong together; changing either alone brings the seams back.
function fillTileBbox(z, x, y) {
  var s = 2 * FILL_MERC_HALF / Math.pow(2, z);
  var mx = -FILL_MERC_HALF + x * s, myTop = FILL_MERC_HALF - y * s;
  return [fillMercToLng(mx), fillMercToLat(myTop - s),
          fillMercToLng(mx + s), fillMercToLat(myTop)];
}
function fillTileX(lng, z) {
  return Math.floor((fillLngToMerc(lng) + FILL_MERC_HALF) / (2 * FILL_MERC_HALF / Math.pow(2, z)));
}
function fillTileY(lat, z) {
  return Math.floor((FILL_MERC_HALF - fillLatToMerc(lat)) / (2 * FILL_MERC_HALF / Math.pow(2, z)));
}
function fillBboxOverlap(a, b) {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// Coordinate precision per zoom, which is worth as much as the simplification is. Five
// decimals (1.1 m) is the right answer at the top zoom, where a reader can be at z18; at z7,
// where one screen pixel is ~410 m of ground, it is fifteen wasted characters per vertex.
// This rounds to about a quarter of a pixel at each zoom, floored at 2 decimals.
function fillDecimalsFor(z) {
  if (z >= FILL_TILE_MAX_Z) return 5;
  var quarterPx = (360 / (256 * Math.pow(2, z))) / 4;
  return Math.max(2, Math.min(5, Math.ceil(-Math.log10(quarterPx))));
}
function fillRoundGeom(geom, nd) {
  var p = Math.pow(10, nd);
  function walk(c) {
    return Array.isArray(c[0]) ? c.map(walk)
      : [Math.round(c[0] * p) / p, Math.round(c[1] * p) / p];
  }
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}
// Rounding and Sutherland–Hodgman both leave rings that enclose no area — a ring collapsed
// onto a line, or a zero-width sliver along the cut. They render as nothing and cost bytes in
// every tile they appear in, so they come out here. Judged on ring length alone: a closed ring
// needs four positions to bound anything.
function fillPruneGeom(geom) {
  var ok = function (r) { return r.length >= 4; };
  if (geom.type === 'Polygon') {
    var rings = geom.coordinates.filter(ok);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geom.type === 'MultiPolygon') {
    var polys = geom.coordinates.map(function (p) { return p.filter(ok); })
                                .filter(function (p) { return p.length; });
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }
  return null;
}

// The 15 m gap close, lifted verbatim from map.html's closeGaps() — including its fallback of
// keeping the unbuffered feature when turf throws, so a geometry that defeats the buffer still
// gets published rather than vanishing. Same buffer, same defaults, same result; it just runs
// once here instead of once per reader per load.
function fillClosedFeatures(regionsFC) {
  orderRegions(regionsFC);   // CONVENTIONS §10: washes, then solid fills, then attack hatches — tiles inherit this array order
  var out = [];
  regionsFC.features.forEach(function (f) {
    if (!f.geometry) return;
    var b = null;
    try { b = turf.buffer(f, FILL_GAP_CLOSE_M, { units: 'meters' }); } catch (e) {}
    if (b && b.geometry) { b.properties = f.properties; out.push(b); }
    else out.push(f);
  });
  return out;
}

// Only what map.html reads to PAINT a shape, under the feature's own property names so that
// paintStyle()/isRecentRegion()/isHighlighted() there treat a tile feature exactly like a
// control_regions.geojson feature. Kept out of the tiles themselves because a feature spans
// many tiles: inlining these measured 126 KB across the set against 5 KB in one file.
var FILL_PROP_KEYS = ['id', 'faction', 'pattern', 'zone_type',
                      'last_updated', 'faction_set_at', 'exclude_from_timeline'];
function fillPropsOf(features) {
  var props = {};
  features.forEach(function (f, i) {
    var p = f.properties || {};
    if (!p.id) return;
    var kept = {};
    FILL_PROP_KEYS.forEach(function (k) {
      if (p[k] !== undefined && p[k] !== null) kept[k] = p[k];
    });
    // `o` is this feature's index in the published array — the draw order CONVENTIONS §10
    // governs, carried across the tile split. map.html gathers pieces from many tiles into one
    // layer and sorts on this to reproduce the file's order exactly. Without it the pieces
    // draw in whatever order the tiles came back from the network, and every fill's 1 px
    // hairline stroke bleeds half a pixel over its neighbour's ground along the seams.
    // orderRegions() has already run (fillClosedFeatures() calls it), so index 0..n here is
    // oblast washes first, then everything else, exactly as the file is written.
    kept.o = i;
    props[p.id] = kept;
  });
  return props;
}

// Builds the whole pyramid. Returns { files, tileCount } where files is
// [{ path, content }] covering every tile plus manifest.json and props.json — the complete
// desired state of FILL_DIR, which is what lets both of the editor's save paths diff against
// what is already published and touch only the difference.
//
// `opts.now` overrides the manifest's `built` stamp. It exists so the byte-for-byte test can
// pin it; nothing in the editor passes it, and the default is the same nowIso() the manifest
// has always carried.
function buildFillTiles(regionsFC, opts) {
  var now = (opts && opts.now) || nowIso();
  var features = fillClosedFeatures(regionsFC);
  var tiles = new Map();   // "z/x/y" -> [ { i, g } ]

  for (var z = FILL_TILE_MIN_Z; z <= FILL_TILE_MAX_Z; z++) {
    var nd = fillDecimalsFor(z);
    var tol = z === FILL_TILE_MAX_Z
      ? 0 : FILL_TILE_SIMPLIFY_PX * (360 / (256 * Math.pow(2, z)));
    for (var fi = 0; fi < features.length; fi++) {
      var f = features[fi];
      var id = (f.properties || {}).id;
      if (!id) continue;
      var g = f;
      if (tol) {
        var s = null;
        try { s = turf.simplify(f, { tolerance: tol, highQuality: false, mutate: false }); }
        catch (e) {}
        // A feature simplified out of existence at this zoom is still real ground; publishing
        // the unsimplified shape costs bytes, dropping it loses territory off the map.
        if (s && s.geometry && s.geometry.coordinates && s.geometry.coordinates.length) g = s;
      }
      emitFillPieces(g, id, z, nd, tiles);
    }
  }

  var files = [];
  var manifestTiles = {};
  tiles.forEach(function (items, key) {
    var parts = key.split('/');
    var z = parts[0], x = parts[1], y = +parts[2];
    (manifestTiles[z] = manifestTiles[z] || {});
    (manifestTiles[z][x] = manifestTiles[z][x] || []).push(y);
    files.push({ path: FILL_DIR + '/' + key + '.json',
                 content: JSON.stringify({ f: items }) });
  });
  Object.keys(manifestTiles).forEach(function (z) {
    Object.keys(manifestTiles[z]).forEach(function (x) {
      manifestTiles[z][x].sort(function (a, b) { return a - b; });
    });
  });

  files.push({
    path: FILL_DIR + '/manifest.json',
    content: JSON.stringify({
      v: 1,
      // map.html compares this against the copy it holds and drops its tile cache when it
      // moves. It is the only thing that tells a reader mid-session that a save happened, so
      // it has to change on every publish even if the tile set happens to be identical.
      built: now,
      minZoom: FILL_TILE_MIN_Z, maxZoom: FILL_TILE_MAX_Z,
      tiles: manifestTiles,
    }),
  });
  files.push({
    path: FILL_DIR + '/props.json',
    content: JSON.stringify(fillPropsOf(features)),
  });
  return { files: files, tileCount: tiles.size };
}

// Cut a feature down to one tile's box.
//
// This must be a real polygon intersection, and the fast alternative is a trap worth spelling
// out because it costs nothing visible until you diff pixels. turf.bboxClip is Sutherland–
// Hodgman and is 24x faster here (a full z8 descent in 130 ms against 3149 ms), and it gets
// the AREA exactly right — measured on the Kupyansk contested pocket against tile 10/618/349,
// both give 6.9882 km². What it also emits, for any polygon that leaves and re-enters the box,
// is a zero-width bridge running along the box edge, joining the crossings. Zero width means
// zero area, so nothing about the fill or the area check ever notices it. But it is still a
// segment of the path, and Leaflet strokes the path — so every such bridge is painted as a
// 1 px line of that feature's colour lying exactly on the tile seam. On the public map that
// was a 2 px stripe of contested hatch running down the x=618/619 boundary across solid
// Ukraine blue, 264 pixels of it in one view, and turf.difference refusing the geometry as
// invalid is the same defect showing up as a hard error rather than a smudge.
//
// So: correctness over speed here. Nothing about this runs on a reader's machine.
function fillClipToBox(feature, bb) {
  var c = null;
  try { c = turf.intersect(feature, turf.bboxPolygon(bb)); } catch (e) { return null; }
  if (!c || !c.geometry) return null;
  var g = c.geometry;
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;
  if (!g.coordinates || !g.coordinates.length) return null;
  return c;
}

// Quadtree descent from FILL_TILE_MIN_Z down to the target zoom. Descending beats iterating
// the feature's tile range at the target zoom: a single oblast spans ~900 tiles at z10, and
// clipping the whole polygon against each of them is ~21,000 clips of a 2,000-vertex shape,
// where the descent is shapes that halve at every level.
//
// Measured on the current file (68 features, 28,589 vertices, 57,585 after the 15 m buffer
// doubles them): 5,587 clips over the seven zooms, ~6-7 s for the whole pyramid. An earlier
// note here claimed ~370 ms and ~1,300 clips, which has not been true for a while — z10 alone
// is 5.6 s of it, being 998 tiles cut from UNSIMPLIFIED geometry, and every zoom re-descends
// from FILL_TILE_MIN_Z because each one simplifies to its own scale before cutting (decision 1
// above) and so cannot reuse the level above's pieces. If this needs to get faster, that
// re-descent is the thing to attack, not the clip.
function emitFillPieces(feature, id, targetZ, nd, tiles) {
  function push(x, y, piece) {
    var pruned = fillPruneGeom(fillRoundGeom(piece.geometry, nd));
    if (!pruned) return;
    var key = targetZ + '/' + x + '/' + y;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push({ i: id, g: pruned });
  }
  function descend(piece, z, x, y) {
    if (z === targetZ) { push(x, y, piece); return; }
    var pb = null;
    try { pb = turf.bbox(piece); } catch (e) { return; }
    for (var dx = 0; dx < 2; dx++) {
      for (var dy = 0; dy < 2; dy++) {
        var cx = x * 2 + dx, cy = y * 2 + dy, bb = fillTileBbox(z + 1, cx, cy);
        if (!fillBboxOverlap(pb, bb)) continue;
        var c = fillClipToBox(piece, bb);
        if (c) descend(c, z + 1, cx, cy);
      }
    }
  }
  var b = null;
  try { b = turf.bbox(feature); } catch (e) { return; }
  var x0 = fillTileX(b[0], FILL_TILE_MIN_Z), x1 = fillTileX(b[2], FILL_TILE_MIN_Z);
  var y0 = fillTileY(b[3], FILL_TILE_MIN_Z), y1 = fillTileY(b[1], FILL_TILE_MIN_Z);
  for (var x = x0; x <= x1; x++) {
    for (var y = y0; y <= y1; y++) {
      var c = fillClipToBox(feature, fillTileBbox(FILL_TILE_MIN_Z, x, y));
      if (c) descend(c, FILL_TILE_MIN_Z, x, y);
    }
  }
}

export {
  FILL_DIR, FILL_TILE_MIN_Z, FILL_TILE_MAX_Z, FILL_TILE_SIMPLIFY_PX, FILL_GAP_CLOSE_M,
  buildFillTiles,
};
