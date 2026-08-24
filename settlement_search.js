/* ═══════════════════════════════════════════════════════════════════════════
   settlement_search.js — the settlement search field, shared by map.html and
   editor.html.

   One implementation, mounted twice. Both pages get the same field, the same
   dropdown and the same matching; only onPick differs (each page centres its
   own map). Written as a plain script that defines window.SettlementSearch —
   no build step, no module loader, matching how the rest of the project loads
   its libraries.

   ── What it searches ──────────────────────────────────────────────────────
   settlement_index.json, built by build_settlement_index.py: 29,798 places
   inside the pre-2014 oblast polygons and nothing outside them. Each row is
   an array, not an object, and carries its search keys pre-folded:

     [укр, рус, англ, старое_рус, lat, lon, ранг, область, "ключ ключ ключ"]

   ── How a query matches ───────────────────────────────────────────────────
   Both the query and the stored keys are pushed through fold(), which
   collapses the axes along which Ukrainian, Russian and English spellings of
   the same place disagree (и/і/ї/ы → i, г/ґ/х → h, zh/kh/shch digraphs,
   doubled letters). "Kiev", "Kyiv", "Киев" and "Київ" all fold to the same
   key, so old and new English spellings both land without either being
   stored twice.

   Folding alone is not enough: Південне/Южное and Підгірне/Подгорное are
   translations, not transliterations, and no amount of fuzz bridges them.
   That is why the index carries real name:ru from OSM (98% of rows) rather
   than transliterating Ukrainian and hoping.

   ⚠ fold() below MUST stay identical to fold() in build_settlement_index.py.
   The keys are computed there and the query is folded here; if the two drift
   apart the search silently stops finding things. Change both or neither.
   ═════════════════════════════════════════════════════════════════════════ */

