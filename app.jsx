// app.jsx — main app. Loads after routines.jsx, which provides the shared
// stroke-icon set and the recurring-rule engine on window.
const Icon = window.Icon;
const KIND_ICON = window.RoutinesAPI.KIND_ICON;
const entryKind = window.RoutinesAPI.entryKind;

// Normalize dose text from the Poolwerx PDF: consistent units ("mls" → "mL").
// Both rules are case-insensitive: the report is not consistent about unit case,
// and an uppercase "2.2 KG" used to pass through unnormalised.
function normalizeDose(s) {
  return (s || '')
    .replace(/\b(\d+(?:\.\d+)?)\s*mls?\b/gi, '$1 mL')
    .replace(/\b(\d+(?:\.\d+)?)\s*(kg|g|l)\b/gi, (m, n, u) => n + ' ' + (u.toLowerCase() === 'l' ? 'L' : u.toLowerCase()))
    .replace(/\s+/g, ' ')
    .trim();
}

// Numbers on the report carry thousands separators ("4,200 ppm"), which a
// [\d.]+ capture cannot represent — it used to read 4,200 as 200. Returns null
// rather than NaN for junk (a lone "."), so "didn't parse" stays distinguishable
// from "parsed as zero".
function parseReportNum(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, '').replace(/^\.+|\.+$/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Labels as they may appear in the results table, most specific first. The table
// abbreviates some of them ("Combined Cl") while the recommendations block spells
// them out, so each metric gets a list of spellings to try.
const METRIC_LABELS = {
  ph:     ['pH'],
  freeCl: ['Free Chlorine', 'Free Cl'],
  combCl: ['Combined Chlorine', 'Combined Cl'],
  salt:   ['Salt'],
  alk:    ['Total Alkalinity', 'Total Alk'],
  caHard: ['Calcium Hardness', 'Ca Hardness'],
  cya:    ['Cyanuric Acid', 'Cyanuric'],
  phos:   ['Phosphates', 'Phosphate'],
};

// The heading of a numbered recommendation ("3  CALCIUM HARDNESS"), mapped to
// the metric it is about. This used to be done by testing whether the heading
// contained a metric label's first word, which was wrong in both directions:
// "ph" is a substring of "phosphates", so a phosphate dose was explained as a
// pH problem — and demoted from HIGH to MED — whenever pH happened to be
// borderline too; and "total" in "TOTAL CHLORINE" matches the "Total Alk"
// metric. Order matters: the more specific patterns come first.
const PARAM_METRIC = [
  [/COMBINED\s*CHLORINE/i, 'ccl'],
  [/CHLORINE/i,            'fcl'],  // incl. "TOTAL CHLORINE" — advice there is to lower the chlorinator
  [/PHOSPHATE/i,           'phos'],
  [/CYANURIC|SUNBLOCK/i,   'cya'],
  [/ALKALIN|^TOT\b/i,      'alk'],  // the report abbreviates it "TOT. ALKALINITY (ADJUSTED)"
  [/HARDNESS|CALCIUM/i,    'cah'],
  [/SALT/i,                'salt'],
  [/^PH$/i,                'ph'],
];
function metricIdForParam(param) {
  const p = (param || '').trim();
  for (const [re, id] of PARAM_METRIC) if (re.test(p)) return id;
  return null;
}

// ─── PDF Parser (PDF.js) ────────────────────────
// Loads pdf.js from cdnjs on demand. The 20s cap matters: without it a stalled
// CDN request leaves the upload button stuck on "Parsing…" with no way out.
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    const timer = setTimeout(() => { s.onload = s.onerror = null; rej(new Error('pdfjs-timeout')); }, 20000);
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { clearTimeout(timer); res(); };
    s.onerror = () => { clearTimeout(timer); rej(new Error('pdfjs-unreachable')); };
    document.head.appendChild(s);
  }).then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  });
}

async function parsePoolwerxPDF(file) {
  await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let txt = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    txt += content.items.map(item => item.str).join(' ') + '\n';
  }
  // NOTE: never log `txt` — a Poolwerx report carries the customer's name and
  // street address, and this app runs on a shared family phone.

  // Metric values are only ever read from the text BEFORE "RECOMMENDATIONS".
  // That block numbers its sections ("1 PH", "2 COMBINED CHLORINE"), and a
  // case-insensitive whole-document search happily reads a section number as the
  // metric value — asking for "Combined Chlorine" against a table that
  // abbreviates it returned 2 ppm against a 0–0.2 target.
  const recsStart = /RECOMMENDATIONS?/i.exec(txt);
  const tableTxt = recsStart ? txt.slice(0, recsStart.index) : txt;

  // Poolwerx PDF table reading order is: CURRENT  PREVIOUS  LABEL  RANGE
  // e.g. "7.4  8.1  pH  7.2-7.6"  →  current = 7.4, previous = 8.1
  // We want the FIRST of the two numbers (the current measured value, shown
  // in the colored box on the report).
  //
  // There is deliberately no "number after the label" fallback any more. It
  // lacked the \b the other two branches have, so it matched a label as a prefix
  // ("Total Alk" inside "Total Alkalinity 80-120") and returned the target
  // range's low bound as the reading. A fabricated value that always looks
  // plausible is worse than null: null is reported to the user, 80 is not.
  const NUM = '([\\d,.]+)';
  const grabBefore = (key) => {
    for (const label of METRIC_LABELS[key]) {
      const mPair = tableTxt.match(new RegExp(NUM + '\\s+' + NUM + '\\s+' + label + '\\b', 'i'));
      const pair = mPair ? parseReportNum(mPair[1]) : null;
      if (pair != null) return pair;
      const mSingle = tableTxt.match(new RegExp(NUM + '\\s+' + label + '\\b', 'i'));
      const single = mSingle ? parseReportNum(mSingle[1]) : null;
      if (single != null) return single;
    }
    return null;
  };

  // Parse date
  const dateM = txt.match(/Tested\s+(\d{1,2}\s+\w+\s+\d{4})/i);
  const date = dateM ? dateM[1] : 'Unknown date';

  // Each metric value appears before its label in the Poolwerx PDF table
  const ph     = grabBefore('ph');
  const freeCl = grabBefore('freeCl');
  const combCl = grabBefore('combCl');
  const salt   = grabBefore('salt');
  const alk    = grabBefore('alk');
  const caHard = grabBefore('caHard');
  const cya    = grabBefore('cya');
  const phos   = grabBefore('phos');

  const lsiM = tableTxt.match(/(-?[\d.]+)\s*LANGELIER/i);
  const lsi  = lsiM ? (Number.isFinite(parseFloat(lsiM[1])) ? parseFloat(lsiM[1]) : null) : null;

  // Pool volume. The report prints it as "POOL   40,000   L", so \bpool\b is the
  // real anchor (\b matters — "Poolwerx" is in the letterhead twice). A bare
  // "digits then L" also matches the postcode in the customer's address
  // ("Brisbane QLD 4000 Lot 5" → "4000 L"), so the fallback insists on a
  // comma-grouped number — which then misses an uncommaed "8000 L" spa, hence
  // the anchor doing the real work.
  const poolM = txt.match(/(?:\bpool\b|volume|capacity|litres|liters)\D{0,20}(\d[\d,]*)\s*(?:L\b|litres|liters)/i)
             || txt.match(/(\d{1,3}(?:,\d{3})+)\s*L\b/);
  const pool  = poolM ? poolM[1] + ' L' : '';

  // Parse RECOMMENDATIONS — ONE action per numbered section.
  //
  // The report numbers its recommendations ("1  PH", "2  TOTAL CHLORINE") and
  // most, but not all, of them carry an "Add X of Y" dose. Scanning for doses
  // and attributing each to a heading therefore dropped every recommendation
  // that is a plain instruction — "TOTAL CHLORINE · Reduce your chlorinator
  // hours/level" appears on four of the six real reports, always while Free
  // Chlorine reads well over target, so the app showed the problem and no way
  // to act on it. Sections are extracted first now, and a dose is looked for
  // inside each one rather than the other way round.
  const recs = [];
  if (recsStart) {
    const after = txt.slice(recsStart.index + recsStart[0].length);
    // Terminators are matched case-SENSITIVELY: these are all-caps section
    // headings, and a lowercase "product" in ordinary prose used to truncate
    // the whole section. The disclaimer sentence ends the recommendations on
    // every report seen; without it, reports that carry no ADDITIONAL NOTES run
    // on into the footer and the shop's street address is scanned as a heading.
    const endM = /\bADDITIONAL\b|\bPRODUCT\b|The accuracy of this test/.exec(after);
    const recsText = endM ? after.slice(0, endM.index) : after;

    // A heading is a number, a gap, then all-caps words. In the real reports the
    // gap is always 2+ spaces, which is what keeps this away from dose text
    // ("Add 400 mls", "for 4-6 hours"). A single space is still accepted so a
    // reformatted report doesn't silently fall back to dose-only scanning, but
    // then the unit blocklist has to rule out "Add 20 ML of …" being read as
    // section 20 named "ML". Note \d{1,2} already excludes "500 ML": the digits
    // must be followed by the gap, and "500" cannot be.
    const UNIT_WORD = /^(?:ML|MLS|L|G|KG|MG|TAB|TABS)$/;
    // Names carry dots and brackets — "TOT. ALKALINITY (ADJUSTED)" — and the
    // (?![a-z]) guard ends the name at the first ordinary word, so the "A" of a
    // following "Add …" is not read as part of it.
    const HEAD_NAME = /^[A-Z][A-Z.()]*(?:\s+[A-Z(][A-Z.()]*(?![a-z]))*/;
    const heads = [];
    for (const m of recsText.matchAll(/(?:^|\s)(\d{1,2})(\s+)(?=[A-Z]{2})/g)) {
      const at = m.index + m[0].length;
      const nm = HEAD_NAME.exec(recsText.slice(at));
      if (!nm || !nm[0]) continue;
      const name = nm[0].trim();
      if (m[2].length < 2 && UNIT_WORD.test(name.split(/\s+/)[0])) continue;
      heads.push({ at: m.index, from: at + nm[0].length, name });
    }

    // In the PDF the dose sits on its own line, so pdf.js separates it from the
    // explanation that follows with a run of two or more spaces. Stopping there
    // is both simpler and more accurate than the old character budget, which
    // ran into the explanation and truncated it mid-word ("…Vitalyse Shock N Swi").
    const UNIT = '(?:mls?|millilitres?|milliliters?|g|grams?|kg|kilograms?|L|litres?|liters?|tabs?|tablets?)';
    const DOSE = 'Add\\s+[\\d,.]+\\s*' + UNIT + '\\b(?:(?! {2})[^.\\n]){0,80}';
    const doseRe = new RegExp(DOSE, 'i');

    const tidy = (s) => s.replace(/\s+/g, ' ').replace(/[\s,;:.]+$/, '').trim();

    for (let i = 0; i < heads.length; i++) {
      const body = recsText.slice(heads[i].from, i + 1 < heads.length ? heads[i + 1].at : recsText.length);
      const dose = doseRe.exec(body);
      let action;
      if (dose) {
        // On the real two-space format the run above already stops at the end
        // of the dose line; this trim is the safety net for a single-spaced
        // report, where it runs on into the instructions that follow.
        action = tidy(dose[0].replace(/\s+(?:Dissolve|Filter|Clean|Backwash|Increase|Reduce|Retest|Turn off|A shock dose|away|in a bucket|Add\b)[\s\S]*/i, ''));
      } else {
        // No dose: the recommendation is an instruction. Its first sentence is
        // the actionable part ("Reduce your chlorinator hours/level"); the rest
        // is elaboration.
        const prose = body.replace(/\s+/g, ' ').trim();
        const first = prose.match(/^[^.]*\./);
        action = tidy(first ? first[0] : prose);
        if (action.length > 90) action = action.slice(0, 90).replace(/\s+\S*$/, '') + '…';
      }
      if (action) recs.push({ action, param: heads[i].name });
    }

    // Safety net for a report that doesn't number its recommendations: fall
    // back to scanning the whole block for doses.
    if (!heads.length) {
      for (const m of recsText.matchAll(new RegExp(DOSE, 'gi'))) {
        const action = tidy(m[0]);
        if (action) recs.push({ action, param: '' });
      }
    }
  }

  const metricsParsed = [ph, freeCl, combCl, salt, alk, caHard, cya, phos]
    .filter(v => v != null).length;

  return { date, pool, lsi, ph, freeCl, combCl, salt, alk, caHard, cya, phos, recs, metricsParsed, metricsTotal: 8 };
}

