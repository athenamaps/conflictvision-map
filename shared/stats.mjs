/* shared/stats.mjs — territory_stats.json, shared by the editor and the publisher.

   The two FeatureCollections and the `generated` stamp arrive as arguments; nothing else
   about the computation moved. See geometry.mjs for the rules every module here follows.

   Moved out of editor.html on 2026-08-30 with no change to any body. */

import { nowIso, round3, geomAreaKm2 } from './geometry.mjs';

// ── Territory-held-per-side stats ───────────────────────────────────────────────
// Published as its own small file so the public map can show a "percent of controlled
// territories" widget without needing oblasts.geojson (never published — local-only,
// too large) or turf loaded client-side to redo this intersection on every viewer's
// machine. Only oblasts with SOME non-Ukrainian presence are included — an oblast that's
// entirely Ukrainian-held is skipped outright, per the operator's decision on this feature.
// Crimea is excluded by name on top of that, whatever its presence reads as — see
// STATS_EXCLUDED_OBLASTS below for why the presence test alone was not enough.
// Crimea is not in this table, and its absence is a decision rather than an oversight.
// It is not an oblast (an autonomous republic, and the only non-oblast in
// oblasts.geojson), and it is not what this widget measures: the panel reports ground
// changing hands along the front opened in 2022, and Crimea has been held in full since
// 2014 — which is also why no region shades it on the map at all. A row for it would be
// a fixed 100% that never moves, sitting above oblasts where the number means something.
// It is matched here on all three names rather than `name` alone because a row appearing
// after a transliteration drift is exactly the failure this would be silent about
// (CONVENTIONS §10 — properties are copied forward, never taken from OSM tags).
//
// This is a stats-only exclusion. Crimea MUST stay in oblasts.geojson: it is one of the
// five claimed regions regenerate_claimed_border.py unions (that script fails outright
// without it), and it is part of the all-oblasts union that defines Ukraine's national
// outline there — drop it from the file and the claimed border grows a spurious line
// across the Perekop isthmus.
var STATS_EXCLUDED_OBLASTS = [
  'Автономна Республіка Крим', 'Автономная Республика Крым', 'Autonomous Republic of Crimea',
];
function isStatsExcluded(props) {
  var p = props || {};
  return STATS_EXCLUDED_OBLASTS.indexOf(p.name) !== -1
      || STATS_EXCLUDED_OBLASTS.indexOf(p['name:ru']) !== -1
      || STATS_EXCLUDED_OBLASTS.indexOf(p['name:en']) !== -1;
}

// `opts.now` overrides the `generated` stamp, for the byte-for-byte test; the editor passes
// nothing and gets the same nowIso() this file has always carried.
function computeTerritoryStats(oblastsFC, regionsFC, opts) {
  if (!oblastsFC || typeof turf === 'undefined') return null;
  var now = (opts && opts.now) || nowIso();
  var contested = regionsFC.features.filter(function (f) {
    var fid = (f.properties || {}).faction;
    return f.geometry && (fid === 'russia' || fid === 'contested');
  });

  var oblasts = [];
  var totals = { russia_km2: 0, contested_km2: 0, ukraine_km2: 0, total_km2: 0 };

  oblastsFC.features.forEach(function (ob) {
    var name = (ob.properties || {}).name;
    if (!name || !ob.geometry) return;
    if (isStatsExcluded(ob.properties)) return;
    var totalKm2 = geomAreaKm2(ob.geometry);
    var russiaKm2 = 0, contestedKm2 = 0;
    contested.forEach(function (f) {
      var inter = null;
      try { inter = turf.intersect(ob, f); } catch (e) {}
      if (!inter) return;
      var a = geomAreaKm2(inter.geometry);
      if (f.properties.faction === 'russia') russiaKm2 += a; else contestedKm2 += a;
    });
    if (russiaKm2 <= 0 && contestedKm2 <= 0) return; // no non-Ukrainian presence — skip entirely
    var ukraineKm2 = Math.max(totalKm2 - russiaKm2 - contestedKm2, 0);
    oblasts.push({
      name: name, total_km2: round3(totalKm2), russia_km2: round3(russiaKm2),
      contested_km2: round3(contestedKm2), ukraine_km2: round3(ukraineKm2),
    });
    totals.total_km2 += totalKm2; totals.russia_km2 += russiaKm2;
    totals.contested_km2 += contestedKm2; totals.ukraine_km2 += ukraineKm2;
  });

  return {
    generated: now,
    oblasts: oblasts,
    totals: {
      total_km2: round3(totals.total_km2), russia_km2: round3(totals.russia_km2),
      contested_km2: round3(totals.contested_km2), ukraine_km2: round3(totals.ukraine_km2),
    },
  };
}

export { STATS_EXCLUDED_OBLASTS, isStatsExcluded, computeTerritoryStats };