window.SettlementSearch = (function () {
  'use strict';

  // ── Folding ───────────────────────────────────────────────────────────────
  var CYR_FOLD = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'h', 'д': 'd', 'е': 'e',
    'є': 'e', 'ё': 'e', 'ж': 'j', 'з': 'z', 'и': 'i', 'і': 'i', 'ї': 'i',
    'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p',
    'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c',
    'ч': 'c', 'ш': 's', 'щ': 's', 'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e',
    'ю': 'u', 'я': 'a'
  };
  // Order matters: shch before sch before sh, or the longer digraph never fires.
  var LAT_FOLD = [
    ['shch', 's'], ['sch', 's'], ['zh', 'j'], ['kh', 'h'], ['ch', 'c'],
    ['sh', 's'], ['ts', 'c'], ['ya', 'a'], ['ia', 'a'], ['ja', 'a'],
    ['yu', 'u'], ['iu', 'u'], ['ju', 'u'], ['ye', 'e'], ['ie', 'e'],
    ['je', 'e'], ['yi', 'i'], ['ii', 'i'], ['g', 'h'], ['w', 'v'],
    ['y', 'i'], ['x', 'ks']
  ];

  function fold(s) {
    s = (s || '').toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')      // combining marks left by NFKD
      .replace(/['\u2018\u2019\u02bc`]/g, '');  // apostrophe forms
    if (/[а-яёіїєґ]/.test(s)) {
      var out = '';
      for (var i = 0; i < s.length; i++) {
        var c = CYR_FOLD[s[i]];
        out += (c === undefined ? s[i] : c);
      }
      s = out;
    } else {
      for (var k = 0; k < LAT_FOLD.length; k++) {
        s = s.split(LAT_FOLD[k][0]).join(LAT_FOLD[k][1]);
      }
    }
    return s.replace(/[^a-z]/g, ' ').replace(/(.)\1+/g, '$1')
      .replace(/\s+/g, ' ').trim();
  }

  // Bounded Levenshtein: bails out as soon as every cell in a row exceeds max,
  // which is what keeps a full scan of 60,000 keys at ~20 ms instead of ~2 s.
  function levenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      var swap = prev; prev = cur; cur = swap;
    }
    return prev[b.length];
  }

  // ── The index ─────────────────────────────────────────────────────────────
  var UK = 0, RU = 1, EN = 2, OLD = 3, LAT = 4, LON = 5, RANK = 6, OBLAST = 7;

  var data = null;        // { oblasts: [...], rows: [...] }
  var keys = null;        // flat array of folded keys
  var owner = null;       // keys[i] belongs to rows[owner[i]]
  var loading = null;     // in-flight promise, so two mounts share one fetch

  function load(url) {
    if (loading) return loading;
    // Bump this whenever the row or oblast layout changes, so a browser cannot pair a
    // cached older index with newer code. v=2: oblasts became [uk, ru, en] triples.
    loading = fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=2')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        data = d;
        keys = [];
        owner = [];
        for (var i = 0; i < d.rows.length; i++) {
          var ks = d.rows[i][8].split(' ');
          for (var k = 0; k < ks.length; k++) {
            if (!ks[k]) continue;
            keys.push(ks[k]);
            owner.push(i);
          }
        }
        return d;
      })
      .catch(function (e) {
        loading = null;                 // let a later focus retry
        throw e;
      });
    return loading;
  }

  /* Score is "how far from what you typed", low is better:
       0  the whole name folds to exactly the query
       1  the name starts with the query   (so "Вугл" reaches Вугледар)
       3  the query appears inside the name
       4+ within edit distance 1–2, for typos and the uk/ru pairs that fold
          close but not equal
     Ties break on place rank, which is what puts the city Запоріжжя above the
     fifteen villages that share its name. */
  function query(q, limit) {
    if (!data) return [];
    var fq = fold(q);
    if (!fq) return [];
    var hits = {}, i, score, key;
    var fuzzy = fq.length >= 4;
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      score = -1;
      if (key === fq) score = 0;
      else if (key.lastIndexOf(fq, 0) === 0) score = 1;
      else if (key.indexOf(fq) > 0) score = 3;
      else if (fuzzy && Math.abs(key.length - fq.length) <= 2) {
        var d = levenshtein(fq, key, 2);
        if (d <= 2) score = 3 + d;
      }
      if (score < 0) continue;
      var o = owner[i];
      if (hits[o] === undefined || hits[o] > score) hits[o] = score;
    }
    var out = [];
    for (var o2 in hits) out.push([+o2, hits[o2]]);
    // Then place rank, then row order. build_settlement_index.py writes the file
    // sorted by (rank, -population), so the row index is a free population tiebreak
    // — it is what puts Бахмут above Кипуче when both are towns matched through the
    // same former name, without the index having to carry a population column.
    out.sort(function (a, b) {
      return (a[1] - b[1])
          || (data.rows[a[0]][RANK] - data.rows[b[0]][RANK])
          || (a[0] - b[0]);
    });
    return out.slice(0, limit || 8).map(function (h) {
      var r = data.rows[h[0]];
      return {
        uk: r[UK], ru: r[RU], en: r[EN], old: r[OLD],
        lat: r[LAT], lon: r[LON], rank: r[RANK],
        // Raw [uk, ru, en]; resolved against the interface language at render and at
        // pick time rather than here, so a language switch with the dropdown open
        // relabels the results that are already on screen.
        oblastForms: data.oblasts[r[OBLAST]],
        score: h[1],
        // Surfaced only when the query actually reached this row through the
        // former name — otherwise "Бахмут · formerly Артёмовск" would show on
        // every Bakhmut search, which is noise rather than an explanation.
        matchedOld: !!(r[OLD] && fold(r[OLD]).indexOf(fq) === 0 &&
                       fold(r[UK]).lastIndexOf(fq, 0) !== 0)
      };
    });
  }

  // ── Strings ───────────────────────────────────────────────────────────────
  // UI chrome only. Settlement names themselves are never translated here —
  // they are shown in whichever of name:uk / name:ru / name:en the index
  // carries, per docs/CONVENTIONS.md §6.
  var STRINGS = {
    en: {
      placeholder: 'Search settlements…',
      title: 'Find a settlement by name — Ukrainian, Russian or English, old or new spelling',
      loading: 'Loading settlements…',
      failed: 'Could not load the settlement index',
      empty: 'Nothing found',
      formerly: 'formerly',
      place: { 0: 'city', 1: 'town', 2: 'village', 3: 'hamlet' }
    },
    ru: {
      placeholder: 'Поиск населённых пунктов…',
      title: 'Найти населённый пункт по названию — по-украински, по-русски или по-английски, в старом или новом написании',
      loading: 'Загрузка списка…',
      failed: 'Не удалось загрузить индекс населённых пунктов',
      empty: 'Ничего не найдено',
      formerly: 'бывш.',
      place: { 0: 'город', 1: 'город', 2: 'село', 3: 'хутор' }
    }
  };

  function displayName(r, lang) {
    if (lang === 'ru') return r.ru || r.uk || r.en;
    if (lang === 'en') return r.en || r.uk || r.ru;
    return r.uk || r.ru || r.en;
  }
  /* The index carries each oblast as [uk, ru, en], straight out of oblasts.geojson,
     so the second line of a result follows the interface language rather than always
     reading Ukrainian. The English forms there are the OLD, Russian-derived
     transliterations — Lugansk, Kharkov, Kiev, Nikolaev — deliberately, so the dropdown
     agrees with map.html's stats panel and with the operator's own region names
     ("Ukraine-Kharkov"). See docs/CLAUDE.md. Do not "fix" them to Luhansk/Kharkiv.

     Tolerates a plain string too: an older index paired with this module by a browser
     cache would otherwise render "undefined" under every result. */
  function oblastName(entry, lang) {
    if (typeof entry === 'string') return entry;
    if (!entry) return '';
    var i = lang === 'ru' ? 1 : lang === 'en' ? 2 : 0;
    return entry[i] || entry[0] || '';
  }

  // Shown in full — "Kiev Oblast", "Киевская область", "Autonomous Republic of Crimea".
  // An earlier version trimmed the "oblast" word to save width, which read as a bare
  // repetition next to a same-named city ("Kiev · Kiev") and lost the only thing that
  // told the reader the second line was a region at all.
  function oblastLabel(entry, lang) {
    return (oblastName(entry, lang) || '').trim();
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // Injected once. Palette taken from the two toolbars so the field does not
  // read as a bolted-on control in either page.
  var CSS = [
    '.ss-wrap { position: relative; display: inline-flex; align-items: center; }',
    '.ss-input {',
    '  font: inherit; font-size: 12px; padding: 4px 8px 4px 24px; width: 190px;',
    '  border-radius: 6px; background: #242424; color: #ccc; border: 1px solid #383838;',
    '}',
    '.ss-input::placeholder { color: #777; }',
    '.ss-input:focus { outline: none; border-color: #2563eb; background: #2a2a2a; color: #fff; }',
    '.ss-icon {',
    '  position: absolute; left: 7px; font-size: 11px; color: #888;',
    '  pointer-events: none; line-height: 1;',
    '}',
    '.ss-drop {',
    '  position: absolute; top: calc(100% + 4px); left: 0; min-width: 260px; max-width: 340px;',
    '  background: #1b1b1b; border: 1px solid #3a3a3a; border-radius: 8px;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,.6); z-index: 2000; overflow: hidden;',
    '  max-height: 320px; overflow-y: auto; display: none;',
    '}',
    '.ss-drop.open { display: block; }',
    '.ss-item { padding: 6px 10px; cursor: pointer; border-bottom: 1px solid #262626; }',
    '.ss-item:last-child { border-bottom: none; }',
    '.ss-item:hover, .ss-item.sel { background: #23324e; }',
    '.ss-name { font-size: 12.5px; color: #eee; }',
    '.ss-meta { font-size: 10.5px; color: #8a8a8a; margin-top: 1px; }',
    '.ss-note { padding: 7px 10px; font-size: 11.5px; color: #888; }'
  ].join('\n');

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var el = document.createElement('style');
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* mount({ container, indexUrl, lang, onPick, debounceMs })

     container  element the field is appended to (both pages: their toolbar)
     indexUrl   defaults to 'settlement_index.json'
     lang       'en' | 'ru' — display language, changeable later via setLang()
     onPick     function(result) — the page centres its own map

     The index is fetched on FIRST FOCUS, not at page load. It is ~1 MB gzip
     against a live payload of ~176 KB, and most readers never search; paying
     for it on a deliberate click keeps the map's opening cost where it was.
     Returns { setLang, focus, el }. */
  function mount(opts) {
    injectStyles();
    var lang = opts.lang || 'en';
    var url = opts.indexUrl || 'settlement_index.json';
    var debounceMs = opts.debounceMs == null ? 120 : opts.debounceMs;

    var wrap = document.createElement('div');
    wrap.className = 'ss-wrap';
    var icon = document.createElement('span');
    icon.className = 'ss-icon';
    icon.textContent = '🔍';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'ss-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    var drop = document.createElement('div');
    drop.className = 'ss-drop';
    wrap.appendChild(icon);
    wrap.appendChild(input);
    wrap.appendChild(drop);
    opts.container.appendChild(wrap);

    var results = [], sel = -1, timer = null, state = 'idle';

    function T() { return STRINGS[lang] || STRINGS.en; }

    function applyLang() {
      input.placeholder = T().placeholder;
      input.title = T().title;
    }
    applyLang();

    function note(text) {
      drop.innerHTML = '<div class="ss-note">' + esc(text) + '</div>';
      drop.classList.add('open');
    }
    function close() { drop.classList.remove('open'); sel = -1; }

    function render() {
      if (!results.length) { note(T().empty); return; }
      var html = '';
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var meta = esc(oblastLabel(r.oblastForms, lang)) + ' · ' + T().place[r.rank];
        if (r.matchedOld) meta += ' · ' + T().formerly + ' ' + esc(r.old);
        html += '<div class="ss-item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">'
              + '<div class="ss-name">' + esc(displayName(r, lang)) + '</div>'
              + '<div class="ss-meta">' + meta + '</div></div>';
      }
      drop.innerHTML = html;
      drop.classList.add('open');
    }

    function run() {
      var q = input.value.trim();
      if (!q) { close(); return; }
      // Typing is a second trigger for the fetch, not just focus. Focus is the
      // normal one, but it is the kind of event that can be missed (a value
      // restored by the browser, a programmatic fill), and missing it would
      // otherwise leave the field saying "Loading…" forever with nothing in flight.
      ensureLoaded();
      if (state !== 'ready') { note(state === 'failed' ? T().failed : T().loading); return; }
      results = query(q, 8);
      sel = results.length ? 0 : -1;
      render();
    }

    function ensureLoaded() {
      if (state === 'ready' || state === 'loading') return;
      state = 'loading';
      load(url).then(function () {
        state = 'ready';
        if (input.value.trim()) run();
      }).catch(function () {
        state = 'failed';
        if (input.value.trim()) note(T().failed);
      });
    }

    function pick(i) {
      var r = results[i];
      if (!r) return;
      close();
      input.blur();
      // Resolved here so the page's own handler (a status line, a log) names the oblast
      // in the language the operator is reading, without needing to know the format.
      r.oblast = oblastName(r.oblastForms, lang);
      if (opts.onPick) opts.onPick(r);
    }

    input.addEventListener('focus', ensureLoaded);
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!results.length) return;
        e.preventDefault();
        sel += (e.key === 'ArrowDown' ? 1 : -1);
        if (sel < 0) sel = results.length - 1;
        if (sel >= results.length) sel = 0;
        render();
        var node = drop.querySelector('.ss-item.sel');
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (sel >= 0) { e.preventDefault(); pick(sel); }
      } else if (e.key === 'Escape') {
        close();
        input.blur();
      }
    });
    drop.addEventListener('mousedown', function (e) {
      // mousedown, not click: the input's blur would close the dropdown first.
      var item = e.target.closest ? e.target.closest('.ss-item') : null;
      if (!item) return;
      e.preventDefault();
      pick(+item.getAttribute('data-i'));
    });
    document.addEventListener('mousedown', function (e) {
      if (!wrap.contains(e.target)) close();
    });
    // Typing here must not reach the page's own key handling. editor.html's own
    // document handler already ignores events from an INPUT, but Geoman does not:
    // it draws with finishOnEnter, so pressing Enter to choose a result while the
    // Cut or Fill tool is armed would also close the polygon being drawn.
    ['keydown', 'keyup', 'keypress'].forEach(function (evt) {
      input.addEventListener(evt, function (e) { e.stopPropagation(); });
    });

    return {
      el: wrap,
      focus: function () { input.focus(); },
      setLang: function (l) { lang = l; applyLang(); if (drop.classList.contains('open')) render(); }
    };
  }

  // Zoom a picked result deserves: a city wants its whole area in view, a
  // hamlet wants the streets around it.
  function zoomFor(rank) { return rank === 0 ? 11 : rank === 1 ? 12 : 13; }

  return { mount: mount, query: query, load: load, fold: fold, zoomFor: zoomFor };
})();
