/* shared/regions.mjs — the draw-order sort and the on-disk form of
   control_regions.geojson, shared by the editor, the viewer and the publisher.

   The FeatureCollection arrives as an argument rather than being read off a `regionsFC`
   global: that is the only change either function needed to leave editor.html. See
   geometry.mjs for the rules every module here follows.

   Moved out of editor.html on 2026-08-30. */

import { snapDeep } from './geometry.mjs';

// Asserts the ordering invariants the shared canvas depends on, bottom of the stack to the
// top: every zone_type:"oblast" wash first, so a wash can never paint over a claim; then
// every solid hand-drawn region; then every attack hatch last of all, so a solid fill can
// never paint over a hatch. CONVENTIONS calls draw order the recurring failure mode and says
// to assert it rather than trust whatever produced the array — this is that assertion.
//
// The attack tier is not decoration either, it is the whole reason a hatch is visible. An
// attack hatch is the one thing clipUnderlyingRegions() exempts (see the comment there): it
// is a claim about where fighting is happening, drawn ON TOP of whoever holds the ground, so
// by design it always overlaps a solid fill and is never clipped out of the way. Draw order
// is therefore the only thing keeping it on screen, and nothing was maintaining it — a hatch
// drawn early keeps its array position while every fill drawn later pushes above it, and the
// hatch quietly disappears under the next region coloured over that ground. Measured on this
// file: the two hatches south into Днепропетровская область, at array positions 30 and 31,
// sat under "Russia-Dnepropetrovsk-1" at position 50, which covered 94.9% and 99.5% of them —
// the second showed only as a sliver where it hung outside the red fill.
//
// Stable, so relative order inside each tier is left exactly as the file had it; a file
// already in the right order comes out untouched. Run on load, from reorderRegionDraw() on
// every mutation, and again before serialising, so the file on disk (which map.html renders
// in array order, with no sort of its own) is correct for the viewer too.
function orderRegions(fc) {
  var oblasts = [], solid = [], attacks = [];
  fc.features.forEach(function (f) {
    var p = f.properties || {};
    if (p.zone_type === 'oblast') oblasts.push(f);        // base wash — bottom, whatever its pattern
    else if (p.pattern === 'attack') attacks.push(f);     // hatch — top, it is meant to sit over held ground
    else solid.push(f);
  });
  fc.features = oblasts.concat(solid, attacks);
}

// The backstop. Every producer above snaps its own output already, but this guarantees the
// file on disk never carries a millimetre run regardless of which path built the geometry —
// including migrated zones, imported regions and anything a future edit path forgets to snap.
function serializeRegions(fc) { orderRegions(fc); return JSON.stringify(snapDeep(fc)); }

export { orderRegions, serializeRegions };
