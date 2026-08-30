/* shared/history.mjs — frontline_history.json and the event grouping that reads it.

   This is the module the "keep them in step" rule in editor.html and map.html was asking
   for. The grouping (sameGround / groupSameDayChanges / eventRepresentative / groupDelta /
   eventGainLabel) used to exist twice, once per page, kept identical by discipline: a card
   in the editor has to be the same card the public sees, or the × deletes something other
   than what the operator is looking at. Both pages now import it from here, so that is a
   property of the code rather than of whoever edits it next.

   The bodies are map.html's, verbatim — the editor's copy carried thinner comments and
   pointed at map.html for "the full rationale for each constant and denominator choice",
   so the fuller comments are the ones worth keeping. Checked before the move: with
   comments stripped the two copies were identical.

   `timeline` and the `generated` stamp arrive as arguments. eventGainLabel() takes two
   more, because they are the one place the two pages genuinely differed: where the live
   `pattern` is read from (the editor's regionsFC, the viewer's fillProps) and how the
   counter is worded (the editor's English chrome, the viewer's translated STRINGS). See
   geometry.mjs for the rules every module here follows.

   Moved out of editor.html and map.html on 2026-08-30 with no change to any body. */

import { nowIso, snapDeep } from './geometry.mjs';

// The version stamp on both the local timeline.json and the published projection below.
// It lives here rather than in editor.html because it is the timeline schema's version and
// this module is what defines that schema's published half; editor.html imports it back for
// newTimeline() and adoptTimeline().
var TIMELINE_VERSION = 1;

// ── Public frontline history (rolling window) ───────────────────────────────────
// The full local `timeline` (above) stays unbounded and local — it carries a geometry per
// change and is deliberately never published (docs/ARCHITECTURE.md §9). This derives a
// trimmed, bounded projection of it for the public map's calendar scrubber and events
// scroller: only the last HISTORY_RETENTION_DAYS days of entries, and only the fields the
// viewer's reverse-replay actually needs (drops `delta_geometry`/`fields`, which the local
// timeline keeps for other uses). Change the constant to adjust the window; a longer window
// means a larger published file fetched by every viewer.
var HISTORY_RETENTION_DAYS = 90;
// `opts.now` overrides the `generated` stamp, for the byte-for-byte test; the editor passes
// nothing and gets the same nowIso() this file has always carried.
function computeFrontlineHistory(timeline, opts) {
  if (!timeline) return null;
  var now = (opts && opts.now) || nowIso();
  // The window is measured back from `now` rather than from a second Date.now() read, so a
  // pinned `now` pins the whole output and the file becomes a pure function of timeline.json.
  // Unpinned it is nowIso(), which is Date.now() to the second — and the entries this filters
  // are dated at midnight UTC, so a second either way cannot move the boundary.
  var cutoff = new Date(new Date(now).getTime() - HISTORY_RETENTION_DAYS * 86400000);
  var entries = timeline.entries
    .filter(function (e) { return new Date(e.date + 'T00:00:00Z') >= cutoff; })
    .map(function (e) {
      return {
        date: e.date, timestamp: e.timestamp,
        changes: e.changes.map(function (c) {
          return {
            id: c.id, kind: c.kind, action: c.action,
            name: c.name, prev_name: c.prev_name,
            name_en: c.name_en, prev_name_en: c.prev_name_en,
            faction: c.faction, prev_faction: c.prev_faction, pattern: c.pattern || null,
            info_source: c.info_source || null,
            area_km2: c.area_km2, prev_area_km2: c.prev_area_km2, area_delta_km2: c.area_delta_km2,
            base_geometry: c.base_geometry, geometry: c.geometry,
          };
        }),
      };
    });
  // Snapped separately rather than relying on serializeTimeline() having run: this file is
  // published to GitHub on its own, and timeline.json is local-only, so a Save to GitHub
  // without a preceding Save to folder would otherwise ship the millimetre runs to every
  // viewer. The entries above are fresh objects and snapDeep replaces references rather than
  // mutating in place, so this cannot reach back into the local timeline's geometry.
  return snapDeep({ version: TIMELINE_VERSION, generated: now,
                    retention_days: HISTORY_RETENTION_DAYS, entries: entries });
}

// ── Events scroller: one card per real event, not per changed feature ──────────────
// The published history is per-FEATURE, and one real event routinely spans several features.
// Two normal editor workflows produce that: redrawing a pocket as a fresh polygon instead of
// editing the existing one (three overlapping claims on one village → three "add" records),
// and replacing yesterday's shape by deleting it and drawing today's over the same ground
// (a "remove" plus an "add" on the same date). editor.html's diffState() cannot collapse
// either — it diffs state by feature id and has no way to know two ids are the same story.
// So the collapse happens here, at display time only: same date, overlapping ground, one
// card. The underlying entries are left untouched, because reconstructStateAsOf()'s replay
// needs every per-feature record to rebuild a past date correctly.
function changeGeom(c) { return c.geometry || c.base_geometry || null; }