// Status helper. 'warn' means "inside the target band but close to an edge" —
// but only for an edge that represents a real limit. Combined Chlorine and
// Phosphates both target 0–0.2, where 0 is the IDEAL reading rather than a near
// miss; warning on it made every clean report show phantom issues and a red
// "2 issues" pill on a pool where nothing was wrong. An edge that coincides with
// the metric's own floor/ceiling is therefore not treated as a boundary to
// approach.
function calcStatus(val, lo, hi, min, max) {
  if (val === null || val === undefined) return 'ok';
  if (val < lo || val > hi) return 'bad';
  const margin = (hi - lo) * 0.05;
  if (val < lo + margin && !(min != null && lo <= min)) return 'warn';
  if (val > hi - margin && !(max != null && hi >= max)) return 'warn';
  return 'ok';
}

// ─── Data ───────────────────────────────────────
// Metric definitions (ranges only — values populated after upload)
const METRIC_DEFS = [
  { id: 'ph',   label: 'pH',            lo: 7.2, hi: 7.6, unit: '',    min: 6.5, max: 9.0  },
  { id: 'fcl',  label: 'Free Chlorine', lo: 2,   hi: 4,   unit: 'ppm', min: 0,   max: 6    },
  { id: 'ccl',  label: 'Combined Cl',   lo: 0,   hi: 0.2, unit: 'ppm', min: 0,   max: 1    },
  { id: 'salt', label: 'Salt',          lo: 3500,hi: 5000,unit: 'ppm', min: 0,   max: 6000 },
  { id: 'alk',  label: 'Total Alk',     lo: 80,  hi: 120, unit: 'ppm', min: 0,   max: 200  },
  { id: 'cah',  label: 'Ca Hardness',   lo: 200, hi: 400, unit: 'ppm', min: 0,   max: 500  },
  { id: 'cya',  label: 'Cyanuric Acid', lo: 30,  hi: 100, unit: 'ppm', min: 0,   max: 150  },
  { id: 'phos', label: 'Phosphates',    lo: 0,   hi: 0.2, unit: 'ppm', min: 0,   max: 0.5  },
];

// Text equivalent for the status colour, used in accessible names so the
// pass/warn/fail signal isn't carried by hue alone.
const STATUS_WORD = { ok: 'in range', warn: 'borderline', bad: 'out of range' };

const EMPTY_TEST = {
  date: null,
  pool: '',
  lsi: null,
  metrics: METRIC_DEFS.map(m => ({ ...m, val: null, status: 'ok' })),
};

const TEST = EMPTY_TEST;
const TODOS = [];

const PH_HISTORY = [];

