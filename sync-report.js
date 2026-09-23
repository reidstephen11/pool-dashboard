// sync-report.js — remote Poolwerx report slot. Runs in the page and in the
// service worker (importScripts). No DOM, no localStorage.
//
// The app fetches this path relative to its own origin (GitHub Pages project
// subpath included). Do not point it at another host. The long directory name
// is the sync slot; it is intentionally not repeated in the README.
//
// latest.json schema (version 1) — chemistry, report date, recommendations only.
// Never put a customer name, street address, email, or phone in this file.
//
//   {
//     "schema": 1,
//     "reportId": "6457546",          // stable id; null reportId AND testedAt = placeholder no-op
//     "testedAt": "2026-09-04",       // calendar date YYYY-MM-DD, or "4 Sep 2026"
//     "source": "poolwerx-email",     // informational, not shown
//     "publishedAt": "2026-09-04T01:23:45.000Z",  // informational, not used for ordering
//     "metrics": {
//       "ph": 7.4, "freeCl": 3.1, "combCl": 0.2, "salt": 4200,
//       "alk": 100, "caHard": 280, "cya": 50, "phos": 0,
//       "lsi": 0.1, "pool": 40000      // pool is litres
//     },
//     "recs": [
//       { "param": "PH", "action": "Add 200 mL of hydrochloric acid" }
//     ]
//   }
//
// `param` / `action` match parsePoolwerxPDF(). `metric` (id or heading) and
// `text` are accepted aliases. `priority` is ignored: the app derives HIGH/MED
// from metric status the same way a PDF upload does.
//
// classify() maps a document onto the object parsePoolwerxPDF returns:
//   { date, pool, lsi, ph, freeCl, combCl, salt, alk, caHard, cya, phos,
//     recs: [{ action, param }], metricsParsed, metricsTotal }
// planTestImport() in app.jsx is the only writer of that shape into state.
(function () {
  var PATH = 'sync/4e8cb7b87063376d4420d3cc2e3d0ea45f8bf099f26fdbac/latest.json';
  var METRIC_KEYS = ['ph', 'freeCl', 'combCl', 'salt', 'alk', 'caHard', 'cya', 'phos'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Metric ids (and a few headings) → the section heading metricIdForParam()
  // already understands. Order inside that helper matters (COMBINED before
  // CHLORINE); these strings are chosen to hit the right branch.
  var METRIC_TO_PARAM = {
    ph: 'PH',
    freecl: 'CHLORINE',
    fcl: 'CHLORINE',
    combcl: 'COMBINED CHLORINE',
    ccl: 'COMBINED CHLORINE',
    salt: 'SALT',
    alk: 'ALKALINITY',
    cahard: 'CALCIUM HARDNESS',
    cah: 'CALCIUM HARDNESS',
    cya: 'CYANURIC',
    phos: 'PHOSPHATES'
  };

  function syncUrl() {
    var href = (self.location && self.location.href) || '';
    return new URL(PATH, href).href;
  }

  function parseMetricNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    var cleaned = v.replace(/,/g, '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    var n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function formatPool(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return groupLitres(v);
    if (typeof v !== 'string') return '';
    var trimmed = v.trim();
    var labelled = trimmed.match(/(\d[\d,]*)\s*L\b/i);
    if (labelled) return labelled[1] + ' L';
    var n = parseMetricNum(trimmed);
    return n == null ? '' : groupLitres(n);
  }

  function groupLitres(n) {
    var rounded = Math.round(n);
    var digits = String(Math.abs(rounded));
    var out = '';
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
      out += digits.charAt(i);
    }
    return (rounded < 0 ? '-' : '') + out + ' L';
  }

  // Calendar date only. A trailing time is ignored so UTC midnight cannot
  // shift the report into the previous local day.
  function toReportDate(testedAt) {
    if (testedAt == null) return null;
    var s = String(testedAt).trim();
    if (!s) return null;
    var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      var mi = parseInt(iso[2], 10) - 1;
      var day = parseInt(iso[3], 10);
      if (mi < 0 || mi > 11 || day < 1 || day > 31) return null;
      return day + ' ' + MONTHS[mi] + ' ' + iso[1];
    }
    if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(s)) return s;
    return null;
  }

  // Local midnight, same rules as parseTestDate() in app.jsx.
  function reportDateMs(reportDate) {
    var m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec((reportDate || '').trim());
    if (!m) return null;
    var mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    var d = new Date(+m[3], mi, +m[1]);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function mapRec(r) {
    if (!r || typeof r !== 'object') return null;
    var action = r.action != null ? r.action : r.text;
    if (action == null) return null;
    action = String(action).replace(/\s+/g, ' ').trim();
    if (!action) return null;
    var raw = (r.param != null && String(r.param).trim() !== '') ? r.param : r.metric;
    var param = '';
    if (raw != null) {
      var s = String(raw).trim();
      param = METRIC_TO_PARAM[s.toLowerCase()] || s;
    }
    return { action: action, param: param };
  }

  function toParsed(doc, date) {
    var metrics = (doc.metrics && typeof doc.metrics === 'object' && !Array.isArray(doc.metrics))
      ? doc.metrics : {};
    var parsed = {
      date: date,
      pool: formatPool(metrics.pool),
      lsi: parseMetricNum(metrics.lsi),
      recs: [],
      metricsParsed: 0,
      metricsTotal: 8
    };
    for (var i = 0; i < METRIC_KEYS.length; i++) {
      var key = METRIC_KEYS[i];
      parsed[key] = parseMetricNum(metrics[key]);
      if (parsed[key] != null) parsed.metricsParsed++;
    }
    var recs = Array.isArray(doc.recs) ? doc.recs : [];
    for (var j = 0; j < recs.length; j++) {
      var rec = mapRec(recs[j]);
      if (rec) parsed.recs.push(rec);
    }
    if (parsed.metricsParsed === 0 && parsed.recs.length === 0) return null;
    return parsed;
  }

  // { kind: 'empty' | 'mismatch' | 'report', reason?, id?, parsed?, testedAtMs? }
  // empty  — placeholder, 404 body, or a document with no identity (silent no-op)
  // mismatch — looked like a report but schema/date/values are unusable (do not apply)
  // report — safe to hand to planTestImport
  function classify(doc) {
    if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return { kind: 'empty' };
    var hasId = doc.reportId != null && String(doc.reportId).trim() !== '';
    var hasDate = doc.testedAt != null && String(doc.testedAt).trim() !== '';
    if (!hasId && !hasDate) return { kind: 'empty' };
    if (doc.schema !== 1) return { kind: 'mismatch', reason: 'schema' };
    var date = toReportDate(doc.testedAt);
    if (!date) return { kind: 'mismatch', reason: 'testedAt' };
    var parsed = toParsed(doc, date);
    if (!parsed) return { kind: 'mismatch', reason: 'empty-result' };
    var id = hasId ? String(doc.reportId).trim() : ('date:' + String(doc.testedAt).trim());
    return { kind: 'report', id: id, parsed: parsed, testedAtMs: reportDateMs(date) };
  }

  // A pending IndexedDB record is { id, parsed, testedAtMs }, never the raw
  // file, so extra fields on the published JSON (including anything that
  // should not have been committed) are not stored.
  function classifyPending(v) {
    if (!v || typeof v !== 'object') return { kind: 'empty' };
    if (v.parsed && typeof v.parsed === 'object') {
      var rebuilt = toParsed({
        metrics: {
          ph: v.parsed.ph, freeCl: v.parsed.freeCl, combCl: v.parsed.combCl,
          salt: v.parsed.salt, alk: v.parsed.alk, caHard: v.parsed.caHard,
          cya: v.parsed.cya, phos: v.parsed.phos, lsi: v.parsed.lsi,
          pool: v.parsed.pool
        },
        recs: v.parsed.recs
      }, v.parsed.date);
      if (rebuilt && v.id && reportDateMs(rebuilt.date) != null) {
        return {
          kind: 'report',
          id: String(v.id),
          parsed: rebuilt,
          testedAtMs: typeof v.testedAtMs === 'number' ? v.testedAtMs : reportDateMs(rebuilt.date)
        };
      }
    }
    if (v.doc) return classify(v.doc);
    return classify(v);
  }

  // When the network report and a stashed one disagree, the later test wins.
  // A tie keeps `a` (pass the network classification first).
  function prefer(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ta = a.testedAtMs, tb = b.testedAtMs;
    if (ta == null) return tb == null ? a : b;
    if (tb == null) return a;
    return ta >= tb ? a : b;
  }

  function fetchReport() {
    return fetch(syncUrl(), { cache: 'no-store', headers: { 'Accept': 'application/json' } }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('sync-http-' + res.status);
      return res.json();
    });
  }

  self.PoolSync = {
    PATH: PATH,
    url: syncUrl,
    fetchReport: fetchReport,
    classify: classify,
    classifyPending: classifyPending,
    prefer: prefer,
    toReportDate: toReportDate,
    reportDateMs: reportDateMs
  };
})();