// Same ground means each shape is mostly the other one — not merely that they touch, and not
// merely that one sits inside the other. Both failure modes are live here: neighbouring
// pockets along one front share a border, and a settlement-scale claim almost always sits
// wholly inside an oblast wash that was edited the same day. Measuring the overlap against
// the SMALLER shape would swallow every such claim into its oblast's card (measured: it ate
// four of nine cards on 2026-08-04, including a 6.9 km² settlement gain), so the denominator
// is the LARGER shape. A redraw of the same pocket clears that easily — the shapes are near
// duplicates; a 7 km² claim inside a 30,000 km² oblast cannot come close, which is the point.
var EVENT_MERGE_OVERLAP = 0.35;
function sameGround(a, b) {
  if (typeof turf === 'undefined') return false;
  var ga = changeGeom(a), gb = changeGeom(b);
  if (!ga || !gb) return false;
  try {
    var fa = { type: 'Feature', properties: {}, geometry: ga };
    var fb = { type: 'Feature', properties: {}, geometry: gb };
    var inter = turf.intersect(fa, fb);
    if (!inter) return false;
    var larger = Math.max(turf.area(fa), turf.area(fb));
    return larger > 0 && (turf.area(inter) / larger) >= EVENT_MERGE_OVERLAP;
  } catch (e) { return false; }
}

// Grouping keeps the transitive closure as it goes: a change that matches two existing groups
// merges them, so A–C and B–C never end up as two cards just because B was seen before C.
function groupSameDayChanges(changes) {
  var groups = [];
  changes.forEach(function (c) {
    var hits = [];
    groups.forEach(function (g, i) {
      if (g.some(function (m) { return sameGround(m, c); })) hits.push(i);
    });
    if (!hits.length) { groups.push([c]); return; }
    var target = groups[hits[0]];
    target.push(c);
    for (var k = hits.length - 1; k >= 1; k--) {
      target.push.apply(target, groups[hits[k]]);
      groups.splice(hits[k], 1);
    }
  });
  return groups;
}

// A day's `changes` array is append-ordered by mergeChange() in editor.html — a feature joins
// it the first time that day's save catches it — so later in the array means later in the day.
// The card should therefore speak for the last surviving shape: the newest name (the operator
// renaming a redraw is exactly how they correct a typo in the first attempt) and the faction
// still on the ground. A group that is nothing but removals has no survivor, so its last
// removal speaks for it.
function eventRepresentative(group) {
  for (var i = group.length - 1; i >= 0; i--) if (group[i].action !== 'remove') return group[i];
  return group[group.length - 1];
}

function unionAreaKm2(geoms) {
  if (typeof turf === 'undefined' || !geoms.length) return 0;
  try {
    var acc = { type: 'Feature', properties: {}, geometry: geoms[0] };
    for (var i = 1; i < geoms.length; i++) {
      var u = turf.union(acc, { type: 'Feature', properties: {}, geometry: geoms[i] });
      if (u) acc = u;
    }
    return turf.area(acc) / 1e6;
  } catch (e) { return 0; }
}

// Summing the members' area_delta_km2 would double-count exactly the overlap that put them in
// one group: three stacked ~1.5 km² redraws of one village would report ~4.6 km² taken. The
// group's real delta is the area its shapes cover now minus the area they covered before, so
// both sides are unioned first. An update whose geometry never moved carries no
// base_geometry — its current shape *is* its previous shape and belongs on both sides, or the
// unchanged ground reads as newly gained.
function groupDelta(group) {
  if (group.length === 1) return group[0].area_delta_km2 || 0;
  if (typeof turf === 'undefined') {
    return group.reduce(function (n, c) { return n + (c.area_delta_km2 || 0); }, 0);
  }
  var after = [], before = [];
  group.forEach(function (c) {
    if (c.geometry) after.push(c.geometry);
    if (c.base_geometry) before.push(c.base_geometry);
    else if (c.action === 'update' && c.geometry) before.push(c.geometry);
  });
  return unionAreaKm2(after) - unionAreaKm2(before);
}

// The citation the card prints (§3.4). The representative's own `info_source` first, then
// the newest one any member of the group carries — a redraw that cites its source is
// speaking for the whole event even when the last shape drawn did not repeat the link.
function eventSourceOf(group) {
  var rep = eventRepresentative(group);
  if (rep.info_source) return rep.info_source;
  for (var i = group.length - 1; i >= 0; i--) if (group[i].info_source) return group[i].info_source;
  return null;
}

var OPPOSING_FACTION = { ukraine: 'russia', russia: 'ukraine' };
// Which side the card credits, and whether it gets a counter at all.
// A contested pocket or an attack hatch is a claim about where fighting is happening, not a
// measured transfer of ground — putting km² on one implies a precision the shape does not
// have, and "contested gained 3 km²" names no side anyway. Those cards carry no counter.
// Everything else is a solid faction fill, where the counter always reads as a gain for
// somebody: a positive delta is ground that faction took, and with two sides on the map a
// negative delta is the same ground going to the other one. Returns null for "no counter".
// `livePatternOf` and `gainText` are the page's own: the editor reads the live pattern off
// regionsFC and words the counter in English, the viewer reads it off fillProps and words it
// through STRINGS. Everything above them is the same decision on both pages.
function eventGainLabel(rep, delta, livePatternOf, gainText) {
  var fid = rep.faction || rep.prev_faction;
  var pattern = rep.pattern || livePatternOf(rep.id);
  if (pattern === 'attack' || fid === 'contested' || fid === 'neutral' || !fid) return null;
  var v = Math.abs(delta);
  if (v < 0.05) return null;   // a rename, or a nudge a rounded "+0.0 km²" would misreport
  var side = delta >= 0 ? fid : OPPOSING_FACTION[fid];
  if (!side) return null;
  return { side: side, text: gainText(side, v) };
}

export {
  TIMELINE_VERSION, HISTORY_RETENTION_DAYS, EVENT_MERGE_OVERLAP, OPPOSING_FACTION,
  computeFrontlineHistory,
  changeGeom, sameGround, groupSameDayChanges, eventRepresentative, unionAreaKm2,
  groupDelta, eventGainLabel, eventSourceOf,
};
