/* shared/snapshots.mjs — dated full-state snapshots, the calendar view's source of truth.

   WHY THIS EXISTS, when frontline_history.json already records every change.

   It records every change the operator MEANT as news, which is not the same set. When a
   pocket is drawn, editor.html auto-clips the neighbours it overlaps and then rebases that
   clip out of the diff base (rebaseClippedRegions(), and rebaseMeldedBase() for melds), so
   the clip never becomes an event card crediting the wrong side with the same km². That is
   the right call for the scroller and it is not negotiable — but it means the clipped
   neighbour's pre-clip shape is never written down, and a reverse replay has nothing to grow
   it back to. Reported 2026-09-01 as bare holes on any past date; measured at 165 km²
   uncovered reconstructing 2026-08-07 from the 2026-08-31 state.

   A delta log can be repaired — log the clip as a silent record — but the failure mode is
   what makes that unattractive as the ONLY answer: a missing record is invisible until
   someone opens a past date, which is how this went unnoticed for three weeks. A snapshot
   cannot drift, because it is not derived from anything. It is the state.

   So the calendar reads snapshots and the scroller reads the change log, each from the source
   that suits it: "what did the map look like" from a file that IS a map, "what happened and
   who did it" from a file that is a list of events. Neither is derived from the other and
   neither can silently rot into the other's job.

   THE FILES. One `history/<YYYY-MM-DD>.geojson` per day the operator published, byte-identical
   to the control_regions.geojson that day ended on — serializeRegions() output, so a snapshot
   is a file map.html can already render with no special case, and the builder is one that is
   already tested rather than a second answer to "what is the on-disk form". Plus
   `history/index.json`, which is the list of dates that exist.

   NO SNAPSHOT FOR EVERY DAY, AND NONE NEEDED. A day with no publish has the same state as the
   day before it, so the snapshot for any date is the newest one dated on or before it —
   snapshotForDate() below, and that lookup is exact, not an approximation, for every date at
   or after the first snapshot. This is also why the set is not padded out with copies: a
   quiet week costs one file, not seven.

   SIZE. ~583 KB raw / ~152 KB gzipped each, measured 2026-09-01, which is the same file the
   calendar already downloads today — so a reader browsing a past date pays what they already
   paid, and pays it for one date rather than for the whole reconstruction. The repo carries
   one per publish-day inside the retention window (14 in August 2026, ~2 MB gzipped) and
   prunes past it; git keeps the pruned blobs in history, which is where they belong.

   See geometry.mjs for the rules every module here follows. */

// The window snapshots are kept for. Deliberately the same constant as history.mjs's
// HISTORY_RETENTION_DAYS rather than a shared import: they answer to the same calendar and
// must move together, and a snapshot outliving the change log (or vice versa) is a date the
// reader can pick and get half an answer for. Checked by tests/artifacts.test.mjs.
var SNAPSHOT_RETENTION_DAYS = 90;
var SNAPSHOT_VERSION = 1;
var SNAPSHOT_DIR = 'history';

function snapshotPath(date) { return SNAPSHOT_DIR + '/' + date + '.geojson'; }
function snapshotIndexPath() { return SNAPSHOT_DIR + '/index.json'; }

// True for the exact `YYYY-MM-DD` the filenames use, and nothing else. The date is a PATH
// SEGMENT — it is concatenated into a URL the viewer fetches and into a git tree path the
// save writes — so it is validated at the boundary rather than trusted because it came from
// a file this project wrote. A `dates` array is the one part of the index a hand-edit or a
// half-written file can most easily corrupt.
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isSnapshotDate(d) { return typeof d === 'string' && DATE_RE.test(d); }

// The dates still inside the window, measured back from `now` (an ISO string) the same way
// computeFrontlineHistory() measures its own. Sorted ascending, deduped, junk dropped.
function snapshotDatesWithin(dates, now, retentionDays) {
  var days = retentionDays === undefined ? SNAPSHOT_RETENTION_DAYS : retentionDays;
  var cutoff = new Date(new Date(now).getTime() - days * 86400000);
  var seen = {}, out = [];
  (dates || []).forEach(function (d) {
    if (!isSnapshotDate(d) || seen[d]) return;
    if (new Date(d + 'T00:00:00Z') < cutoff) return;
    seen[d] = true; out.push(d);
  });
  out.sort();
  return out;
}

function buildSnapshotIndex(dates, now, retentionDays) {
  var days = retentionDays === undefined ? SNAPSHOT_RETENTION_DAYS : retentionDays;
  return { version: SNAPSHOT_VERSION, generated: now, retention_days: days,
           dates: snapshotDatesWithin(dates, now, days) };
}

// The lookup the calendar runs: the newest snapshot dated on or before `target`, or null when
// `target` predates every snapshot there is. Exact rather than nearest — a snapshot dated
// AFTER the target is a later state and would show ground taken since, which is the one thing
// the calendar must never do. Falling short is a state the map really was in; overshooting is
// not.
function snapshotForDate(dates, target) {
  if (!isSnapshotDate(target)) return null;
  var best = null;
  (dates || []).forEach(function (d) {
    if (!isSnapshotDate(d) || d > target) return;
    if (best === null || d > best) best = d;
  });
  return best;
}

export {
  SNAPSHOT_VERSION, SNAPSHOT_RETENTION_DAYS, SNAPSHOT_DIR,
  snapshotPath, snapshotIndexPath, isSnapshotDate,
  snapshotDatesWithin, buildSnapshotIndex, snapshotForDate,
};