// ─── Trend Chart ────────────────────────────────
function TrendChart({ data, lo, hi, phMin = 7.0, phMax = 8.5, unit = '', label = 'pH' }) {
  data = (data || []).filter(d => d && typeof d.val === 'number' && Number.isFinite(d.val));
  if (data.length < 2) {
    return (
      <div style={{ height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>
        Need at least 2 tests to show a trend
      </div>
    );
  }
  // Normalize: ensure lo <= hi
  if (lo > hi) { const t = lo; lo = hi; hi = t; }

  // The visible domain used to be hardcoded to 7.0–8.5, so a reading outside it
  // (a pH of 6.8, or any of the other metrics) was plotted above or below the
  // card with no indication it had gone off-scale. Widen the domain to cover the
  // data and the target band, with a little headroom.
  const vals = data.map(d => d.val);
  const dataMin = Math.min(...vals, lo, phMin);
  const dataMax = Math.max(...vals, hi, phMax);
  const span = dataMax - dataMin || 1;
  phMin = dataMin - span * 0.08;
  phMax = dataMax + span * 0.08;

  const W = 295, H = 90;
  const pad = { l: 28, r: 8, t: 10, b: 20 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  const px = (i) => pad.l + (i / (data.length - 1)) * cW;
  const py = (v) => pad.t + cH - ((v - phMin) / (phMax - phMin)) * cH;

  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${px(i)} ${py(d.val)}`).join(' ');
  const areaD = `${pathD} L ${px(data.length - 1)} ${pad.t + cH} L ${px(0)} ${pad.t + cH} Z`;

  const loY = py(lo), hiY = py(hi);
  // hi value is higher on the number line → smaller y; band top = hiY, height = loY - hiY
  const bandTop = Math.min(loY, hiY);
  const bandH   = Math.abs(loY - hiY);

  // Tick labels at quartiles of [phMin, phMax]
  const ticks = [phMin, phMin + (phMax - phMin) * 0.33, phMin + (phMax - phMin) * 0.66, phMax];

  const last = data[data.length - 1];
  const first = data[0];
  const dir = last.val > first.val ? 'rising' : last.val < first.val ? 'falling' : 'flat';
  const summary = label + ' over the last ' + data.length + ' tests, ' + dir + ' from ' +
    first.val + unit + ' in ' + first.label + ' to ' + last.val + unit + ' in ' + last.label +
    '. Target range ' + lo + ' to ' + hi + unit + '. ' +
    data.filter(d => d.val < lo || d.val > hi).length + ' of ' + data.length + ' outside target.';

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}
      role="img" aria-label={summary}>
      {/* Target band */}
      <rect x={pad.l} y={bandTop} width={cW} height={bandH} fill="#087299" opacity={0.08} rx={2} />
      <line x1={pad.l} y1={loY} x2={pad.l + cW} y2={loY} stroke="#087299" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
      <line x1={pad.l} y1={hiY} x2={pad.l + cW} y2={hiY} stroke="#087299" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />

      {/* Area fill */}
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0c1a22" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#0c1a22" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#areaGrad)" />

      {/* Line */}
      <path d={pathD} fill="none" stroke="#0c1a22" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />

      {/* Points */}
      {data.map((d, i) => (
        <circle key={i} cx={px(i)} cy={py(d.val)} r={i === data.length - 1 ? 4.5 : 3}
          style={{ fill: d.val >= lo && d.val <= hi ? 'var(--ok)' : 'var(--bad)' }}
          stroke="#fff" strokeWidth={1.5} />
      ))}

      {/* X labels — were #8ea1a9 (2.69:1) and #bccad0 (1.68:1) on white, i.e.
          effectively invisible. Both now use the text tokens, which pass AA. */}
      {data.map((d, i) => (
        <text key={i} x={px(i)} y={H - 2} textAnchor="middle"
          style={{ fontSize: 9, fontFamily: 'Geist Mono, ui-monospace, monospace', fill: 'var(--muted)', fontWeight: 500, letterSpacing: '0.02em' }}>
          {d.label}
        </text>
      ))}

      {/* Y labels */}
      {ticks.map((v, i) => (
        <text key={i} x={pad.l - 4} y={py(v) + 3} textAnchor="end"
          style={{ fontSize: 8.5, fontFamily: 'Geist Mono, ui-monospace, monospace', fill: 'var(--faint)' }}>
          {v.toFixed(1)}
        </text>
      ))}

      {/* No in-chart "target" caption: it was anchored to the right edge of the
          band, which is exactly where the latest reading is plotted, so with a
          full six-test history the word sat underneath the last point. The card
          header already states "Target lo–hi" and the band is drawn, so the
          caption was duplicating information as well as colliding. */}
    </svg>
  );
}

// ─── Single todo card (own component so hooks are top-level) ───
function TodoCard({ t, idx, onToggle, onDelete }) {
  const [swipeX, setSwipeX] = React.useState(0);
  const [swiping, setSwiping] = React.useState(false);
  const touchStart = React.useRef(null);
  const axis = React.useRef(null); // 'x' | 'y' — locked on first decisive move
  const THRESHOLD = 60;

  // The swipe used to react to any horizontal delta, so cards slid sideways
  // during ordinary vertical scrolling. Lock to an axis on the first move that
  // is clearly one or the other, and ignore the gesture entirely once it's
  // vertical. Swiping back to the right now also closes an open card.
  const onTouchStart = (e) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, from: swipeX };
    axis.current = null;
    setSwiping(false);
  };
  const onTouchMove = (e) => {
    if (!touchStart.current) return;
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    if (!axis.current) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis.current !== 'x') return;
    setSwiping(true);
    setSwipeX(Math.min(0, Math.max(-80, touchStart.current.from + dx)));
  };
  const onTouchEnd = () => {
    if (axis.current === 'x') setSwipeX(swipeX < -THRESHOLD ? -80 : 0);
    setSwiping(false);
    touchStart.current = null;
    axis.current = null;
  };
  const open = swipeX < -10;
  const checkLabel = (t.done ? 'Done: ' : 'Mark done: ') + t.label;

  return (
    <div className="todo-wrap" style={{ marginBottom: 0 }}>
      {!t.isRoutine && (
        <button type="button" className="todo-delete-bg" tabIndex={-1} aria-hidden="true"
          onClick={() => onDelete(t.id)}>✕</button>
      )}
      {/* The card keeps its tap-anywhere behaviour for touch, but the actionable
          controls are now real buttons: the whole card used to be a bare onClick
          div, so ticking an action off was impossible without a mouse or a
          touchscreen and the list was invisible to the accessibility tree. */}
      <div className={`todo-card fade-up${t.done ? ' done' : ''}`}
        style={{ animationDelay: `${idx * 0.05}s`, transform: `translateX(${swipeX}px)`, transition: swiping ? 'none' : 'transform 0.25s ease' }}
        onClick={(e) => {
          if (open) { setSwipeX(0); return; }
          // Ignore clicks that a nested button already handled.
          if (e.target.closest && e.target.closest('button')) return;
          onToggle(t.id);
        }}
        onTouchStart={t.isRoutine ? undefined : onTouchStart}
        onTouchMove={t.isRoutine ? undefined : onTouchMove}
        onTouchEnd={t.isRoutine ? undefined : onTouchEnd}>
        <div className="todo-accent" style={{ background: t.color }} />
        <button type="button" className={`todo-check${t.done ? ' checked' : ''}`}
          role="checkbox" aria-checked={!!t.done} aria-label={checkLabel}
          onClick={(e) => { e.stopPropagation(); if (open) { setSwipeX(0); return; } onToggle(t.id); }}>
          <span aria-hidden="true">{t.done ? '✓' : ''}</span>
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontFamily: 'Geist Mono, ui-monospace, monospace', color: t.color, fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t.pri}</div>
          </div>
          <div className="t-title" style={{ fontSize: 14.5, color: 'var(--ink)', lineHeight: 1.35 }}>{t.label}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>{t.reason}</div>
        </div>
        {!t.isRoutine && (
          <button type="button" className="todo-del-btn"
            onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
            aria-label={'Delete action: ' + t.label}>×</button>
        )}
      </div>
    </div>
  );
}

// ─── Dashboard Screen ────────────────────────────
function Dashboard({ onNav, todos, onToggle, onDelete, toast, testData, onUpload, uploading, phHistory, routines, logEntries, onRoutineDone }) {
  testData = testData || TEST;
  const hasTest = !!testData.date;
  // Looked up by id, not by array position. Persisted or imported test data can
  // carry a metrics array of a different length or order, and metrics[0]/[1]/[3]
  // then reads the wrong metric or throws on undefined.
  const metric = (id) => (testData.metrics || []).find(m => m.id === id) ||
    METRIC_DEFS.find(m => m.id === id) || { val: null, status: 'ok', lo: 0, hi: 0, label: id };
  const ph = metric('ph');
  const badCount = (testData.metrics || []).filter(m => m.status !== 'ok').length;
  const shortVal = (m) => (m.val == null ? '—' : (m.status === 'ok' ? 'OK' : m.val));

  // Compute routine todos (overdue + due) and upcoming list
  const RAPI = window.RoutinesAPI;
  const now = Date.now();
  const ruleStates = (routines || []).map(r => ({ r, s: RAPI ? RAPI.ruleStatus(r, logEntries || [], now) : null })).filter(x => x.s);
  const routineTodos = ruleStates
    .filter(({ s }) => s.status === 'overdue' || s.status === 'due')
    .sort((a, b) => b.s.daysOver - a.s.daysOver)
    .map(({ r, s }) => RAPI.routineToTodo(r, s));

  // Combine: overdue routines first, then PDF todos, then due routines.
  const overdueRoutines = routineTodos.filter(t => /OVERDUE/.test(t.pri));
  const dueRoutines     = routineTodos.filter(t => !/OVERDUE/.test(t.pri));
  const mergedTodos = [...overdueRoutines, ...todos, ...dueRoutines];

  const doneCount = mergedTodos.filter(t => t.done).length;
  const openCount = mergedTodos.filter(t => !t.done).length;
  const pillCls = (status) => status === 'ok' ? 'pill-ok' : status === 'warn' ? 'pill-warn' : 'pill-bad';

  // For toggling a merged item — routes to routine-done or pdf-toggle
  const handleToggle = (item) => {
    if (item.isRoutine) onRoutineDone(item.routineId);
    else onToggle(item.id);
  };
  const handleDelete = (item) => {
    if (item.isRoutine) { /* routines aren't dismissible from dashboard — manage on Routines tab */ }
    else onDelete(item.id);
  };

  return (
    <div className="screen">
      {/* Hero */}
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="t-label" style={{ color: 'var(--hero-dim)', marginBottom: 8 }}>{hasTest ? 'Last tested · ' + testData.date : 'No test data yet'}</div>
              <div className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 26, lineHeight: 1.15 }}>
                {hasTest ? (openCount === 0 ? 'All caught up.' : (openCount === 1 ? '1 thing needs attention.' : openCount + ' things need attention.')) : 'Upload a report to get started.'}
              </div>
            </div>
            {hasTest && (
              <button className="chip-btn" onClick={onUpload} disabled={uploading}
                aria-label="Upload a new Poolwerx test PDF"
                style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: uploading ? 0.6 : 1 }}>
                <Icon name="upload" size={12} /> {uploading ? 'Parsing…' : 'New test'}
              </button>
            )}
          </div>
          {hasTest && (
            <div style={{ display: 'flex', gap: 18, color: 'var(--hero-dim)', fontSize: 12, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
              {testData.lsi != null && <span><span style={{ color: 'var(--hero-dim-2)' }}>LSI </span>{testData.lsi}</span>}
              <span><span style={{ color: 'var(--hero-dim-2)' }}>Salt </span>{shortVal(metric('salt'))}</span>
              <span><span style={{ color: 'var(--hero-dim-2)' }}>Chlorine </span>{shortVal(metric('fcl'))}</span>
            </div>
          )}

          {/* Upload zone — full size only before the first test is loaded */}
          {!hasTest &&
          <button type="button" className="upload-zone" style={{ marginTop: 18, opacity: uploading ? 0.6 : 1 }}
            disabled={uploading} onClick={onUpload}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="15" height="17" viewBox="0 0 15 17" fill="none" aria-hidden="true"><path d="M2 1h7l4 4v10a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="rgba(234,246,251,0.7)" strokeWidth="1.2"/><path d="M9 1v4h4" stroke="rgba(234,246,251,0.7)" strokeWidth="1.2"/></svg>
            </div>
            <div style={{ minWidth: 0, textAlign: 'left' }}>
              <div style={{ color: 'var(--hero-fg)', fontFamily: 'Geist', fontWeight: 500, fontSize: 13.5, letterSpacing: '-0.005em' }}>{uploading ? 'Parsing PDF…' : 'Upload Poolwerx Report'}</div>
              <div style={{ color: 'var(--hero-dim)', fontSize: 11.5, marginTop: 2 }}>{uploading ? 'Please wait' : 'Tap to import latest test results'}</div>
            </div>
            <div aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--hero-dim-2)', fontSize: 18, lineHeight: 1 }}>→</div>
          </button>
          }
        </div>
      </div>

      {/* Pills — real buttons, and the status is in the accessible name. The
          coloured ::before dot is 6px and is the only visual carrier of
          pass/warn/fail, which is invisible to a screen reader and marginal for
          anyone who can't separate the hues. */}
      <div className="pills-row">
        {hasTest ? [
          { label: 'pH ' + (metric('ph').val == null ? '—' : metric('ph').val), status: metric('ph').status, name: 'pH' },
          { label: 'Cl ' + (metric('fcl').val == null ? '—' : metric('fcl').val), status: metric('fcl').status, name: 'Free chlorine' },
          { label: 'Salt ' + shortVal(metric('salt')), status: metric('salt').status, name: 'Salt' },
          { label: badCount + ' issue' + (badCount !== 1 ? 's' : ''), status: badCount > 0 ? 'bad' : 'ok',
            aria: badCount === 0 ? 'No metrics outside target. View all metrics'
              : badCount + ' metric' + (badCount !== 1 ? 's' : '') + ' outside target. View all metrics' },
        ].map((p, i) => (
          <button type="button" key={i} className={`pill ${pillCls(p.status)} t-num`}
            aria-label={p.aria || (p.name + ' ' + p.label.split(' ').slice(1).join(' ') + ' — ' + STATUS_WORD[p.status] + '. View all metrics')}
            onClick={() => onNav('chemistry')}>{p.label}</button>
        )) : <div style={{ color: 'var(--muted)', fontSize: 12, padding: '4px 4px' }}>Results will appear here after upload</div>}
      </div>

      {/* pH Trend */}
      <div className="sec-head">
        <span>pH Trend · 6 months</span>
        {hasTest && <button type="button" className="link-btn" onClick={() => onNav('chemistry')}>All metrics →</button>}
      </div>
      {hasTest ? (
      <div className="chart-card fade-up">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 14 }}>
          <div>
            <div className="t-label" style={{ marginBottom: 4 }}>Current pH</div>
            <div className="t-display t-num" style={{ fontSize: 34, color: 'var(--ink)', lineHeight: 1 }}>{ph.val == null ? '—' : ph.val}</div>
          </div>
          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            {ph.val == null
              ? <span className="badge badge-warn">Not in this report</span>
              : <span className={`badge ${ph.status === 'ok' ? 'badge-ok' : ph.status === 'warn' ? 'badge-warn' : 'badge-bad'}`}>{ph.status === 'ok' ? 'In range' : ph.status === 'warn' ? 'Borderline' : 'Out of range'}</span>}
            <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>Target <span className="t-num">{ph.lo}–{ph.hi}</span></div>
          </div>
        </div>
        <TrendChart data={phHistory || []} lo={ph.lo} hi={ph.hi} label="pH" />
      </div>
      ) : (
        <div className="chart-card" style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--muted)' }}>
          <div style={{ fontSize: 13 }}>pH trend will appear after your first upload</div>
        </div>
      )}

      {/* To-do */}
      <div className="sec-head">
        <span>Action list</span>
        <span style={{ color: 'var(--muted)', fontSize: 11.5, fontWeight: 400, fontFamily: 'Geist', textTransform: 'none', letterSpacing: '-0.005em' }} className="t-num">{(hasTest || mergedTodos.length) ? (openCount + ' open') : ''}</span>
      </div>
      {window.UpcomingChips && <window.UpcomingChips rules={routines || []} entries={logEntries || []} onNav={() => onNav('routines')} />}
      <div className="todo-list" style={{ paddingBottom: 100, marginTop: 8 }}>
        {!hasTest && mergedTodos.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' }}>
            <div style={{ width: 44, height: 44, margin: '0 auto 14px', borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="18" height="20" viewBox="0 0 15 17" fill="none"><path d="M2 1h7l4 4v10a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="var(--muted)" strokeWidth="1.2"/><path d="M9 1v4h4" stroke="var(--muted)" strokeWidth="1.2"/></svg>
            </div>
            <div className="t-title" style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 4 }}>No actions yet</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 240, margin: '0 auto', lineHeight: 1.5 }}>Upload your Poolwerx PDF above and your action list will populate automatically.</div>
          </div>
        )}
        {mergedTodos.map((t, i) => (
          <TodoCard key={t.id} t={t} idx={i}
            onToggle={() => handleToggle(t)}
            onDelete={() => handleDelete(t)} />
        ))}
        {hasTest && mergedTodos.length > 0 && openCount === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ width: 44, height: 44, margin: '0 auto 12px', borderRadius: '50%', background: 'var(--ok-tint)', color: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>✓</div>
            <div className="t-title" style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 4 }}>All actions done</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Great work — pool's looking sharp.</div>
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Chemistry Screen ────────────────────────────
function Chemistry({ onNav, testData, onReupload }) {
  testData = testData || TEST;
  const hasTest = !!testData.date;
  const pct = (v, mn, mx) => Math.max(0, Math.min(1, (v - mn) / (mx - mn)));
  const colors = { ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)' };
  const bgColors = { ok: 'var(--ok-tint)', bad: 'var(--bad-tint)', warn: 'var(--warn-tint)' };
  // A metric with no value wasn't read from this report — it is neither in range
  // nor out of it, and counting it either way misrepresents the test.
  const shown = testData.metrics || [];
  const offCount = shown.filter(m => m.val != null && m.status !== 'ok').length;
  const missingCount = shown.filter(m => m.val == null).length;

  return (
    <div className="screen">
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div className="t-label" style={{ color: 'var(--hero-dim)' }}>Water Chemistry</div>
            {hasTest && (
              <button onClick={onReupload} className="chip-btn" aria-label="Upload a new Poolwerx test PDF"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="upload" size={12} /> New test
              </button>
            )}
          </div>
          <div className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 22, lineHeight: 1.2 }}>{hasTest ? 'Test · ' + testData.date : 'Water Chemistry'}</div>
          {hasTest && testData.pool && <div style={{ color: 'var(--hero-dim)', fontSize: 12, marginTop: 4 }}>{testData.pool}</div>}
          {hasTest && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {testData.lsi != null && <div style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 999, padding: '4px 11px', color: 'rgba(234,246,251,0.85)', fontSize: 12, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>LSI {testData.lsi}</div>}
            {offCount > 0 && <div style={{ background: 'rgba(198,36,54,0.22)', border: '1px solid rgba(198,36,54,0.45)', borderRadius: 999, padding: '4px 11px', color: '#ffc4c4', fontSize: 12, fontWeight: 400 }}>{offCount} need{offCount === 1 ? 's' : ''} attention</div>}
            {missingCount > 0 && <div style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 999, padding: '4px 11px', color: 'rgba(234,246,251,0.85)', fontSize: 12, fontWeight: 400 }}>{missingCount} not in this report</div>}
          </div>
          )}
        </div>
      </div>

      {!hasTest ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
          <div className="t-title" style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 6 }}>No test data yet</div>
          <div style={{ fontSize: 12.5 }}>Upload a Poolwerx PDF from the Dashboard to see your water chemistry.</div>
        </div>
      ) : (
      <div style={{ paddingTop: 16, paddingBottom: 100 }}>
        {testData.metrics.map((m, i) => {
          const loPct = pct(m.lo, m.min, m.max) * 100;
          const hiPct = pct(m.hi, m.min, m.max) * 100;
          const valPct = m.val != null ? pct(m.val, m.min, m.max) * 100 : null;
          const col = colors[m.status];
          const badgeCls = m.status === 'ok' ? 'badge-ok' : m.status === 'warn' ? 'badge-warn' : 'badge-bad';

          return (
            <div key={m.id} className="metric-card fade-up" style={{ animationDelay: `${i * 0.04}s` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div className="t-label" style={{ marginBottom: 4 }}>{m.label}</div>
                  <div className="t-display t-num" style={{ fontSize: 28, color: 'var(--ink)', lineHeight: 1 }}>
                    {m.val != null ? m.val : '—'}<span style={{ fontSize: 13, fontWeight: 400, marginLeft: 4, color: 'var(--muted)' }}>{m.val != null ? m.unit : ''}</span>
                  </div>
                </div>
                {m.val == null
                  ? <span className="badge badge-warn">Not in this report</span>
                  : <span className={`badge ${badgeCls}`}>{m.status === 'ok' ? 'In range' : m.status === 'warn' ? 'Borderline' : 'Out of range'}</span>}
              </div>
              <div className="range-track">
                <div className="range-zone" style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }} />
                {valPct != null && <div className="range-marker" style={{ left: `${valPct}%`, background: col }} />}
              </div>
              <div className="t-num" style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)', fontSize: 11, fontWeight: 400, fontFamily: 'Geist Mono, ui-monospace, monospace' }}>
                <span>{m.min}</span>
                <span style={{ color: 'var(--muted)' }}>target {m.lo}–{m.hi}</span>
                <span>{m.max}</span>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

// ─── Log Screen ──────────────────────────────────
function Log({ onNav, todos, onToggle, testData, onLogEntry }) {
  testData = testData || TEST;
  const [chemical, setChemical] = React.useState('Hydrochloric Acid');
  const [amount, setAmount] = React.useState('500');
  const [unit, setUnit] = React.useState('mL');
  const [notes, setNotes] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [logType, setLogType] = React.useState('chemical'); // chemical | backwash | aiper (pool cleaner) | watertest | note
  const [errMsg, setErrMsg] = React.useState('');
  const errRef = React.useRef(null);

  const chemicals = ['Hydrochloric Acid', 'Non Chlorine Shock', 'Calcium Up', 'Sunblock', 'Algaecide', 'Clarifier', 'Chlorine', 'Other'];
  const units = ['mL', 'L', 'g', 'kg', 'tabs'];
  const pending = todos.filter(t => !t.done);

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const localISO = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const [datetime, setDatetime] = React.useState(localISO);
  const fmtDatetime = (iso) => {
    try { return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); }
    catch(e) { return iso; }
  };

  // Validation errors were rendered silently — no announcement and no focus
  // move, so on a screen reader nothing happened when Save did nothing.
  const failWith = (msg) => {
    setErrMsg(msg);
    setTimeout(() => errRef.current && errRef.current.focus(), 0);
  };

  const handleSave = () => {
    setErrMsg('');
    if (logType === 'chemical' && (!amount || !(parseFloat(amount) > 0))) {
      failWith('Enter an amount greater than 0');
      return;
    }
    if (logType === 'note' && !notes.trim()) {
      failWith('Add a note before saving');
      return;
    }
    setSaved(true);
    if (onLogEntry) {
      const d = new Date(datetime);
      const dateStr = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      onLogEntry({
        type: logType === 'chemical' ? `Added ${amount} ${unit} ${chemical}`
          : logType === 'backwash' ? 'Backwash'
          : logType === 'aiper' ? 'Pool cleaner run'
          : logType === 'watertest' ? 'Water test'
          : notes || 'Note',
        kind: logType,
        date: dateStr,
        ts: d.getTime(),
        note: logType === 'note' ? '' : notes,
      });
    }
    // Reset form
    setNotes('');
    if (logType === 'chemical') setAmount('');
    setTimeout(() => setSaved(false), 2000);
  };

  const typeButtons = [
    { id: 'chemical',  label: 'Chemical' },
    { id: 'backwash',  label: 'Backwash' },
    { id: 'aiper',     label: 'Pool cleaner' },
    { id: 'watertest', label: 'Water test' },
    { id: 'note',      label: 'Note' },
  ];

  return (
    <div className="screen">
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="t-label" style={{ color: 'var(--hero-dim)', marginBottom: 8 }}>Log Activity</div>
          <h1 className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 24, lineHeight: 1.15, fontWeight: 600 }}>What happened?</h1>
          <div style={{ color: 'var(--hero-dim)', fontSize: 12.5, marginTop: 6 }}>Record doses, maintenance &amp; notes</div>
        </div>
      </div>

      {/* Type selector — real buttons in a radiogroup. These were bare onClick
          divs: not focusable, not announced, and with no selected state exposed. */}
      <div className="sec-head" style={{ marginTop: 4 }}><span id="log-type-label">What are you logging?</span></div>
      <div className="quick-row" role="radiogroup" aria-labelledby="log-type-label">
        {typeButtons.map(b => (
          <button type="button" key={b.id} className="quick-btn"
            role="radio" aria-checked={logType === b.id}
            style={{ background: logType === b.id ? 'var(--ink)' : 'var(--surface)', borderColor: logType === b.id ? 'var(--ink)' : 'var(--hairline)', color: logType === b.id ? '#fff' : 'var(--ink-2)' }}
            onClick={() => setLogType(b.id)}>
            <span className="icon" aria-hidden="true" style={{ opacity: logType === b.id ? 1 : 0.85, display: 'flex' }}><Icon name={KIND_ICON[b.id]} size={17} /></span>
            {b.label}
          </button>
        ))}
      </div>

      {/* Chemical form — the chemical and unit pickers are native <select>s now.
          The hand-rolled dropdowns they replace had no roles, no aria-expanded,
          no focus management and no Escape, closed only via a click handler on
          the scroll container, and were worse than the OS picker on a phone.
          RoutineEditor already used a native select for the same list. */}
      {logType === 'chemical' && (
      <div className="log-form">
        <div className="form-field">
          <label className="form-label" htmlFor="log-chemical">Chemical</label>
          <select id="log-chemical" className="form-native-select" value={chemical} onChange={e => setChemical(e.target.value)}>
            {chemicals.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Amount + Unit */}
        <div style={{ display: 'flex', gap: 10 }}>
          <div className="form-field" style={{ flex: 2 }}>
            <label className="form-label" htmlFor="log-amount">Amount</label>
            <input id="log-amount" value={amount} onChange={e => setAmount(e.target.value)} type="number" inputMode="decimal" min="0" step="any" placeholder="0"
              style={{ fontFamily: 'Geist', fontSize: 16, fontWeight: 600, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
          <div className="form-field" style={{ flex: 1 }}>
            <label className="form-label" htmlFor="log-unit">Unit</label>
            <select id="log-unit" className="form-native-select" value={unit} onChange={e => setUnit(e.target.value)}>
              {units.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="log-datetime">Date &amp; Time</label>
          <input id="log-datetime" type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)}
            style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
        </div>
      </div>
      )}

      {/* Backwash / Pool cleaner / Water test forms */}
      {(logType === 'backwash' || logType === 'aiper' || logType === 'watertest') && (
        <div className="log-form">
          <div className="form-field">
            <label className="form-label" htmlFor="log-datetime-2">Date &amp; Time</label>
            <input id="log-datetime-2" type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)}
              style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="log-notes">Notes (optional)</label>
            <input id="log-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. filter clean, good flow"
              style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
        </div>
      )}

      {/* Note form */}
      {logType === 'note' && (
        <div className="log-form">
          <div className="form-field">
            <label className="form-label" htmlFor="log-note-body">Note</label>
            <textarea id="log-note-body" value={notes} onChange={e => setNotes(e.target.value)} placeholder="What did you observe?"
              rows={3} style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%', resize: 'none', lineHeight: 1.5 }} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="log-datetime-3">Date &amp; Time</label>
            <input id="log-datetime-3" type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)}
              style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
        </div>
      )}

      <div style={{ padding: '8px 14px 0' }}>
        {errMsg && (
          <div ref={errRef} tabIndex={-1} role="alert"
            style={{ background: 'var(--bad-tint)', color: 'var(--bad)', padding: '10px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 500, marginBottom: 10, border: '1px solid #f4cdd2' }}>
            {errMsg}
          </div>
        )}
        <button type="button" className="btn-primary" style={{ marginBottom: 16 }} onClick={handleSave}>
          {saved ? '✓ Saved' : 'Save log entry'}
        </button>
      </div>

      {/* Mark Poolwerx doses done */}
      {pending.length > 0 && (
        <>
          <div className="sec-head"><span>Mark Poolwerx doses done</span></div>
          <div style={{ padding: '0 14px', paddingBottom: 100 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--hairline)', borderRadius: 14, overflow: 'hidden' }}>
              <div className="t-label" style={{ padding: '12px 16px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hairline)' }}>
                From test · {testData.date}
              </div>
              {pending.map((t, i) => (
                <button type="button" key={t.id} className="dose-row"
                  aria-label={'Mark done: ' + t.label}
                  style={{ borderBottom: i < pending.length - 1 ? '1px solid var(--hairline-2)' : 'none' }}
                  onClick={() => onToggle(t.id)}>
                  <span className="todo-check" aria-hidden="true" style={{ minWidth: 22 }}></span>
                  <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <span style={{ display: 'block', fontFamily: 'Geist', fontSize: 13, fontWeight: 500, color: 'var(--ink)', letterSpacing: '-0.005em' }}>{t.label}</span>
                    <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>{t.reason}</span>
                  </span>
                  <span style={{ fontFamily: 'Geist Mono, ui-monospace, monospace', color: t.color, fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t.pri}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── History Screen ──────────────────────────────
function History({ onNav, entries: userEntries, onExport, onImport }) {
  const entries = userEntries || [];
  const fileRef = React.useRef(null);
  const handlePick = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onImport(f);
    e.target.value = '';
  };

  return (
    <div className="screen">
      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={handlePick} />
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="t-label" style={{ color: 'var(--hero-dim)', marginBottom: 8 }}>History</div>
              <h1 className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 24, lineHeight: 1.15, fontWeight: 600 }}>Activity log</h1>
              <div style={{ color: 'var(--hero-dim)', fontSize: 12.5, marginTop: 6 }}>Doses, runs, observations</div>
            </div>
            {/* Import replaces everything, so it says so — it used to sit 6px from
                Export as an identical 26px chip. */}
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button type="button" onClick={onExport} className="chip-btn" aria-label="Export a backup of all data">↓ Export</button>
              <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="chip-btn"
                aria-label="Import a backup — this replaces all current data">↑ Import</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '16px 14px 100px' }}>
        {entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
            <div className="t-title" style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 6 }}>No activity yet</div>
            <div style={{ fontSize: 12.5 }}>Log a dose, backwash or pool cleaner run and it will appear here.</div>
          </div>
        ) : (
        <React.Fragment>
        {groupEntriesByMonth(entries).map(group => (
          <div key={group.key} style={{ marginBottom: 16 }}>
            <div className="t-label" style={{ padding: '4px 4px 8px' }}>{group.label}</div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--hairline)', borderRadius: 14, overflow: 'hidden' }}>
              {group.items.map(({ e, i }, j) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: j < group.items.length - 1 ? '1px solid var(--hairline-2)' : 'none' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--hairline-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-2)', flexShrink: 0 }}>
                    <Icon name={KIND_ICON[entryKind(e)]} size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'Geist', fontSize: 13.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '-0.005em' }}>{e.type}</div>
                    {e.note && <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>{e.note}</div>}
                  </div>
                  <div className="t-num" style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 400, flexShrink: 0, fontFamily: 'Geist Mono, ui-monospace, monospace' }}>{e.date}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
        </React.Fragment>
        )}
        <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, padding: '4px 4px 0', textAlign: 'center' }}>
          Export backs up all data as a file · Import replaces current data
        </div>
      </div>
    </div>
  );
}

// Group history entries (newest-first) into month buckets. Entries without a
// usable timestamp (legacy data) fall into an "Earlier" bucket at the end.
function groupEntriesByMonth(entries) {
  const groups = [];
  const byKey = {};
  const thisYear = new Date().getFullYear();
  entries.forEach((e, i) => {
    let key = 'earlier', label = 'Earlier';
    if (e.ts) {
      const d = new Date(e.ts);
      key = d.getFullYear() + '-' + d.getMonth();
      label = d.toLocaleDateString('en-AU', { month: 'long' }) + (d.getFullYear() !== thisYear ? ' ' + d.getFullYear() : '');
    }
    if (!byKey[key]) { byKey[key] = { key, label, items: [] }; groups.push(byKey[key]); }
    byKey[key].items.push({ e, i });
  });
  return groups;
}

// ─── Reminders toggle (Routines screen) ──────────
// Self-contained: talks to window.PoolNotify. Hidden entirely on browsers that
// don't support notifications/service workers.
const hourLabel = (h) => ((h % 12) || 12) + ':00 ' + (h < 12 ? 'am' : 'pm');
const NOTIFY_HOURS = Array.from({ length: 24 }, (_, i) => i);

function ReminderToggle() {
  const [state, setState] = React.useState('loading'); // loading|off|on|denied|unsupported
  const [bg, setBg] = React.useState(false);           // background sync granted?
  const [hour, setHour] = React.useState(null);        // earliest delivery hour; null until loaded

  React.useEffect(() => {
    let alive = true;
    const PN = window.PoolNotify;
    if (!PN || !PN.supported()) { setState('unsupported'); return; }
    if (PN.permission() === 'denied') { setState('denied'); return; }
    PN.isEnabled().then(on => { if (alive) setState(on ? 'on' : 'off'); });
    PN.getNotifyHour().then(h => { if (alive) setHour(h); });
    return () => { alive = false; };
  }, []);

  const toggle = async () => {
    const PN = window.PoolNotify;
    if (!PN || state === 'loading') return;
    if (state === 'on') { await PN.disable(); setState('off'); setBg(false); return; }
    setState('loading');
    const res = await PN.enable();
    if (res.ok) { setState('on'); setBg(!!res.background); }
    else setState(res.permission === 'denied' ? 'denied' : 'off');
  };

  // Optimistic — the select is the source of truth for the UI, IndexedDB catches up.
  const changeHour = (h) => {
    setHour(h);
    if (window.PoolNotify) window.PoolNotify.setNotifyHour(h);
  };

  if (state === 'unsupported') return null;

  const on = state === 'on';
  const denied = state === 'denied';
  const sub = denied
    ? 'Blocked — allow notifications for this site in your browser settings, then reload.'
    : on
      ? (bg
          ? "On — you'll be reminded when a task is due, even when the app is closed."
          : 'On — reminders show while the app is open. Add it to your home screen for background reminders.')
      : 'Get a notification when a task becomes due, or when a new test adds actions.';

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--hairline-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: on ? 'var(--accent)' : 'var(--ink-2)', flexShrink: 0 }}>
          <Icon name="bell" size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-title" style={{ fontSize: 14.5, color: 'var(--ink)' }}>Reminders</div>
          <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 3, lineHeight: 1.4 }}>{sub}</div>
        </div>
        {!denied && (
          <button onClick={toggle} role="switch" aria-checked={on} aria-label="Toggle reminders"
            disabled={state === 'loading'}
            style={{ flexShrink: 0, width: 44, height: 26, borderRadius: 999, border: 'none', padding: 0, position: 'relative', cursor: state === 'loading' ? 'default' : 'pointer', background: on ? 'var(--ink)' : 'var(--hairline)', transition: 'background 0.2s', opacity: state === 'loading' ? 0.6 : 1 }}>
            <span style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }} />
          </button>
        )}
      </div>

      {on && hour != null && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline-2)' }}>
          <div style={{ minWidth: 0 }}>
            <label htmlFor="notify-hour" className="t-title" style={{ fontSize: 13, color: 'var(--ink)' }}>Not before</label>
            <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2, lineHeight: 1.4 }}>Due routines are held until this time, so nothing wakes you overnight.</div>
          </div>
          <select id="notify-hour" value={hour} onChange={e => changeHour(+e.target.value)}
            style={{ flexShrink: 0, fontFamily: 'Geist Mono', fontSize: 13, color: 'var(--accent)', background: 'var(--surface-2)', border: '1px solid var(--hairline-2)', borderRadius: 8, padding: '6px 10px', outline: 'none', appearance: 'none', cursor: 'pointer' }}>
            {NOTIFY_HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

// ─── App ─────────────────────────────────────────
const LS_KEY = 'poolDashboard_v2';
const STATE_REV = 1; // bump when migrateData() gains a new one-time step
const loadState = () => {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
};

// Parse the report's "2 Jul 2026" / "2 July 2026" date without Date.parse
// (Safari rejects that format). Returns a local-midnight timestamp or null.
function parseTestDate(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec((s || '').trim());
  if (!m) return null;
  const mi = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const d = new Date(+m[3], mi, +m[1]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// Insert into a newest-first entry list at the right spot for its ts.
function insertEntrySorted(list, entry) {
  const i = list.findIndex(e => (e.ts || 0) <= (entry.ts || 0));
  const copy = list.slice();
  copy.splice(i < 0 ? copy.length : i, 0, entry);
  return copy;
}

function waterTestEntry(ts) {
  return {
    type: 'Water test · Poolwerx', kind: 'watertest',
    date: new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
    ts, note: '',
  };
}

// The robot was branded "Aiper Scuba" in older data; everything now says "Pool cleaner".
const renamePoolCleaner = (s) => (s || '')
  .replace(/run\s+aiper(\s+scuba)?/gi, 'Run pool cleaner')
  .replace(/aiper(\s+scuba)?\s+run/gi, 'Pool cleaner run')
  .replace(/scuba\s+run/gi, 'Pool cleaner run')
  .replace(/aiper(\s+scuba)?/gi, 'pool cleaner')
  .replace(/scuba/gi, 'pool cleaner')
  .replace(/^pool cleaner/, 'Pool cleaner');

// Migrations over persisted/imported data. The renames are idempotent and run
// every time (so old backup imports come out clean too); the rev-guarded block
// seeds the water-test routine once, anchored to the last imported test so its
// first due date reflects reality. Deleting that routine later sticks.
function migrateData(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (Array.isArray(out.routines)) {
    out.routines = out.routines.map(r => /aiper|scuba/i.test(r.name || '') ? { ...r, name: renamePoolCleaner(r.name) } : r);
  }
  if (Array.isArray(out.logEntries)) {
    out.logEntries = out.logEntries.map(e => /aiper|scuba/i.test(e.type || '') ? { ...e, type: renamePoolCleaner(e.type) } : e);
  }
  if ((out.rev || 0) < 1) {
    if (Array.isArray(out.routines) && !out.routines.some(r => r.match && r.match.logType === 'watertest')) {
      const seed = window.RoutinesAPI && window.RoutinesAPI.SEED_ROUTINES.find(r => r.match.logType === 'watertest');
      if (seed) out.routines = [...out.routines, { ...seed, createdTs: Date.now() }];
    }
    const entries = Array.isArray(out.logEntries) ? out.logEntries : [];
    const testTs = out.testData && out.testData.date ? parseTestDate(out.testData.date) : null;
    if (testTs && !entries.some(e => entryKind(e) === 'watertest')) {
      out.logEntries = insertEntrySorted(entries, waterTestEntry(testTs));
    }
  }
  return out;
}

function App() {
  const persisted = migrateData(loadState());
  const [screen, setScreen] = React.useState('dashboard');
  const [todos, setTodos] = React.useState((persisted && persisted.todos) || []);
  const [toast, setToast] = React.useState('');
  const [testData, setTestData] = React.useState((persisted && persisted.testData) || TEST);
  const [uploading, setUploading] = React.useState(false);
  const [logEntries, setLogEntries] = React.useState((persisted && persisted.logEntries) || []);
  const [phHistory, setPhHistory] = React.useState((persisted && persisted.phHistory) || []);
  // Routines: seed defaults on first load (persisted may exist without routines field from v3).
  // Rules missing createdTs (pre-v4.1 data) are anchored to now so they don't show as overdue.
  const [routines, setRoutines] = React.useState(() => {
    if (persisted && Array.isArray(persisted.routines)) {
      return persisted.routines.map(r => r.createdTs ? r : { ...r, createdTs: Date.now() });
    }
    return (window.RoutinesAPI && window.RoutinesAPI.seedRoutines()) || [];
  });
  const [editorRule, setEditorRule] = React.useState(null); // null | {} (new) | rule (edit)

  React.useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ rev: STATE_REV, todos, testData, logEntries, phHistory, routines })); }
    catch (e) { /* quota / private mode */ }
  }, [todos, testData, logEntries, phHistory, routines]);

  // Reminders: re-arm on load if previously enabled, and re-check whenever the
  // app regains focus (catches routines that came due while it was backgrounded).
  React.useEffect(() => {
    if (window.PoolNotify) {
      // Registers the service worker on every load — it backs the offline cache
      // now, not just reminders. resume() then re-arms notifications only if
      // they were previously enabled.
      window.PoolNotify.ensureRegistered();
      window.PoolNotify.resume();
    }
    const onVis = () => {
      if (document.visibilityState === 'visible' && window.PoolNotify) window.PoolNotify.checkNow();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Mirror each routine's next-due timestamp into IndexedDB so the background
  // sync can read it, then run a foreground check (a no-op unless enabled).
  React.useEffect(() => {
    if (!window.PoolNotify || !window.RoutinesAPI) return;
    const now = Date.now();
    const schedule = routines.map(r => {
      const s = window.RoutinesAPI.ruleStatus(r, logEntries, now);
      return { id: r.id, name: r.name, dueTs: s.dueTs };
    });
    window.PoolNotify.writeSchedule(schedule);
    window.PoolNotify.checkNow();
  }, [routines, logEntries]);

  // Toast lives at App level so it shows on every screen. Optional action
  // button (e.g. Undo) extends the visible time to 5s.
  const toastTimer = React.useRef(null);
  const showToast = (msg, action) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(action ? { msg, ...action } : { msg });
    toastTimer.current = setTimeout(() => setToast(''), action ? 5000 : 2800);
  };

  // Given a freshly-added log entry, find any routine it satisfies (that was due/overdue) and return a smart toast string.
  const buildSmartToast = (entry, prevEntries) => {
    if (!window.RoutinesAPI) return null;
    const now = Date.now();
    for (const rule of routines) {
      if (!window.RoutinesAPI.matchesRule(rule, entry)) continue;
      // Was it due/overdue before this entry?
      const before = window.RoutinesAPI.ruleStatus(rule, prevEntries, now);
      if (before.status === 'upcoming') continue;
      // Recompute next-due assuming this log entry as last-done.
      const newNext = window.RoutinesAPI.nextDueTs(rule, entry.ts || now, now);
      const nd = new Date(newNext);
      const dow = window.RoutinesAPI.DOW_SHORT[nd.getDay()];
      const dStr = nd.getDate() + ' ' + nd.toLocaleDateString('en-AU', { month: 'short' });
      return '✓ ' + rule.name + ' — next due ' + dow + ' ' + dStr;
    }
    return null;
  };

  const onLogEntry = (entry) => {
    const ts = entry.ts || Date.now();
    const now = new Date(ts);
    const dateStr = now.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const full = { ...entry, ts, date: dateStr };
    const smart = buildSmartToast(full, logEntries);
    setLogEntries(prev => [full, ...prev]);
    showToast(smart || ('✓ ' + entry.type + ' logged'));
  };
  const fileRef = React.useRef();

  const onDelete = (id) => {
    setTodos(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const removed = prev[idx];
      showToast('Action removed', {
        actionLabel: 'Undo',
        onAction: () => {
          setTodos(cur => {
            if (cur.some(t => t.id === removed.id)) return cur;
            const next = cur.slice();
            next.splice(Math.min(idx, next.length), 0, removed);
            return next;
          });
          setToast('');
        },
      });
      return prev.filter(t => t.id !== id);
    });
  };

  const onToggle = (id) => {
    setTodos(prev => {
      const item = prev.find(t => t.id === id);
      if (item && !item.done) {
        const ts = Date.now();
        const dateStr = new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
        showToast('✓ Logged: ' + item.label);
        setLogEntries(le => [{ type: item.label, kind: 'chemical', date: dateStr, note: item.reason, ts }, ...le]);
        setTimeout(() => setTodos(t => t.filter(x => x.id !== id)), 700);
        return prev.map(t => t.id === id ? { ...t, done: true } : t);
      }
      return prev;
    });
  };

  // Toggle a routine card on the dashboard — equivalent to logging a matching entry now.
  const onRoutineDone = (routineId) => {
    const rule = routines.find(r => r.id === routineId);
    if (!rule) return;
    const ts = Date.now();
    const dateStr = new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    // Build entry that matches this routine's matcher
    const m = rule.match || {};
    const kind = m.logType || 'note';
    const type = kind === 'chemical' ? 'Added ' + (m.chemical || 'chemical')
      : kind === 'aiper' ? 'Pool cleaner run'
      : kind === 'backwash' ? 'Backwash'
      : kind === 'watertest' ? 'Water test'
      : rule.name;
    const entry = { type, kind, date: dateStr, ts, note: 'Marked done from routine' };
    const smart = buildSmartToast(entry, logEntries);
    setLogEntries(le => [entry, ...le]);
    showToast(smart || ('✓ ' + rule.name + ' logged'));
  };

  const onSaveRoutine = (rule) => {
    setRoutines(prev => {
      const idx = prev.findIndex(r => r.id === rule.id);
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = rule;
        return copy;
      }
      return [...prev, rule];
    });
    setEditorRule(null);
    showToast('✓ Routine saved');
  };
  const onDeleteRoutine = (id) => {
    setRoutines(prev => prev.filter(r => r.id !== id));
    showToast('Routine removed');
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) { showToast('Please select a PDF file'); return; }
    setUploading(true);
    showToast('Reading PDF…');
    try {
      const parsed = await parsePoolwerxPDF(file);

      // Nothing recognisable in the file — bail before touching state. Replacing
      // a good test and a live action list with an empty one because the user
      // picked the wrong PDF is not a recoverable mistake.
      if (parsed.metricsParsed === 0 && (!parsed.recs || parsed.recs.length === 0)) {
        showToast("Couldn't read that PDF — no results found");
        setUploading(false);
        e.target.value = '';
        return;
      }

      // Guard against an older report silently overwriting newer results.
      const newTs = parseTestDate(parsed.date);
      const curTs = testData.date ? parseTestDate(testData.date) : null;
      if (newTs && curTs && newTs < curTs &&
          !window.confirm('That report is dated ' + parsed.date + ', which is older than your current test (' + testData.date + ').\n\nLoad it anyway and replace the newer results?')) {
        setUploading(false);
        e.target.value = '';
        return;
      }

      const vals = { ph: parsed.ph, fcl: parsed.freeCl, ccl: parsed.combCl, salt: parsed.salt, alk: parsed.alk, cah: parsed.caHard, cya: parsed.cya, phos: parsed.phos };
      // Rebuilt from METRIC_DEFS rather than mapped over the persisted metrics.
      // Two reasons: (1) a metric that fails to parse must go to null, not keep
      // last month's reading under this month's date — the old code returned the
      // previous metric object verbatim, so stale numbers were presented as new
      // results and the fallback below even built to-dos from them; (2) the
      // target ranges used to be frozen into localStorage on first save, so any
      // later correction to a range never reached an existing install.
      const updatedMetrics = METRIC_DEFS.map(def => {
        const v = vals[def.id];
        return v == null
          ? { ...def, val: null, status: 'ok' }
          : { ...def, val: v, status: calcStatus(v, def.lo, def.hi, def.min, def.max) };
      });
      const updated = { ...testData, date: parsed.date, pool: parsed.pool || testData.pool, lsi: parsed.lsi != null ? parsed.lsi : testData.lsi, metrics: updatedMetrics };
      setTestData(updated);
      // An imported report IS a water test — log it (once per test date) so the
      // "Get water tested" routine resets from the report's own date. Deduped on
      // the calendar day, not the exact ts: an unparseable date falls back to
      // Date.now(), which never equals a stored ts and so logged a duplicate
      // water test on every upload.
      const testTs = newTs || Date.now();
      const testDay = new Date(testTs); testDay.setHours(0, 0, 0, 0);
      setLogEntries(prev => prev.some(en => {
        if (en.kind !== 'watertest' || !en.ts) return false;
        const d = new Date(en.ts); d.setHours(0, 0, 0, 0);
        return d.getTime() === testDay.getTime();
      }) ? prev : insertEntrySorted(prev, waterTestEntry(testTs)));
      if (parsed.ph != null) {
        const dateLabel = (parsed.date || '').split(' ').slice(0, 2).join(' ') || 'now';
        setPhHistory(prev => {
          const exists = prev.some(p => p.label === dateLabel);
          const next = exists ? prev.map(p => p.label === dateLabel ? { ...p, val: parsed.ph } : p) : [...prev, { label: dateLabel, val: parsed.ph }];
          return next.slice(-6);
        });
      }
      // Build todos from Poolwerx recommendations first, fall back to out-of-range metrics
      let newTodos = [];
      if (parsed.recs && parsed.recs.length > 0) {
        newTodos = parsed.recs.map((r, i) => {
          // Attribute the action to the metric its own heading names. The old
          // first-word substring test matched "ph" inside "PHOSPHATES", so a
          // phosphate dose was captioned "pH is 7.6" and dropped to MED while
          // Phosphates sat at 2.608 against a 0–0.2 target. The text search is
          // kept only as a fallback for an unrecognised heading, and now needs
          // the whole label rather than its first word.
          const mapped = metricIdForParam(r.param);
          const metric = (mapped && updatedMetrics.find(m => m.id === mapped)) ||
            updatedMetrics.find(m => m.status !== 'ok' && r.action.toLowerCase().includes(m.label.toLowerCase()));
          const status = metric && metric.status !== 'ok' ? metric.status : 'bad';
          return {
            id: i + 1,
            pri: status === 'bad' ? 'HIGH' : 'MED',
            label: normalizeDose(r.action),
            reason: (metric && metric.val != null)
              ? (metric.label + ' is ' + metric.val + ' · target ' + metric.lo + '–' + metric.hi + (metric.unit ? ' ' + metric.unit : ''))
              : (r.param || 'From your latest report'),
            color: status === 'bad' ? 'var(--bad)' : 'var(--warn)',
            done: false,
          };
        });
      } else {
        // No recommendations parsed — fall back to out-of-range metric list
        newTodos = updatedMetrics.filter(m => m.status !== 'ok').map((m, i) => ({
          id: i + 1, pri: m.status === 'bad' ? 'HIGH' : 'MED',
          label: m.label + ' out of range',
          reason: m.label + ' is ' + m.val + ' · target ' + m.lo + '–' + m.hi + ' ' + m.unit,
          color: m.status === 'bad' ? 'var(--bad)' : 'var(--warn)', done: false,
        }));
      }
      setTodos(newTodos);
      if (window.PoolNotify && newTodos.length) {
        window.PoolNotify.notifyTodos(newTodos.length, newTodos[0] && newTodos[0].label, parsed.date);
      }
      // Say what actually came through. A blanket success toast hid partial
      // parses completely: the hero showed the new date, Chemistry showed
      // numbers, and nothing told the user some of them hadn't been read.
      const dateLabel = parsed.date === 'Unknown date' ? 'that report' : parsed.date;
      if (parsed.metricsParsed < parsed.metricsTotal) {
        showToast('Loaded ' + parsed.metricsParsed + ' of ' + parsed.metricsTotal + ' results from ' + dateLabel + ' — check Chemistry');
      } else {
        showToast('✓ Loaded test from ' + dateLabel);
      }
    } catch (err) {
      // Distinguish "the CDN never arrived" from "this PDF isn't a Poolwerx
      // report" — the old message blamed the file for a network failure.
      const msg = err && /pdfjs-(timeout|unreachable)/.test(err.message || '')
        ? 'Could not load the PDF reader — check your connection and try again'
        : 'Could not parse PDF — try another file';
      showToast(msg);
      console.error(err);
    }
    setUploading(false);
    e.target.value = '';
  };

  const triggerUpload = () => fileRef.current && fileRef.current.click();

  const onExport = () => {
    try {
      const payload = {
        app: 'poolDashboard',
        version: '2.4',
        exportedAt: new Date().toISOString(),
        data: { rev: STATE_REV, todos, testData, logEntries, phHistory, routines },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `pool-dashboard-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('✓ Backup downloaded');
    } catch (err) {
      console.error(err);
      showToast('Export failed');
    }
  };

  const onImport = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const raw = (parsed && parsed.data) ? parsed.data : parsed;
        if (!raw || typeof raw !== 'object') throw new Error('Invalid file');
        if (!window.confirm('Replace current data with the contents of this backup? This cannot be undone.')) return;
        const data = migrateData(raw); // old backups: rename Aiper text, seed water-test routine
        if (Array.isArray(data.todos)) setTodos(data.todos);
        if (data.testData && data.testData.metrics) setTestData(data.testData);
        if (Array.isArray(data.logEntries)) setLogEntries(data.logEntries);
        if (Array.isArray(data.phHistory)) setPhHistory(data.phHistory);
        if (Array.isArray(data.routines)) setRoutines(data.routines.map(r => r.createdTs ? r : { ...r, createdTs: Date.now() }));
        showToast('✓ Backup restored');
      } catch (err) {
        console.error(err);
        showToast('Import failed — not a valid backup');
      }
    };
    reader.onerror = () => showToast('Could not read file');
    reader.readAsText(file);
  };

  const screens = {
    dashboard: <Dashboard onNav={setScreen} todos={todos} onToggle={onToggle} onDelete={onDelete} toast={toast} testData={testData} onUpload={triggerUpload} uploading={uploading} phHistory={phHistory} routines={routines} logEntries={logEntries} onRoutineDone={onRoutineDone} />,
    chemistry: <Chemistry onNav={setScreen} testData={testData} onReupload={triggerUpload} />,
    log: <Log onNav={setScreen} todos={todos} onToggle={onToggle} testData={testData} onLogEntry={onLogEntry} />,
    routines: window.RoutinesScreen ? <window.RoutinesScreen rules={routines} entries={logEntries} onAdd={() => setEditorRule({})} onEdit={setEditorRule} onDelete={onDeleteRoutine} banner={<ReminderToggle />} /> : null,
    history: <History onNav={setScreen} entries={logEntries} onExport={onExport} onImport={onImport} />,
  };

  const navItems = [
    { id: 'dashboard', icon: 'home',   label: 'Home' },
    { id: 'chemistry', icon: 'flask',  label: 'Chemistry' },
    { id: 'log',       icon: 'plus',   label: 'Log' },
    { id: 'routines',  icon: 'repeat', label: 'Routines' },
    { id: 'history',   icon: 'list',   label: 'History' },
  ];

  return (
    <React.Fragment>
      <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={handleFileChange} />
      {editorRule !== null && window.RoutineEditor && (
        <window.RoutineEditor
          initial={editorRule && editorRule.id ? editorRule : null}
          onSave={onSaveRoutine}
          onDelete={(id) => { onDeleteRoutine(id); setEditorRule(null); }}
          onCancel={() => setEditorRule(null)} />
      )}
      {/* app-shell carries the height: 100vh became 100dvh in CSS so the sticky
          nav isn't pushed under the mobile browser's collapsing URL bar. */}
      <div className="app-shell">
        <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {screens[screen]}
        </main>
        <nav className="bottom-nav" aria-label="Main">
          {navItems.map(n => (
            <button key={n.id} type="button"
              className={`nav-item${screen === n.id ? ' active' : ''}`}
              aria-current={screen === n.id ? 'page' : undefined}
              onClick={() => setScreen(n.id)}>
              <span className="nav-icon" aria-hidden="true"><Icon name={n.icon} size={19} strokeWidth={screen === n.id ? 1.8 : 1.5} /></span>
              {n.label}
            </button>
          ))}
        </nav>
        {/* The live region stays mounted and empty so swapping its text is what
            gets announced. The Undo button is only rendered (and focusable) while
            a toast is actually showing. */}
        <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
          {toast && toast.msg}
          {toast && toast.actionLabel && (
            <button type="button" className="toast-action" onClick={toast.onAction}>{toast.actionLabel}</button>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
