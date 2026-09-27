// app.jsx — main app. Loads after routines.jsx, which provides the shared
// stroke-icon set and the recurring-rule engine on window.
const Icon = window.Icon;
const KIND_ICON = window.RoutinesAPI.KIND_ICON;
const entryKind = window.RoutinesAPI.entryKind;
const dayStartTs = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

// User-facing app version, shown on the Home hero so a phone can confirm it
// picked up the latest deploy. Bump this when shipping a change you want to
// be able to check on-device. Separate from the backup-file `version` field
// and from STATE_REV (those are data-format revisions).
const APP_VERSION = '2.8';

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
  // isEvalSupported: false — pdf.js 3.x can run code generated from a crafted
  // font (CVE-2024-4367). Reading text probably never reaches that path, but
  // this switch rules it out; it only affects rendering speed, not text.
  const pdfDoc = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
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

// Minimum frame for a metric's trend chart, so a flat run of readings isn't
// blown up to fill the height. pH has always been drawn on 7.0–8.5.
const TREND_DOMAIN = { ph: [7.0, 8.5] };

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
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (ts) => { const d = new Date(ts); return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()]; };

// Round tick values ("3,500 / 4,000 / 4,500") inside [min, max]: a 1/2/2.5/5
// step giving at most four ticks. The old ticks sat at thirds of the domain
// with one decimal, which is fine for pH but printed salt as "3380.0".
function niceTicks(min, max) {
  const span = max - min || 1;
  const pow = Math.pow(10, Math.floor(Math.log10(span / 3)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => span / s <= 4);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  const decimals = (String(+step.toFixed(10)).split('.')[1] || '').length;
  return ticks.map(v => ({ v, text: v.toLocaleString('en-AU', { maximumFractionDigits: decimals }) }));
}

// One reading over the last few tests. Used for pH on Home and for every
// metric on the Chemistry screen, so the scale comes from the data and the
// target band; domainMin/domainMax only widen it (pH keeps its 7.0–8.5 frame).
function TrendChart({ data, lo, hi, domainMin, domainMax, unit = '', label = 'pH', emptyText = 'Need at least 2 tests to show a trend' }) {
  const gradId = 'trend' + React.useId().replace(/[^A-Za-z0-9]/g, '');
  const [sel, setSel] = React.useState(null); // tapped point: shows its value and date
  data = (data || []).filter(d => d && typeof d.val === 'number' && Number.isFinite(d.val));
  if (data.length < 2) {
    if (!emptyText) return null;
    return (
      <div style={{ height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>
        {emptyText}
      </div>
    );
  }
  // Normalize: ensure lo <= hi
  if (lo > hi) { const t = lo; lo = hi; hi = t; }

  // The visible domain covers the data and the target band, with a little
  // headroom. When nothing is below zero the floor stays at zero, so the
  // headroom never prints a negative tick under a concentration.
  const vals = data.map(d => d.val);
  const dataMin = Math.min(...vals, lo, domainMin != null ? domainMin : lo);
  const dataMax = Math.max(...vals, hi, domainMax != null ? domainMax : hi);
  const span = dataMax - dataMin || 1;
  let yMin = dataMin - span * 0.08;
  const yMax = dataMax + span * 0.08;
  if (dataMin >= 0) yMin = Math.max(0, yMin);

  const ticks = niceTicks(yMin, yMax);
  const W = 295, H = 90;
  const pad = { l: Math.max(24, 8 + Math.max(...ticks.map(t => t.text.length)) * 5.2), r: 8, t: 10, b: 20 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  const px = (i) => pad.l + (i / (data.length - 1)) * cW;
  const py = (v) => pad.t + cH - ((v - yMin) / (yMax - yMin)) * cH;

  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${px(i)} ${py(d.val)}`).join(' ');
  const areaD = `${pathD} L ${px(data.length - 1)} ${pad.t + cH} L ${px(0)} ${pad.t + cH} Z`;

  const loY = py(lo), hiY = py(hi);
  // hi value is higher on the number line → smaller y; band top = hiY, height = loY - hiY
  const bandTop = Math.min(loY, hiY);
  const bandH   = Math.abs(loY - hiY);

  const u = unit ? ' ' + unit : '';
  const inBand = (v) => v >= lo && v <= hi;
  const last = data[data.length - 1];
  const first = data[0];
  const dir = last.val > first.val ? 'rising' : last.val < first.val ? 'falling' : 'flat';
  // Every reading is in the accessible name, so the tap labels are never the
  // only way to get at a value.
  const summary = label + ' over the last ' + data.length + ' tests, ' + dir + ' from ' +
    first.val + u + ' in ' + first.label + ' to ' + last.val + u + ' in ' + last.label + '. ' +
    'Readings: ' + data.map(d => d.label + ' ' + d.val).join(', ') + '. ' +
    'Target range ' + lo + ' to ' + hi + u + '. ' +
    data.filter(d => !inBand(d.val)).length + ' of ' + data.length + ' outside target.';

  const selPt = sel != null && data[sel] ? data[sel] : null;
  const selX = selPt ? Math.min(W - pad.r, Math.max(pad.l, px(sel))) : 0;
  const selY = selPt ? py(selPt.val) : 0;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}
      role="img" aria-label={summary}>
      {/* Target band */}
      <rect x={pad.l} y={bandTop} width={cW} height={bandH} fill="#087299" opacity={0.08} rx={2} />
      <line x1={pad.l} y1={loY} x2={pad.l + cW} y2={loY} stroke="#087299" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
      <line x1={pad.l} y1={hiY} x2={pad.l + cW} y2={hiY} stroke="#087299" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />

      {/* Area fill */}
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0c1a22" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#0c1a22" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} />

      {/* Line */}
      <path d={pathD} fill="none" stroke="#0c1a22" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* Points — at least 8px across, with a 2px ring in the card colour */}
      {data.map((d, i) => (
        <circle key={i} cx={px(i)} cy={py(d.val)} r={i === data.length - 1 ? 5 : 4}
          style={{ fill: inBand(d.val) ? 'var(--ok)' : 'var(--bad)', stroke: 'var(--surface)' }}
          strokeWidth={2} />
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
      {ticks.map((t, i) => (
        <text key={i} x={pad.l - 4} y={py(t.v) + 3} textAnchor="end"
          style={{ fontSize: 8.5, fontFamily: 'Geist Mono, ui-monospace, monospace', fill: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>
          {t.text}
        </text>
      ))}

      {/* No in-chart "target" caption: it was anchored to the right edge of the
          band, which is exactly where the latest reading is plotted, so with a
          full six-test history the word sat underneath the last point. The card
          header already states "Target lo–hi" and the band is drawn, so the
          caption was duplicating information as well as colliding. */}

      {/* Tap a point to read it. Hit areas are 24px across — the dots alone
          are too small to land on with a finger. */}
      {data.map((d, i) => (
        <circle key={'hit' + i} cx={px(i)} cy={py(d.val)} r={12} fill="transparent"
          style={{ cursor: 'pointer' }} onClick={() => setSel(sel === i ? null : i)} />
      ))}
      {selPt && (
        <text x={selX} y={selY < pad.t + 14 ? selY + 18 : selY - 10}
          textAnchor={sel === 0 ? 'start' : sel === data.length - 1 ? 'end' : 'middle'}
          style={{ fontSize: 10, fontFamily: 'Geist Mono, ui-monospace, monospace', fontWeight: 600, fill: 'var(--ink)', paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3, strokeLinejoin: 'round', pointerEvents: 'none' }}>
          {selPt.val + u + ' · ' + selPt.label}
        </text>
      )}
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
function Dashboard({ onNav, todos, onToggle, onDelete, toast, testData, onUpload, uploading, testHistory, routines, logEntries, onRoutineDone }) {
  testData = testData || TEST;
  const hasTest = !!testData.date;
  // Looked up by id, not by array position. Persisted or imported test data can
  // carry a metrics array of a different length or order, and metrics[0]/[1]/[3]
  // then reads the wrong metric or throws on undefined.
  const metric = (id) => (testData.metrics || []).find(m => m.id === id) ||
    METRIC_DEFS.find(m => m.id === id) || { val: null, status: 'ok', lo: 0, hi: 0, label: id };
  const ph = metric('ph');
  const phTrend = trendFor(testHistory, 'ph');
  const badCount = (testData.metrics || []).filter(m => m.status !== 'ok').length;
  // The pill counts borderline readings as issues, but its accessible name used
  // to call all of them "outside target" — a borderline pH 7.2 is inside it.
  const outCount = (testData.metrics || []).filter(m => m.status === 'bad').length;
  const edgeCount = badCount - outCount;
  const plural = (n, word) => n + ' ' + word + (n !== 1 ? 's' : '');
  const issuesAria = badCount === 0 ? 'No metrics outside target. View all metrics'
    : [outCount ? plural(outCount, 'metric') + ' outside target' : '',
       edgeCount ? plural(edgeCount, 'metric') + ' borderline' : ''].filter(Boolean).join(', ') + '. View all metrics';
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
            <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <span className="t-label t-num" style={{ color: 'var(--hero-dim)' }} aria-label={'App version ' + APP_VERSION}>v{APP_VERSION}</span>
              {hasTest && (
                <button className="chip-btn" onClick={onUpload} disabled={uploading}
                  aria-label="Upload a new Poolwerx test PDF"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: uploading ? 0.6 : 1 }}>
                  <Icon name="upload" size={12} /> {uploading ? 'Parsing…' : 'New test'}
                </button>
              )}
            </div>
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
              <div style={{ color: 'var(--hero-fg)', fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontWeight: 500, fontSize: 13.5, letterSpacing: '-0.005em' }}>{uploading ? 'Parsing PDF…' : 'Upload Poolwerx Report'}</div>
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
            aria: issuesAria },
        ].map((p, i) => (
          <button type="button" key={i} className={`pill ${pillCls(p.status)} t-num`}
            aria-label={p.aria || (p.name + ' ' + p.label.split(' ').slice(1).join(' ') + ' — ' + STATUS_WORD[p.status] + '. View all metrics')}
            onClick={() => onNav('chemistry')}>{p.label}</button>
        )) : <div style={{ color: 'var(--muted)', fontSize: 12, padding: '4px 4px' }}>Results will appear here after upload</div>}
      </div>

      {/* pH Trend */}
      <div className="sec-head">
        {/* Was "6 months": the chart holds the last six tests, however far apart. */}
        <span>{'pH Trend' + (phTrend.length >= 2 ? ' · last ' + phTrend.length + ' tests' : '')}</span>
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
        <TrendChart data={phTrend} lo={ph.lo} hi={ph.hi} domainMin={TREND_DOMAIN.ph[0]} domainMax={TREND_DOMAIN.ph[1]} label="pH" />
      </div>
      ) : (
        <div className="chart-card" style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--muted)' }}>
          <div style={{ fontSize: 13 }}>pH trend will appear after your first upload</div>
        </div>
      )}

      {/* To-do */}
      <div className="sec-head">
        <span>Action list</span>
        <span style={{ color: 'var(--muted)', fontSize: 11.5, fontWeight: 400, fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', textTransform: 'none', letterSpacing: '-0.005em' }} className="t-num">{(hasTest || mergedTodos.length) ? (openCount + ' open') : ''}</span>
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
function Chemistry({ onNav, testData, onReupload, testHistory, equipment }) {
  testData = testData || TEST;
  const hasTest = !!testData.date;
  const series = {};
  (testData.metrics || []).forEach(m => { series[m.id] = trendFor(testHistory, m.id); });
  const waitingForTrend = (testData.metrics || []).some(m => m.val != null && series[m.id].length < 2);
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

      {equipment}

      {!hasTest ? (
        <div style={{ textAlign: 'center', padding: '40px 20px 100px', color: 'var(--muted)' }}>
          <div className="t-title" style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 6 }}>No test data yet</div>
          <div style={{ fontSize: 12.5 }}>Upload a Poolwerx PDF from the Dashboard to see your water chemistry.</div>
        </div>
      ) : (
      <div style={{ paddingBottom: 100 }}>
        <div className="sec-head"><span>Readings</span></div>
        {waitingForTrend && (
          <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45, padding: '0 18px 12px' }}>
            Each reading shows a trend once it has two tests.
          </div>
        )}
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
              {series[m.id].length >= 2 && (
                <div style={{ marginTop: 14 }}>
                  <TrendChart data={series[m.id]} lo={m.lo} hi={m.hi} unit={m.unit} label={m.label}
                    domainMin={TREND_DOMAIN[m.id] && TREND_DOMAIN[m.id][0]}
                    domainMax={TREND_DOMAIN[m.id] && TREND_DOMAIN[m.id][1]} emptyText={null} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

// ─── Equipment section (Chemistry screen) ────────
// Chlorinator level and filter run times, with the date they were changed, and
// the Copy for agent button. Shown whether or not a test has been loaded.
const EQUIPMENT_EARLIER_SHOWN = 5;
const eqInputStyle = { fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 16, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' };
function fromDateInput(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function EquipmentSection({ history, onSave, onDelete, onCopy }) {
  const list = history || [];
  const current = list.length ? list[list.length - 1] : null;
  const earlier = list.slice(0, -1).reverse();
  const [form, setForm] = React.useState(null); // null while not editing
  const [errMsg, setErrMsg] = React.useState('');
  const errRef = React.useRef(null);
  const pctRef = React.useRef(null);
  const editBtnRef = React.useRef(null);
  const wasEditing = React.useRef(false);
  const today = toLocalInput(Date.now()).slice(0, 10);

  // Focus the first field when the form opens, and the Change button when it closes.
  React.useEffect(() => {
    if (form && !wasEditing.current && pctRef.current) pctRef.current.focus();
    if (!form && wasEditing.current && editBtnRef.current) editBtnRef.current.focus();
    wasEditing.current = !!form;
  }, [form]);

  const startEdit = () => {
    setErrMsg('');
    setForm({
      pct: current ? String(current.chlorinatorPct) : '',
      start: current ? current.filterStart : '',
      end: current ? current.filterEnd : '',
      date: today,
    });
  };
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const failWith = (msg) => {
    setErrMsg(msg);
    setTimeout(() => errRef.current && errRef.current.focus(), 0);
  };

  const save = (e) => {
    e.preventDefault();
    const pct = form.pct.trim() === '' ? NaN : Number(form.pct);
    const start = (form.start || '').slice(0, 5);
    const end = (form.end || '').slice(0, 5);
    const ts = fromDateInput(form.date);
    if (!(pct >= 0 && pct <= 100)) return failWith('Enter a chlorinator level from 0 to 100%');
    if (!HHMM.test(start) || !HHMM.test(end)) return failWith('Enter the times the filter starts and stops');
    if (start === end) return failWith('The filter start and stop times are the same');
    if (ts == null) return failWith('Enter the date you changed the settings');
    if (ts > fromDateInput(today)) return failWith("The date can't be in the future");
    onSave({ ts, chlorinatorPct: Math.round(pct * 10) / 10, filterStart: start, filterEnd: end });
    setForm(null);
  };

  const formStart = form && (form.start || '').slice(0, 5);
  const formEnd = form && (form.end || '').slice(0, 5);
  const runPreview = form && HHMM.test(formStart) && HHMM.test(formEnd) && formStart !== formEnd
    ? 'Runs ' + durationLabel(filterMinutes(formStart, formEnd)) + ' a day' : null;

  return (
    <React.Fragment>
      <div className="sec-head">
        <span id="equipment-head">Equipment</span>
        {!form && (
          <button type="button" ref={editBtnRef} className="link-btn" onClick={startEdit}
            aria-label={current ? 'Change equipment settings' : 'Set equipment settings'}>
            {current ? 'Change' : 'Set up'}
          </button>
        )}
      </div>

      {form ? (
        <form className="log-form" onSubmit={save} aria-labelledby="equipment-head" noValidate>
          <div className="form-field">
            <label className="form-label" htmlFor="eq-pct">Chlorinator output (%)</label>
            <input id="eq-pct" ref={pctRef} type="number" inputMode="decimal" min="0" max="100" step="any" placeholder="e.g. 60"
              value={form.pct} onChange={set('pct')} style={{ ...eqInputStyle, fontWeight: 600 }} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="form-field" style={{ flex: 1, minWidth: 0 }}>
              <label className="form-label" htmlFor="eq-start">Filter starts</label>
              <input id="eq-start" type="time" value={form.start} onChange={set('start')} style={eqInputStyle} />
            </div>
            <div className="form-field" style={{ flex: 1, minWidth: 0 }}>
              <label className="form-label" htmlFor="eq-end">Filter stops</label>
              <input id="eq-end" type="time" value={form.end} onChange={set('end')} style={eqInputStyle} />
            </div>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="eq-date">Changed on</label>
            <input id="eq-date" type="date" max={today} value={form.date} onChange={set('date')} style={eqInputStyle} />
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45, padding: '0 4px 10px' }}>
            {runPreview ? runPreview + '. ' : ''}Saving again for the same date replaces that day's settings.
          </div>
          {errMsg && (
            <div ref={errRef} tabIndex={-1} role="alert"
              style={{ background: 'var(--bad-tint)', color: 'var(--bad)', padding: '10px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 500, marginBottom: 10, border: '1px solid #f4cdd2' }}>
              {errMsg}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => setForm(null)}>Cancel</button>
            <button type="submit" className="btn-primary" style={{ flex: 2 }}>Save settings</button>
          </div>
        </form>
      ) : (
        <div className="metric-card" style={{ marginBottom: 10 }}>
          {current ? (
            <React.Fragment>
              <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                <div style={{ flexShrink: 0 }}>
                  <div className="t-label" style={{ marginBottom: 4 }}>Chlorinator</div>
                  <div className="t-display t-num" style={{ fontSize: 28, color: 'var(--ink)', lineHeight: 1 }}>
                    {current.chlorinatorPct}<span style={{ fontSize: 13, fontWeight: 400, marginLeft: 2, color: 'var(--muted)' }}>%</span>
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="t-label" style={{ marginBottom: 4 }}>Filter pump</div>
                  <div className="t-num" style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.25 }}>
                    {timeLabel(current.filterStart)} – {timeLabel(current.filterEnd)}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                    {durationLabel(filterMinutes(current.filterStart, current.filterEnd))} a day
                  </div>
                </div>
                <button type="button" className="row-del-btn" onClick={() => onDelete(current)}
                  aria-label={'Delete settings from ' + longDate(current.ts)}>×</button>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>Since {longDate(current.ts)}</div>
              {earlier.length > 0 && (
                <div style={{ borderTop: '1px solid var(--hairline-2)', marginTop: 14, paddingTop: 10 }}>
                  <div className="t-label" style={{ marginBottom: 2 }}>Earlier</div>
                  {earlier.slice(0, EQUIPMENT_EARLIER_SHOWN).map(e => (
                    <div key={e.ts} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', minHeight: 44 }}>
                      <div className="t-num" style={{ color: 'var(--muted)', fontSize: 11, fontFamily: 'Geist Mono, ui-monospace, monospace', flexShrink: 0, width: 78 }}>{longDate(e.ts)}</div>
                      <div className="t-num" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.35 }}>
                        {e.chlorinatorPct}% · {timeLabel(e.filterStart)}–{timeLabel(e.filterEnd)} ({durationLabel(filterMinutes(e.filterStart, e.filterEnd))})
                      </div>
                      <button type="button" className="row-del-btn" onClick={() => onDelete(e)}
                        aria-label={'Delete settings from ' + longDate(e.ts)}>×</button>
                    </div>
                  ))}
                  {earlier.length > EQUIPMENT_EARLIER_SHOWN && (
                    <div style={{ color: 'var(--muted)', fontSize: 11.5, paddingTop: 2 }}>
                      {earlier.length - EQUIPMENT_EARLIER_SHOWN} older, included when you copy
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ) : (
            <div style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.5 }}>
              Record your chlorinator level and filter run times. Each change is kept with its date, so your agent can compare the settings with your test results.
            </div>
          )}
        </div>
      )}

      {!form && (
        <div style={{ padding: '0 14px' }}>
          <button type="button" className="btn-secondary" onClick={onCopy}>
            <Icon name="copy" size={15} /> Copy data for agent
          </button>
          <div style={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.45, padding: '8px 4px 0', textAlign: 'center' }}>
            Copies settings, tests, Poolwerx actions and recent activity as text to paste into your agent chat
          </div>
        </div>
      )}
    </React.Fragment>
  );
}

// ─── Log Screen ──────────────────────────────────
// Current time, refreshed every 30s and whenever the app comes back to the
// foreground, so a form that defaults to "now" never shows a stale time.
function useNow(intervalMs) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', tick);
    };
  }, [intervalMs]);
  return now;
}

// <input type="datetime-local"> value for a timestamp, and back. Read with an
// explicit local-time constructor rather than new Date(string), whose reading
// of a date-time with no time zone has not always been local in every browser.
const pad2 = (n) => String(n).padStart(2, '0');
function toLocalInput(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fromLocalInput(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

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

  // null means "now": the field follows the clock until a time is picked, and
  // goes back to following it after each save. It used to be fixed when the
  // tab opened, so an app left on this tab overnight logged the next dose under
  // yesterday's date — and moved routine due dates with it.
  const now = useNow(30000);
  const [pickedTime, setPickedTime] = React.useState(null);
  const datetime = pickedTime || toLocalInput(now);
  const setDatetime = (v) => setPickedTime(v || null);
  // Stop following the clock once the field has focus, so the 30s refresh
  // can't reset a time that is half typed in.
  const pinTime = () => { if (!pickedTime) setPickedTime(datetime); };

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
      onLogEntry({
        type: logType === 'chemical' ? `Added ${amount} ${unit} ${chemical}`
          : logType === 'backwash' ? 'Backwash'
          : logType === 'aiper' ? 'Pool cleaner run'
          : logType === 'watertest' ? 'Water test'
          : notes || 'Note',
        kind: logType,
        ts: (pickedTime && fromLocalInput(pickedTime)) || Date.now(),
        note: logType === 'note' ? '' : notes,
      });
    }
    // Reset form
    setNotes('');
    if (logType === 'chemical') setAmount('');
    setPickedTime(null);
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
              style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 16, fontWeight: 600, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
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
          <input id="log-datetime" type="datetime-local" value={datetime} onFocus={pinTime} onChange={e => setDatetime(e.target.value)}
            style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
        </div>
      </div>
      )}

      {/* Backwash / Pool cleaner / Water test forms */}
      {(logType === 'backwash' || logType === 'aiper' || logType === 'watertest') && (
        <div className="log-form">
          <div className="form-field">
            <label className="form-label" htmlFor="log-datetime-2">Date &amp; Time</label>
            <input id="log-datetime-2" type="datetime-local" value={datetime} onFocus={pinTime} onChange={e => setDatetime(e.target.value)}
              style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="log-notes">Notes (optional)</label>
            <input id="log-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. filter clean, good flow"
              style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
        </div>
      )}

      {/* Note form */}
      {logType === 'note' && (
        <div className="log-form">
          <div className="form-field">
            <label className="form-label" htmlFor="log-note-body">Note</label>
            <textarea id="log-note-body" value={notes} onChange={e => setNotes(e.target.value)} placeholder="What did you observe?"
              rows={3} style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%', resize: 'none', lineHeight: 1.5 }} />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="log-datetime-3">Date &amp; Time</label>
            <input id="log-datetime-3" type="datetime-local" value={datetime} onFocus={pinTime} onChange={e => setDatetime(e.target.value)}
              style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
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
                    <span style={{ display: 'block', fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 13, fontWeight: 500, color: 'var(--ink)', letterSpacing: '-0.005em' }}>{t.label}</span>
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
function History({ onNav, entries: userEntries, onExport, onImport, onDeleteEntry }) {
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
                    <div style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 13.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '-0.005em' }}>{e.type}</div>
                    {e.note && <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>{e.note}</div>}
                  </div>
                  <div className="t-num" style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 400, flexShrink: 0, fontFamily: 'Geist Mono, ui-monospace, monospace' }}>{e.date}</div>
                  {/* A wrong or accidental entry used to be permanent — there was
                      no way to remove one. Deleting offers Undo in the toast. */}
                  {onDeleteEntry && (
                    <button type="button" className="row-del-btn" onClick={() => onDeleteEntry(e)}
                      aria-label={'Delete entry: ' + e.type + ', ' + (e.date || 'no date')}>×</button>
                  )}
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
            style={{ flexShrink: 0, fontFamily: 'Geist Mono, ui-monospace, monospace', fontSize: 13, color: 'var(--accent)', background: 'var(--surface-2)', border: '1px solid var(--hairline-2)', borderRadius: 8, padding: '6px 10px', outline: 'none', appearance: 'none', cursor: 'pointer' }}>
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

const shortDate = (ts) => new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

// Save a backup file. `data` is the saved-state object Import reads back.
function downloadBackup(data) {
  const payload = { app: 'poolDashboard', version: '2.4', exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pool-dashboard-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function waterTestEntry(ts) {
  return {
    type: 'Water test · Poolwerx', kind: 'watertest',
    date: shortDate(ts),
    ts, note: '',
  };
}

// ─── Test history (trends) ──────────────────────
// One point per test day, oldest first: { date, ts, vals: {ph, fcl, …}, lsi }.
// Before 2.7 only pH was kept (phHistory, labels without a year), so the other
// readings had nothing to chart.
const HISTORY_MAX = 24; // about two years of monthly tests

// Add a test, replacing any point already on the same calendar day.
function upsertHistory(history, point) {
  const day = dayStartTs(point.ts);
  const rest = (history || []).filter(p => dayStartTs(p.ts) !== day);
  rest.push(point);
  rest.sort((a, b) => a.ts - b.ts);
  return rest.slice(-HISTORY_MAX);
}

// One metric's readings for TrendChart: the last `limit` tests that have it.
function trendFor(history, id, limit) {
  return (history || [])
    .filter(p => p && p.vals && typeof p.vals[id] === 'number')
    .slice(-(limit || 6))
    .map(p => ({ label: dayLabel(p.ts), val: p.vals[id] }));
}

// The old pH-only list, still saved alongside so that rolling the app back to
// an earlier version keeps a current pH trend.
const phHistoryFrom = (history) => trendFor(history, 'ph', 6);

// Build the history the first time 2.7 loads: the old pH points plus the
// loaded test. A pH label is "4 Sep" with no year, so it gets the latest year
// that doesn't put it after the loaded test (they are the last six tests).
function seedTestHistory(data) {
  let history = [];
  const td = data.testData;
  const refTs = (td && td.date && parseTestDate(td.date)) || Date.now();
  const refYear = new Date(refTs).getFullYear();
  (Array.isArray(data.phHistory) ? data.phHistory : []).forEach(p => {
    const m = p && typeof p.val === 'number' && /^(\d{1,2})\s+([A-Za-z]+)/.exec(String(p.label || ''));
    if (!m) return;
    let year = refYear;
    let ts = parseTestDate(m[1] + ' ' + m[2] + ' ' + year);
    if (ts != null && ts > refTs) ts = parseTestDate(m[1] + ' ' + m[2] + ' ' + (--year));
    if (ts == null) return;
    history = upsertHistory(history, { date: m[1] + ' ' + m[2] + ' ' + year, ts, vals: { ph: p.val }, lsi: null });
  });
  if (td && td.date && Array.isArray(td.metrics)) {
    const ts = parseTestDate(td.date);
    const vals = {};
    td.metrics.forEach(mt => { if (mt && typeof mt.val === 'number') vals[mt.id] = mt.val; });
    if (ts != null && Object.keys(vals).length) {
      history = upsertHistory(history, { date: td.date, ts, vals, lsi: td.lsi != null ? td.lsi : null });
    }
  }
  return history;
}

// Turn a parsePoolwerxPDF() result (or the same shape from PoolSync.classify)
// into the next todos / testData / log / trend history. Pure: no setState, no
// localStorage. Both the file picker and the remote sync slot call this so a
// published JSON report updates the app the same way a PDF does.
//
// opts.allowOlder — manual upload, after the user confirms replacing a newer test.
// opts.skipSameDay — remote only. A report dated the same calendar day as the
// loaded test must not wipe actions already on the list.
function planTestImport(parsed, state, opts) {
  opts = opts || {};
  state = state || {};
  const testData = state.testData || TEST;
  const logEntries = state.logEntries || [];
  const testHistory = state.testHistory || [];

  if (!parsed || ((parsed.metricsParsed || 0) === 0 && (!parsed.recs || parsed.recs.length === 0))) {
    return { applied: false, reason: 'empty' };
  }

  const newTs = parseTestDate(parsed.date);
  const curTs = testData.date ? parseTestDate(testData.date) : null;
  if (newTs && curTs && newTs < curTs && !opts.allowOlder) {
    return { applied: false, reason: 'older', parsedDate: parsed.date, currentDate: testData.date };
  }
  if (opts.skipSameDay && newTs && curTs && newTs === curTs) {
    return { applied: false, reason: 'same-day', parsedDate: parsed.date };
  }

  const vals = { ph: parsed.ph, fcl: parsed.freeCl, ccl: parsed.combCl, salt: parsed.salt, alk: parsed.alk, cah: parsed.caHard, cya: parsed.cya, phos: parsed.phos };
  // Rebuilt from METRIC_DEFS rather than mapped over the persisted metrics.
  // A metric that fails to parse must go to null, not keep last month's reading
  // under this month's date, and target ranges must not stay frozen from the
  // first save.
  const updatedMetrics = METRIC_DEFS.map(def => {
    const v = vals[def.id];
    return v == null
      ? { ...def, val: null, status: 'ok' }
      : { ...def, val: v, status: calcStatus(v, def.lo, def.hi, def.min, def.max) };
  });
  const updated = { ...testData, date: parsed.date, pool: parsed.pool || testData.pool, lsi: parsed.lsi != null ? parsed.lsi : testData.lsi, metrics: updatedMetrics };

  // An imported report IS a water test — log it (once per test date) so the
  // "Get water tested" routine resets from the report's own date. Deduped on
  // the calendar day, not the exact ts.
  const testTs = newTs || Date.now();
  const testDay = new Date(testTs); testDay.setHours(0, 0, 0, 0);
  const nextLog = logEntries.some(en => {
    if (en.kind !== 'watertest' || !en.ts) return false;
    const d = new Date(en.ts); d.setHours(0, 0, 0, 0);
    return d.getTime() === testDay.getTime();
  }) ? logEntries : insertEntrySorted(logEntries, waterTestEntry(testTs));

  // Every reading goes into the trend history, placed by test date, so an
  // older report loaded on purpose lands in the right spot rather than being
  // drawn as the latest point. A report with recommendations but no readings
  // leaves the history alone instead of blanking that day.
  const histVals = {};
  Object.keys(vals).forEach(k => { if (typeof vals[k] === 'number') histVals[k] = vals[k]; });
  const nextHistory = Object.keys(histVals).length
    ? upsertHistory(testHistory, { date: parsed.date, ts: testDay.getTime(), vals: histVals, lsi: parsed.lsi != null ? parsed.lsi : null })
    : testHistory;

  let newTodos = [];
  if (parsed.recs && parsed.recs.length > 0) {
    newTodos = parsed.recs.map((r, i) => {
      // Attribute the action to the metric its own heading names.
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
    newTodos = updatedMetrics.filter(m => m.status !== 'ok').map((m, i) => ({
      id: i + 1, pri: m.status === 'bad' ? 'HIGH' : 'MED',
      label: m.label + ' out of range',
      reason: m.label + ' is ' + m.val + ' · target ' + m.lo + '–' + m.hi + ' ' + m.unit,
      color: m.status === 'bad' ? 'var(--bad)' : 'var(--warn)', done: false,
    }));
  }

  const dateLabel = parsed.date === 'Unknown date' ? 'that report' : parsed.date;
  const toast = (parsed.metricsParsed || 0) < (parsed.metricsTotal || 8)
    ? ('Loaded ' + parsed.metricsParsed + ' of ' + parsed.metricsTotal + ' results from ' + dateLabel + ' — check Chemistry')
    : ('✓ Loaded test from ' + dateLabel);

  return {
    applied: true,
    testData: updated,
    logEntries: nextLog,
    testHistory: nextHistory,
    todos: newTodos,
    toast,
    notify: newTodos.length ? {
      count: newTodos.length,
      label: newTodos[0] && newTodos[0].label,
      date: parsed.date,
    } : null,
  };
}

// ─── Equipment settings ─────────────────────────
// Chlorinator output and filter pump run times, as a dated history (oldest
// first, one setting per calendar day) so each water test can be read against
// the settings that produced it: { ts (local midnight), chlorinatorPct,
// filterStart: 'HH:MM', filterEnd: 'HH:MM' }.
const EQUIPMENT_MAX = 60;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validEquipment(e) {
  return !!e && typeof e.ts === 'number' && Number.isFinite(e.ts) &&
    typeof e.chlorinatorPct === 'number' && e.chlorinatorPct >= 0 && e.chlorinatorPct <= 100 &&
    HHMM.test(e.filterStart || '') && HHMM.test(e.filterEnd || '') && e.filterStart !== e.filterEnd;
}

// Add a setting, replacing any already on the same calendar day, so saving
// twice in a day corrects the entry rather than adding another.
function upsertEquipment(history, setting) {
  const day = dayStartTs(setting.ts);
  const rest = (history || []).filter(e => dayStartTs(e.ts) !== day);
  rest.push({ ...setting, ts: day });
  rest.sort((a, b) => a.ts - b.ts);
  return rest.slice(-EQUIPMENT_MAX);
}

// Minutes the filter runs a day. An end before the start runs past midnight.
function filterMinutes(start, end) {
  const toMin = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
  const diff = toMin(end) - toMin(start);
  return diff > 0 ? diff : diff + 1440;
}

const timeLabel = (s) => {
  const h = +s.slice(0, 2);
  return ((h % 12) || 12) + ':' + s.slice(3, 5) + ' ' + (h < 12 ? 'am' : 'pm');
};
const durationLabel = (min) => Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
const longDate = (ts) => { const d = new Date(ts); return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear(); };

function equipmentText(e) {
  return 'chlorinator ' + e.chlorinatorPct + '%, filter ' + timeLabel(e.filterStart) + '–' + timeLabel(e.filterEnd) +
    ' (' + durationLabel(filterMinutes(e.filterStart, e.filterEnd)) + ' a day)';
}

// The setting that was running when a test was taken: the latest one changed
// before the test day. A change made on the test day itself usually came after
// reading the results, so it is not counted for that test.
function equipmentAt(history, ts) {
  const day = dayStartTs(ts);
  let found = null;
  (history || []).forEach(e => { if (e.ts < day) found = e; });
  return found;
}

// ─── Copy for agent ─────────────────────────────
// Plain text for pasting into an agent chat: the equipment history, each test
// with the settings in effect at the time, the open Poolwerx actions, routines
// and recent activity. Pure, so it can be tested.
const AGENT_TESTS_MAX = 12;
const AGENT_LOG_DAYS = 90;

function agentSummary(state, nowMs) {
  const { testData, testHistory, equipmentHistory, logEntries, todos, routines } = state || {};
  const lines = [];
  const section = (title) => { lines.push('', title); };
  const equipment = (equipmentHistory || []).slice().reverse();

  lines.push('Pool Dashboard data, copied ' + longDate(nowMs) + '.');
  lines.push('Compare the equipment settings with the water test results when making recommendations.');
  if (testData && testData.pool) lines.push('Pool volume: ' + testData.pool);

  section('EQUIPMENT SETTINGS (newest first)');
  if (!equipment.length) lines.push('- Not recorded yet');
  equipment.forEach((e, i) => {
    lines.push('- ' + (i === 0 ? 'Current, since ' : 'From ') + longDate(e.ts) + ': ' + equipmentText(e));
  });

  section('WATER TESTS (newest first, with the settings running before each test)');
  const tests = (testHistory || []).slice(-AGENT_TESTS_MAX).reverse();
  if (!tests.length) lines.push('- No tests yet');
  tests.forEach(p => {
    const vals = METRIC_DEFS
      .filter(d => typeof p.vals[d.id] === 'number')
      .map(d => d.label + ' ' + p.vals[d.id] + (d.unit ? ' ' + d.unit : ''));
    if (p.lsi != null) vals.push('LSI ' + p.lsi);
    const eq = equipmentAt(equipmentHistory, p.ts);
    lines.push('- ' + longDate(p.ts) + ' [' + (eq ? equipmentText(eq) : 'settings not recorded') + ']: ' + vals.join(', '));
  });

  section('TARGET RANGES');
  lines.push(METRIC_DEFS.map(d => d.label + ' ' + d.lo + '–' + d.hi + (d.unit ? ' ' + d.unit : '')).join('; '));

  const open = (todos || []).filter(t => !t.done);
  if (testData && testData.date) {
    section('OPEN POOLWERX ACTIONS (test of ' + testData.date + ')');
    if (!open.length) lines.push('- None');
    open.forEach(t => lines.push('- ' + t.label + (t.reason ? ' (' + t.reason + ')' : '')));
  }

  if ((routines || []).length) {
    section('ROUTINES');
    const RAPI = window.RoutinesAPI;
    routines.forEach(r => lines.push('- ' + r.name + (RAPI ? ': ' + RAPI.recurrenceText(r) : '')));
  }

  section('ACTIVITY, LAST ' + AGENT_LOG_DAYS + ' DAYS (newest first)');
  const since = nowMs - AGENT_LOG_DAYS * 86400000;
  const recent = (logEntries || []).filter(e => e.ts && e.ts >= since && e.ts <= nowMs);
  if (!recent.length) lines.push('- Nothing logged');
  recent.forEach(e => lines.push('- ' + longDate(e.ts) + ': ' + e.type + (e.note ? ' (' + e.note + ')' : '')));

  return lines.join('\n');
}

// Copy text to the clipboard. The async API needs a secure context and can be
// refused, so there is a fallback through a hidden textarea.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the textarea */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS ignores select() alone
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
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
    out.logEntries = out.logEntries
      .filter(e => e && typeof e === 'object')
      .map(e => /aiper|scuba/i.test(e.type || '') ? { ...e, type: renamePoolCleaner(e.type) } : e)
      // Newest first by ts, which lastMatchTs and the History grouping rely
      // on. Entries used to be prepended in the order they were logged, so a
      // back-dated one sat above newer ones. Entries with no ts stay last.
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  if (!Array.isArray(out.testHistory)) {
    out.testHistory = seedTestHistory(out);
  } else {
    out.testHistory = out.testHistory
      .filter(p => p && typeof p.ts === 'number' && p.vals && typeof p.vals === 'object')
      .sort((a, b) => a.ts - b.ts)
      .slice(-HISTORY_MAX);
  }
  // Left absent when missing, so importing an older backup keeps the settings.
  if (Array.isArray(out.equipmentHistory)) {
    out.equipmentHistory = out.equipmentHistory
      .filter(validEquipment)
      .reduce(upsertEquipment, []);
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

// ─── Back button ─────────────────────────────────
// Tabs used to live only in React state, so the phone's Back button closed the
// app from any tab. Home is now the bottom history entry, any other tab sits one
// entry above it (switching between tabs replaces that entry), and the routine
// editor adds one more: Back closes the editor, then returns Home, then leaves.
const SCREENS = ['dashboard', 'chemistry', 'log', 'routines', 'history'];
const screenFromHash = () => {
  const h = (window.location.hash || '').slice(1);
  return SCREENS.includes(h) ? h : 'dashboard';
};

function App() {
  // Read and migrate the saved state once. This used to run on every render,
  // so each tab switch and toast re-parsed everything in localStorage.
  const [persisted] = React.useState(() => migrateData(loadState()));
  const [screen, setScreen] = React.useState(() => {
    const st = window.history.state;
    return st && st.pool && SCREENS.includes(st.screen) ? st.screen : screenFromHash();
  });
  const [todos, setTodos] = React.useState((persisted && persisted.todos) || []);
  const [toast, setToast] = React.useState('');
  const [testData, setTestData] = React.useState((persisted && persisted.testData) || TEST);
  const [uploading, setUploading] = React.useState(false);
  const [logEntries, setLogEntries] = React.useState((persisted && persisted.logEntries) || []);
  const [testHistory, setTestHistory] = React.useState((persisted && persisted.testHistory) || []);
  const [equipmentHistory, setEquipmentHistory] = React.useState((persisted && persisted.equipmentHistory) || []);
  // Routines: seed defaults on first load (persisted may exist without routines field from v3).
  // Rules missing createdTs (pre-v4.1 data) are anchored to now so they don't show as overdue.
  const [routines, setRoutines] = React.useState(() => {
    if (persisted && Array.isArray(persisted.routines)) {
      return persisted.routines.map(r => r.createdTs ? r : { ...r, createdTs: Date.now() });
    }
    return (window.RoutinesAPI && window.RoutinesAPI.seedRoutines()) || [];
  });
  const [editorRule, setEditorRule] = React.useState(null); // null | {} (new) | rule (edit)
  // Report id (or "date:…" when the file has no reportId) last applied from the
  // remote sync slot. Kept with the rest of the state so a reload does not
  // import the same file again.
  const [lastRemoteReportId, setLastRemoteReportId] = React.useState(
    (persisted && persisted.lastRemoteReportId != null && persisted.lastRemoteReportId !== '')
      ? String(persisted.lastRemoteReportId) : null
  );
  const liveRef = React.useRef({});
  const uploadingRef = React.useRef(false);
  const applyRef = React.useRef(function () {});
  const syncNowRef = React.useRef(function () {});
  liveRef.current = { testData, logEntries, testHistory, lastRemoteReportId };

  React.useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        rev: STATE_REV, todos, testData, logEntries, testHistory, phHistory: phHistoryFrom(testHistory), routines, lastRemoteReportId, equipmentHistory,
      }));
    } catch (e) { /* quota / private mode */ }
  }, [todos, testData, logEntries, testHistory, routines, lastRemoteReportId, equipmentHistory]);

  React.useEffect(() => {
    const st = window.history.state;
    if (st && st.pool) {
      // A reload of an entry this app made: keep the stack as it is, but don't
      // come back to an editor entry with no editor open.
      if (st.pool === 'editor') window.history.back();
    } else {
      window.history.replaceState({ pool: 'home', screen: 'dashboard' }, '', window.location.pathname + window.location.search);
      // `screen` is still the first-render value here: the tab named in the URL.
      if (screen !== 'dashboard') window.history.pushState({ pool: 'tab', screen }, '', '#' + screen);
    }
    const onPop = (e) => {
      const s = e.state || {};
      setEditorRule(null);
      setScreen(SCREENS.includes(s.screen) ? s.screen : screenFromHash());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next) => {
    if (next === screen) return;
    const st = window.history.state || {};
    if (next === 'dashboard') {
      if (st.pool === 'tab') window.history.back();
      else window.history.replaceState({ pool: 'home', screen: 'dashboard' }, '', window.location.pathname + window.location.search);
    } else if (st.pool === 'tab') {
      window.history.replaceState({ pool: 'tab', screen: next }, '', '#' + next);
    } else {
      window.history.pushState({ pool: 'tab', screen: next }, '', '#' + next);
    }
    setScreen(next);
  };
  const openEditor = (rule) => {
    window.history.pushState({ pool: 'editor', screen }, '', window.location.href);
    setEditorRule(rule);
  };
  const closeEditor = () => {
    setEditorRule(null);
    if (window.history.state && window.history.state.pool === 'editor') window.history.back();
  };

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
    const RAPI = window.RoutinesAPI;
    const now = Date.now();
    const nextEntries = insertEntrySorted(prevEntries, entry);
    for (const rule of routines) {
      if (!RAPI.matchesRule(rule, entry)) continue;
      // Was it due/overdue before this entry?
      const before = RAPI.ruleStatus(rule, prevEntries, now);
      if (before.status === 'upcoming') continue;
      // Next due with this entry in the log — from the newest matching entry,
      // which is not this one if it was back-dated behind a newer log.
      const nd = new Date(RAPI.ruleStatus(rule, nextEntries, now).dueTs);
      const dow = RAPI.DOW_SHORT[nd.getDay()];
      const dStr = nd.getDate() + ' ' + nd.toLocaleDateString('en-AU', { month: 'short' });
      return '✓ ' + rule.name + ' — next due ' + dow + ' ' + dStr;
    }
    return null;
  };

  // Entries go in by date, not on top: a back-dated one used to sit above
  // newer entries and be read as the last time a routine was done.
  const onLogEntry = (entry) => {
    const ts = entry.ts || Date.now();
    const full = { ...entry, ts, date: shortDate(ts) };
    const smart = buildSmartToast(full, logEntries);
    setLogEntries(prev => insertEntrySorted(prev, full));
    showToast(smart || ('✓ ' + entry.type + ' logged'));
  };
  const fileRef = React.useRef();

  // Undo puts an action back only if the list still belongs to the same test.
  // A new import restarts ids at 1, so an old action could land in, or be
  // blocked by, the new test's list.
  const sameTest = (forTest) => liveRef.current.testData === forTest;

  const onDelete = (id) => {
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) return;
    const removed = todos[idx];
    const forTest = testData;
    setTodos(prev => prev.filter(t => t.id !== id));
    showToast('Action removed', {
      actionLabel: 'Undo',
      onAction: () => {
        if (sameTest(forTest)) {
          setTodos(cur => {
            if (cur.some(t => t.id === removed.id)) return cur;
            const next = cur.slice();
            next.splice(Math.min(idx, next.length), 0, removed);
            return next;
          });
        }
        setToast('');
      },
    });
  };

  // A tap anywhere on an action card marks it done: it is logged, ticked, and
  // dropped from the list. That used to be permanent — now the toast offers
  // Undo, which takes the log entry back out and restores the action.
  const onToggle = (id) => {
    const idx = todos.findIndex(t => t.id === id);
    const item = todos[idx];
    if (!item || item.done) return;
    const ts = Date.now();
    const entry = { type: item.label, kind: 'chemical', date: shortDate(ts), note: item.reason, ts };
    const forTest = testData;
    setTodos(prev => prev.map(t => t.id === id ? { ...t, done: true } : t));
    setLogEntries(le => insertEntrySorted(le, entry));
    const dropTimer = setTimeout(() => setTodos(t => sameTest(forTest) ? t.filter(x => x.id !== id) : t), 700);
    showToast('✓ Logged: ' + item.label, {
      actionLabel: 'Undo',
      onAction: () => {
        clearTimeout(dropTimer);
        setLogEntries(le => le.filter(e => e !== entry));
        if (sameTest(forTest)) {
          setTodos(cur => {
            const next = cur.filter(t => t.id !== id);
            next.splice(Math.min(idx, next.length), 0, { ...item, done: false });
            return next;
          });
        }
        setToast('');
      },
    });
  };

  // Toggle a routine card on the dashboard — equivalent to logging a matching entry now.
  const onRoutineDone = (routineId) => {
    const rule = routines.find(r => r.id === routineId);
    if (!rule) return;
    const ts = Date.now();
    // Build entry that matches this routine's matcher
    const m = rule.match || {};
    const kind = m.logType || 'note';
    const type = kind === 'chemical' ? 'Added ' + (m.chemical || 'chemical')
      : kind === 'aiper' ? 'Pool cleaner run'
      : kind === 'backwash' ? 'Backwash'
      : kind === 'watertest' ? 'Water test'
      : rule.name;
    const entry = { type, kind, date: shortDate(ts), ts, note: 'Marked done from routine' };
    const smart = buildSmartToast(entry, logEntries);
    setLogEntries(le => insertEntrySorted(le, entry));
    showToast(smart || ('✓ ' + rule.name + ' logged'), {
      actionLabel: 'Undo',
      onAction: () => { setLogEntries(le => le.filter(e => e !== entry)); setToast(''); },
    });
  };

  // History delete. Entries are matched by identity, which holds for as long
  // as the toast (and so the Undo) is showing.
  const onDeleteEntry = (entry) => {
    setLogEntries(le => le.filter(e => e !== entry));
    showToast('Entry deleted', {
      actionLabel: 'Undo',
      onAction: () => {
        setLogEntries(le => le.includes(entry) ? le : insertEntrySorted(le, entry));
        setToast('');
      },
    });
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
    closeEditor();
    showToast('✓ Routine saved');
  };
  const onDeleteRoutine = (id) => {
    setRoutines(prev => prev.filter(r => r.id !== id));
    showToast('Routine removed');
  };

  const onSaveEquipment = (setting) => {
    setEquipmentHistory(prev => upsertEquipment(prev, setting));
    showToast('✓ Equipment settings saved');
  };
  const onDeleteEquipment = (entry) => {
    setEquipmentHistory(prev => prev.filter(e => e !== entry));
    showToast('Settings removed', {
      actionLabel: 'Undo',
      onAction: () => {
        setEquipmentHistory(prev => prev.includes(entry) ? prev : upsertEquipment(prev, entry));
        setToast('');
      },
    });
  };
  const onCopyForAgent = async () => {
    const text = agentSummary({ testData, testHistory, equipmentHistory, logEntries, todos, routines }, Date.now());
    const ok = await copyText(text);
    showToast(ok ? '✓ Copied — paste it into your agent chat' : "Couldn't copy on this browser");
  };

  const applyTestPlan = (plan, remoteId) => {
    if (!plan || !plan.applied) return;
    setTestData(plan.testData);
    setLogEntries(plan.logEntries);
    setTestHistory(plan.testHistory);
    setTodos(plan.todos);
    if (remoteId) setLastRemoteReportId(remoteId);
    if (window.PoolNotify && plan.notify) {
      window.PoolNotify.notifyTodos(plan.notify.count, plan.notify.label, plan.notify.date);
    }
    showToast(plan.toast);
  };
  applyRef.current = applyTestPlan;

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) { showToast('Please select a PDF file'); e.target.value = ''; return; }
    uploadingRef.current = true;
    setUploading(true);
    showToast('Reading PDF…');
    try {
      const parsed = await parsePoolwerxPDF(file);
      let plan = planTestImport(parsed, liveRef.current);

      // Nothing recognisable in the file — bail before touching state. Replacing
      // a good test and a live action list with an empty one because the user
      // picked the wrong PDF is not a recoverable mistake.
      if (!plan.applied && plan.reason === 'empty') {
        showToast("Couldn't read that PDF — no results found");
        return;
      }

      // Guard against an older report silently overwriting newer results.
      if (!plan.applied && plan.reason === 'older' &&
          !window.confirm('That report is dated ' + plan.parsedDate + ', which is older than your current test (' + plan.currentDate + ').\n\nLoad it anyway and replace the newer results?')) {
        return;
      }
      if (!plan.applied) plan = planTestImport(parsed, liveRef.current, { allowOlder: true });
      applyTestPlan(plan);
    } catch (err) {
      // Distinguish "the CDN never arrived" from "this PDF isn't a Poolwerx
      // report" — the old message blamed the file for a network failure.
      const msg = err && /pdfjs-(timeout|unreachable)/.test(err.message || '')
        ? 'Could not load the PDF reader — check your connection and try again'
        : 'Could not parse PDF — try another file';
      showToast(msg);
      console.error(err);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      e.target.value = '';
      // A sync that arrived during the parse was skipped; look again now.
      syncNowRef.current();
    }
  };

  // Remote sync slot (schema in sync-report.js). On load and whenever the app
  // is focused: fetch latest.json with cache no-store. Placeholder, 404, an
  // already-applied reportId, or an older test are silent no-ops. A newer
  // report goes through planTestImport — the same writer as a PDF upload.
  // The service worker cannot touch localStorage; if it stashed a pending
  // report in IndexedDB, that is applied here too. Failures never clear state.
  React.useEffect(() => {
    let cancelled = false;
    let running = false;
    let again = false;

    const clearPending = (id) => {
      const core = window.PoolNotifyCore;
      const Sync = window.PoolSync;
      if (!core || !Sync) return Promise.resolve();
      return core.idbGet('pendingRemoteReport').then((v) => {
        if (!v) return;
        const pending = Sync.classifyPending(v);
        if (pending.kind !== 'report') return core.idbSet('pendingRemoteReport', null);
        if (!id || pending.id === id) return core.idbSet('pendingRemoteReport', null);
        if (pending.testedAtMs != null && liveRef.current.testData && liveRef.current.testData.date) {
          const cur = parseTestDate(liveRef.current.testData.date);
          if (cur != null && pending.testedAtMs <= cur) return core.idbSet('pendingRemoteReport', null);
        }
      }).catch((e) => { console.warn('[PoolSync] could not clear pending import', e); });
    };

    const once = async () => {
      const Sync = window.PoolSync;
      if (!Sync || uploadingRef.current) return;
      let pendingRaw = null;
      try {
        if (window.PoolNotifyCore) pendingRaw = await window.PoolNotifyCore.idbGet('pendingRemoteReport');
      } catch (e) {
        console.warn('[PoolSync] pending read failed', e);
      }
      if (cancelled) return;

      let remoteDoc = null;
      let fetchFailed = false;
      try {
        remoteDoc = await Sync.fetchReport();
      } catch (e) {
        fetchFailed = true;
        console.warn('[PoolSync] fetch failed', e);
      }
      if (cancelled || uploadingRef.current) return;

      const remoteClass = fetchFailed ? null : Sync.classify(remoteDoc);
      const pendingClass = Sync.classifyPending(pendingRaw);
      if (remoteClass && remoteClass.kind === 'mismatch') {
        console.warn('[PoolSync] ignored sync file (' + (remoteClass.reason || 'invalid') + ')');
      }

      const remoteOk = remoteClass && remoteClass.kind === 'report' ? remoteClass : null;
      const pendingOk = pendingClass && pendingClass.kind === 'report' ? pendingClass : null;
      // Offline: the stash is all we have. Online: the published file wins ties,
      // and a newer stash (background sync saw a report this fetch missed) still applies.
      const chosen = fetchFailed ? pendingOk : (remoteOk && pendingOk ? Sync.prefer(remoteOk, pendingOk) : (remoteOk || pendingOk));
      if (!chosen) return;

      if (chosen.id && chosen.id === liveRef.current.lastRemoteReportId) {
        await clearPending(chosen.id);
        return;
      }

      const plan = planTestImport(chosen.parsed, liveRef.current, { skipSameDay: true });
      if (cancelled || uploadingRef.current) return;
      if (!plan.applied) {
        if (plan.reason === 'same-day' && chosen.id) setLastRemoteReportId(chosen.id);
        if (plan.reason === 'older' || plan.reason === 'same-day') await clearPending(chosen.id);
        return;
      }

      applyRef.current(plan, chosen.id);
      console.info('[PoolSync] imported ' + chosen.id);
      await clearPending(chosen.id);
    };

    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          await once();
        } while (again && !cancelled);
      } catch (e) {
        console.warn('[PoolSync] import failed', e);
      } finally {
        running = false;
      }
    };

    syncNowRef.current = () => { run(); };
    run();
    const onWake = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      cancelled = true;
      syncNowRef.current = function () {};
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, []);

  const triggerUpload = () => fileRef.current && fileRef.current.click();

  const onExport = () => {
    try {
      downloadBackup({ rev: STATE_REV, todos, testData, logEntries, testHistory, phHistory: phHistoryFrom(testHistory), routines, lastRemoteReportId, equipmentHistory });
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
        const data = migrateData(raw); // old backups: rename Aiper text, seed water-test routine and trend history
        if (Array.isArray(data.todos)) setTodos(data.todos);
        if (data.testData && Array.isArray(data.testData.metrics)) setTestData(data.testData);
        if (Array.isArray(data.logEntries)) setLogEntries(data.logEntries);
        if (Array.isArray(data.testHistory)) setTestHistory(data.testHistory);
        if (Array.isArray(data.equipmentHistory)) setEquipmentHistory(data.equipmentHistory);
        if (Array.isArray(data.routines)) setRoutines(data.routines.map(r => r.createdTs ? r : { ...r, createdTs: Date.now() }));
        if (Object.prototype.hasOwnProperty.call(data, 'lastRemoteReportId')) {
          const id = data.lastRemoteReportId;
          setLastRemoteReportId(id == null || id === '' ? null : String(id));
        }
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
    dashboard: <Dashboard onNav={navigate} todos={todos} onToggle={onToggle} onDelete={onDelete} toast={toast} testData={testData} onUpload={triggerUpload} uploading={uploading} testHistory={testHistory} routines={routines} logEntries={logEntries} onRoutineDone={onRoutineDone} />,
    chemistry: <Chemistry onNav={navigate} testData={testData} onReupload={triggerUpload} testHistory={testHistory}
      equipment={<EquipmentSection history={equipmentHistory} onSave={onSaveEquipment} onDelete={onDeleteEquipment} onCopy={onCopyForAgent} />} />,
    log: <Log onNav={navigate} todos={todos} onToggle={onToggle} testData={testData} onLogEntry={onLogEntry} />,
    routines: window.RoutinesScreen ? <window.RoutinesScreen rules={routines} entries={logEntries} onAdd={() => openEditor({})} onEdit={openEditor} onDelete={onDeleteRoutine} banner={<ReminderToggle />} /> : null,
    history: <History onNav={navigate} entries={logEntries} onExport={onExport} onImport={onImport} onDeleteEntry={onDeleteEntry} />,
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
          onDelete={(id) => { onDeleteRoutine(id); closeEditor(); }}
          onCancel={closeEditor} />
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
              onClick={() => navigate(n.id)}>
              <span className="nav-icon" aria-hidden="true"><Icon name={n.icon} size={19} strokeWidth={screen === n.id ? 1.8 : 1.5} /></span>
              {n.label}
            </button>
          ))}
        </nav>
        {/* The live region stays mounted and empty so swapping its text is what
            gets announced. The Undo button is only rendered (and focusable) while
            a toast is actually showing. */}
        <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
          <span className="toast-msg">{toast && toast.msg}</span>
          {toast && toast.actionLabel && (
            <button type="button" className="toast-action" onClick={toast.onAction}>{toast.actionLabel}</button>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

// ─── Crash screen ────────────────────────────────
// When rendering throws, React unmounts the whole tree and the page goes blank
// — and since the data that caused it is saved, it stayed blank on every open.
// This keeps the saved data reachable: export it, reload, or reset.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[App] crashed', error, info && info.componentStack); }
  render() { return this.state.error ? <CrashScreen error={this.state.error} /> : this.props.children; }
}

function CrashScreen({ error }) {
  const exportSaved = () => {
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { /* storage blocked */ }
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = { unreadable: raw }; }
    downloadBackup(data);
  };
  const reset = () => {
    if (!window.confirm('Reset deletes all pool data saved on this phone. Export it first if you want to keep it.\n\nReset now?')) return;
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* storage blocked */ }
    window.location.reload();
  };
  return (
    <div role="alert" style={{ padding: '56px 20px', textAlign: 'center' }}>
      <h1 className="t-title" style={{ fontSize: 18, color: 'var(--ink)', marginBottom: 8 }}>Something went wrong</h1>
      <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, maxWidth: 320, margin: '0 auto 22px' }}>
        The app hit an error it couldn't recover from. Your data is still saved on this phone. Export a copy before trying anything else.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 280, margin: '0 auto' }}>
        <button type="button" className="btn-primary" onClick={exportSaved}>Export my data</button>
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--hairline)' }}>Reload</button>
        <button type="button" onClick={reset}
          style={{ background: 'transparent', border: 'none', color: 'var(--bad)', fontSize: 12.5, fontWeight: 500, fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', cursor: 'pointer', padding: '10px 16px', minHeight: 44 }}>
          Reset app data…
        </button>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 18, fontFamily: 'Geist Mono, ui-monospace, monospace', wordBreak: 'break-word' }}>
        {'v' + APP_VERSION + ' · ' + String((error && error.message) || error)}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ErrorBoundary><App /></ErrorBoundary>);
