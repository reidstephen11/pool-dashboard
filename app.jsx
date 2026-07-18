// app.jsx — main app. Loads after routines.jsx, which provides the shared
// stroke-icon set and the recurring-rule engine on window.
const Icon = window.Icon;
const KIND_ICON = window.RoutinesAPI.KIND_ICON;
const entryKind = window.RoutinesAPI.entryKind;

// Normalize dose text from the Poolwerx PDF: consistent units ("mls" → "mL").
function normalizeDose(s) {
  return (s || '')
    .replace(/\b(\d+(?:\.\d+)?)\s*mls?\b/gi, '$1 mL')
    .replace(/\b(\d+(?:\.\d+)?)\s*(kg|g|l)\b/g, (m, n, u) => n + ' ' + (u === 'l' ? 'L' : u))
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── PDF Parser (PDF.js) ────────────────────────
async function parsePoolwerxPDF(file) {
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const buf = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let txt = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    txt += content.items.map(item => item.str).join(' ') + '\n';
  }
  console.log('=== PDF RAW TEXT ===\n' + txt + '\n=== END ===');

  // Helper: find value before a label.
  // Poolwerx PDF table reading order is: CURRENT  PREVIOUS  LABEL  RANGE
  // e.g. "7.4  8.1  pH  7.2-7.6"  →  current = 7.4, previous = 8.1
  // We want the FIRST of the two numbers (the current measured value, shown
  // in the colored box on the report).
  const grabBefore = (label) => {
    // Primary: capture both numbers before the label, take the first.
    const rePair = new RegExp('([\\d.]+)\\s+([\\d.]+)\\s+' + label + '\\b', 'i');
    const mPair = txt.match(rePair);
    if (mPair) return parseFloat(mPair[1]);
    // Fallback: only one number before the label.
    const reSingle = new RegExp('([\\d.]+)\\s+' + label + '\\b', 'i');
    const mSingle = txt.match(reSingle);
    if (mSingle) return parseFloat(mSingle[1]);
    // Last resort: number after label.
    const reAfter = new RegExp(label + '[\\s\\S]{0,30}?([\\d.]+)', 'i');
    const mAfter = txt.match(reAfter);
    return mAfter ? parseFloat(mAfter[1]) : null;
  };

  // Parse date
  const dateM = txt.match(/Tested\s+(\d{1,2}\s+\w+\s+\d{4})/i);
  const date = dateM ? dateM[1] : 'Unknown date';

  // Each metric value appears before its label in the Poolwerx PDF table
  const ph     = grabBefore('pH');
  const freeCl = grabBefore('Free Chlorine');
  const combCl = grabBefore('Combined Chlorine');
  const salt   = grabBefore('Salt');
  const alk    = grabBefore('Total Alk');
  const caHard = grabBefore('Calcium Hardness');
  const cya    = grabBefore('Cyanuric Acid');
  const phos   = grabBefore('Phosphates');

  const lsiM = txt.match(/([-\d.]+)\s*LANGELIER/i);
  const lsi  = lsiM ? parseFloat(lsiM[1]) : null;

  const poolM = txt.match(/(\d[\d,]+)\s*L/);
  const pool  = poolM ? poolM[0] : '';

  // Parse RECOMMENDATIONS section — extract "Add X of Y" lines
  const recs = [];
  const recsM = txt.match(/RECOMMENDATIONS?[\s\S]*?(?:ADDITIONAL|PRODUCT|$)/i);
  if (recsM) {
    const recsText = recsM[0];
    // Split into numbered sections: "1 PH", "2 COMBINED CHLORINE", etc.
    const sections = recsText.split(/\b(\d+)\s+([A-Z][A-Z\s]+?)(?=\s*Add|\s*\d+\s+[A-Z])/g);
    // More reliable: just scan for "Add {number}{unit}" patterns — these are the dose lines
    // e.g. "Add 500 mls of Hydrochloric Acid" or "Add 2.2 kg of Vitalyse Calcium Up"
    const doseRe = /Add\s+[\d.]+\s*(?:mls?|g|kg|L|tabs?)\s+of\s+[^.\n]{3,60}/gi;
    const doseLines = recsText.match(doseRe) || [];
    
    // Also try "Add {number}{unit}" without "of"
    const doseRe2 = /Add\s+[\d.]+\s*(?:mls?|g|kg|L|tabs?)[^.\n]{0,50}/gi;
    
    // Pair each dose with its parameter section header
    const sectionBlocks = recsText.split(/(?=\b\d+\s+[A-Z]{2})/);
    sectionBlocks.forEach(block => {
      // Parameter name: first ALL-CAPS word(s) at start of block
      const paramM = block.match(/^\d+\s+([A-Z][A-Z\s]+?)(?:\s+Add|\n)/);
      // Dose: "Add {number} {unit} of {chemical}"
      // Match "Add {qty} {unit} of {product}" — stop before any second verb (Dissolve, Filter, Clean, etc.)
      const raw = block.match(/Add\s+[\d.]+\s*(?:mls?|g|kg|L|tabs?)\s+(?:of\s+)?[A-Za-z][^.\n]{2,60}/i);
      const doseM = raw ? [raw[0].replace(/\s+(Dissolve|Filter|Clean|Backwash|Increase|away|in a bucket|Add\b)[\s\S]*/i, '').trim()] : null;
      if (doseM) {
        recs.push({
          action: doseM[0].trim(),
          param: paramM ? paramM[1].trim() : '',
        });
      }
    });
    
    // Fallback: use the doseRe matches directly
    if (recs.length === 0) {
      doseLines.forEach(a => recs.push({ action: a.trim(), param: '' }));
    }
  }

  return { date, pool, lsi, ph, freeCl, combCl, salt, alk, caHard, cya, phos, recs, raw: txt };
}

// Status helper
function calcStatus(val, lo, hi) {
  if (val === null || val === undefined) return 'ok';
  if (val < lo || val > hi) return 'bad';
  // warn if within 5% of the range width from either boundary
  const margin = (hi - lo) * 0.05;
  if (val < lo + margin || val > hi - margin) return 'warn';
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
function TrendChart({ data, lo, hi, phMin = 7.0, phMax = 8.5 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#b0bac8', fontSize: 12 }}>
        Need at least 2 tests to show a trend
      </div>
    );
  }
  // Normalize: ensure lo <= hi
  if (lo > hi) { const t = lo; lo = hi; hi = t; }

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

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}>
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
          fill={d.val >= lo && d.val <= hi ? '#0f7852' : '#c62436'}
          stroke="#fff" strokeWidth={1.5} />
      ))}

      {/* X labels */}
      {data.map((d, i) => (
        <text key={i} x={px(i)} y={H - 2} textAnchor="middle"
          style={{ fontSize: 9, fontFamily: 'Geist Mono, ui-monospace, monospace', fill: '#8ea1a9', fontWeight: 500, letterSpacing: '0.02em' }}>
          {d.label}
        </text>
      ))}

      {/* Y labels */}
      {ticks.map((v, i) => (
        <text key={i} x={pad.l - 4} y={py(v) + 3} textAnchor="end"
          style={{ fontSize: 8.5, fontFamily: 'Geist Mono, ui-monospace, monospace', fill: '#bccad0' }}>
          {v.toFixed(1)}
        </text>
      ))}

      {/* Target label */}
      <text x={pad.l + cW} y={Math.min(loY, hiY) - 4} textAnchor="end"
        style={{ fontSize: 8.5, fontFamily: 'Geist Mono, ui-monospace, monospace', fill: '#087299', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        target
      </text>
    </svg>
  );
}

// ─── Single todo card (own component so hooks are top-level) ───
function TodoCard({ t, idx, onToggle, onDelete }) {
  const [swipeX, setSwipeX] = React.useState(0);
  const [swiping, setSwiping] = React.useState(false);
  const touchStart = React.useRef(null);
  const THRESHOLD = 60;

  const onTouchStart = (e) => { touchStart.current = e.touches[0].clientX; setSwiping(false); };
  const onTouchMove = (e) => {
    if (touchStart.current === null) return;
    const dx = e.touches[0].clientX - touchStart.current;
    if (dx < -10) { setSwiping(true); setSwipeX(Math.max(-80, dx)); }
  };
  const onTouchEnd = () => {
    if (swipeX < -THRESHOLD) { setSwipeX(-80); }
    else { setSwipeX(0); setSwiping(false); }
    touchStart.current = null;
  };

  return (
    <div className="todo-wrap" style={{ marginBottom: 0 }}>
      {!t.isRoutine && <div className="todo-delete-bg" onClick={() => onDelete(t.id)}>✕</div>}
      <div className={`todo-card fade-up${t.done ? ' done' : ''}`}
        style={{ animationDelay: `${idx * 0.05}s`, transform: `translateX(${swipeX}px)`, transition: swiping ? 'none' : 'transform 0.25s ease' }}
        onClick={() => { if (swipeX < -10) { setSwipeX(0); return; } onToggle(t.id); }}
        onTouchStart={t.isRoutine ? undefined : onTouchStart}
        onTouchMove={t.isRoutine ? undefined : onTouchMove}
        onTouchEnd={t.isRoutine ? undefined : onTouchEnd}>
        <div className="todo-accent" style={{ background: t.color }} />
        <div style={{ marginLeft: 2 }}>
          <div className={`todo-check${t.done ? ' checked' : ''}`}>{t.done ? '✓' : ''}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontFamily: 'Geist Mono, ui-monospace, monospace', color: t.color, fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t.pri}</div>
          </div>
          <div className="t-title" style={{ fontSize: 14.5, color: 'var(--ink)', lineHeight: 1.35 }}>{t.label}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>{t.reason}</div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
          aria-label="Delete action"
          style={{ position: 'absolute', top: 4, right: 4, width: 32, height: 32, border: 'none', background: 'transparent', color: 'var(--faint)', fontSize: 15, cursor: 'pointer', borderRadius: 8, display: t.isRoutine ? 'none' : 'block' }}>×</button>
      </div>
    </div>
  );
}

// ─── Dashboard Screen ────────────────────────────
function Dashboard({ onNav, todos, onToggle, onDelete, toast, testData, onUpload, uploading, phHistory, routines, logEntries, onRoutineDone }) {
  testData = testData || TEST;
  const hasTest = !!testData.date;
  const ph = testData.metrics[0];
  const badCount = testData.metrics.filter(m => m.status !== 'ok').length;

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
              <div className="t-label" style={{ color: 'rgba(234,246,251,0.5)', marginBottom: 8 }}>{hasTest ? 'Last tested · ' + testData.date : 'No test data yet'}</div>
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
            <div style={{ display: 'flex', gap: 18, color: 'rgba(234,246,251,0.55)', fontSize: 12, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
              {testData.lsi != null && <span><span style={{ color: 'rgba(234,246,251,0.4)' }}>LSI </span>{testData.lsi}</span>}
              <span><span style={{ color: 'rgba(234,246,251,0.4)' }}>Salt </span>{testData.metrics[3].status === 'ok' ? 'OK' : testData.metrics[3].val}</span>
              <span><span style={{ color: 'rgba(234,246,251,0.4)' }}>Chlorine </span>{testData.metrics[1].status === 'ok' ? 'OK' : testData.metrics[1].val}</span>
            </div>
          )}

          {/* Upload zone — full size only before the first test is loaded */}
          {!hasTest &&
          <div className="upload-zone" style={{ marginTop: 18, opacity: uploading ? 0.6 : 1 }}
            onClick={onUpload}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="15" height="17" viewBox="0 0 15 17" fill="none"><path d="M2 1h7l4 4v10a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="rgba(234,246,251,0.7)" strokeWidth="1.2"/><path d="M9 1v4h4" stroke="rgba(234,246,251,0.7)" strokeWidth="1.2"/></svg>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: 'var(--hero-fg)', fontFamily: 'Geist', fontWeight: 500, fontSize: 13.5, letterSpacing: '-0.005em' }}>{uploading ? 'Parsing PDF…' : 'Upload Poolwerx Report'}</div>
              <div style={{ color: 'rgba(234,246,251,0.5)', fontSize: 11.5, marginTop: 2 }}>{uploading ? 'Please wait' : 'Tap to import latest test results'}</div>
            </div>
            <div style={{ marginLeft: 'auto', color: 'rgba(234,246,251,0.4)', fontSize: 18, lineHeight: 1 }}>→</div>
          </div>
          }
        </div>
      </div>

      {/* Pills */}
      <div className="pills-row">
        {hasTest ? [
          { label: 'pH ' + testData.metrics[0].val, cls: pillCls(testData.metrics[0].status) },
          { label: 'Cl ' + testData.metrics[1].val, cls: pillCls(testData.metrics[1].status) },
          { label: 'Salt ' + (testData.metrics[3].status === 'ok' ? 'OK' : testData.metrics[3].val), cls: pillCls(testData.metrics[3].status) },
          { label: badCount + ' issue' + (badCount !== 1 ? 's' : ''), cls: badCount > 0 ? 'pill-bad' : 'pill-ok' },
        ].map((p, i) => (
          <div key={i} className={`pill ${p.cls} t-num`} onClick={() => onNav('chemistry')}>{p.label}</div>
        )) : <div style={{ color: 'var(--muted)', fontSize: 12, padding: '4px 4px' }}>Results will appear here after upload</div>}
      </div>

      {/* pH Trend */}
      <div className="sec-head">
        <span>pH Trend · 6 months</span>
        {hasTest && <a onClick={() => onNav('chemistry')}>All metrics →</a>}
      </div>
      {hasTest ? (
      <div className="chart-card fade-up">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 14 }}>
          <div>
            <div className="t-label" style={{ marginBottom: 4 }}>Current pH</div>
            <div className="t-display t-num" style={{ fontSize: 34, color: 'var(--ink)', lineHeight: 1 }}>{ph.val}</div>
          </div>
          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <span className={`badge ${ph.status === 'ok' ? 'badge-ok' : 'badge-bad'}`}>{ph.status === 'ok' ? 'In range' : 'Out of range'}</span>
            <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>Target <span className="t-num">{ph.lo}–{ph.hi}</span></div>
          </div>
        </div>
        <TrendChart data={phHistory || []} lo={ph.lo} hi={ph.hi} />
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

  return (
    <div className="screen">
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div className="t-label" style={{ color: 'rgba(234,246,251,0.5)' }}>Water Chemistry</div>
            {hasTest && (
              <button onClick={onReupload} className="chip-btn" aria-label="Upload a new Poolwerx test PDF"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="upload" size={12} /> New test
              </button>
            )}
          </div>
          <div className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 22, lineHeight: 1.2 }}>{hasTest ? 'Test · ' + testData.date : 'Water Chemistry'}</div>
          {hasTest && <div style={{ color: 'rgba(234,246,251,0.5)', fontSize: 12, marginTop: 4 }}>{testData.pool}</div>}
          {hasTest && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <div style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 999, padding: '4px 11px', color: 'rgba(234,246,251,0.85)', fontSize: 12, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>LSI {testData.lsi}</div>
            <div style={{ background: 'rgba(198,36,54,0.22)', border: '1px solid rgba(198,36,54,0.45)', borderRadius: 999, padding: '4px 11px', color: '#ffc4c4', fontSize: 12, fontWeight: 400 }}>{testData.metrics.filter(m => m.status !== 'ok').length} out of range</div>
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
                <span className={`badge ${badgeCls}`}>{m.status === 'ok' ? 'In range' : m.status === 'warn' ? 'Borderline' : 'Out of range'}</span>
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
  const [showChemPicker, setShowChemPicker] = React.useState(false);
  const [showUnitPicker, setShowUnitPicker] = React.useState(false);
  const [logType, setLogType] = React.useState('chemical'); // chemical | backwash | aiper (pool cleaner) | watertest | note
  const [errMsg, setErrMsg] = React.useState('');

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

  const handleSave = () => {
    setErrMsg('');
    if (logType === 'chemical' && (!amount || parseFloat(amount) <= 0)) {
      setErrMsg('Enter an amount greater than 0');
      return;
    }
    if (logType === 'note' && !notes.trim()) {
      setErrMsg('Add a note before saving');
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
    <div className="screen" onClick={() => { setShowChemPicker(false); setShowUnitPicker(false); }}>
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="t-label" style={{ color: 'rgba(234,246,251,0.5)', marginBottom: 8 }}>Log Activity</div>
          <div className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 24, lineHeight: 1.15 }}>What happened?</div>
          <div style={{ color: 'rgba(234,246,251,0.5)', fontSize: 12.5, marginTop: 6 }}>Record doses, maintenance &amp; notes</div>
        </div>
      </div>

      {/* Type selector */}
      <div className="sec-head" style={{ marginTop: 4 }}><span>What are you logging?</span></div>
      <div className="quick-row">
        {typeButtons.map(b => (
          <div key={b.id} className="quick-btn"
            style={{ background: logType === b.id ? 'var(--ink)' : 'var(--surface)', borderColor: logType === b.id ? 'var(--ink)' : 'var(--hairline)', color: logType === b.id ? '#fff' : 'var(--ink-2)' }}
            onClick={e => { e.stopPropagation(); setLogType(b.id); }}>
            <div className="icon" style={{ opacity: logType === b.id ? 1 : 0.85, display: 'flex' }}><Icon name={KIND_ICON[b.id]} size={17} /></div>
            {b.label}
          </div>
        ))}
      </div>

      {/* Chemical form */}
      {logType === 'chemical' && (
      <div className="log-form">
        {/* Chemical picker */}
        <div style={{ position: 'relative' }}>
          <div className="form-field" onClick={e => { e.stopPropagation(); setShowChemPicker(v => !v); setShowUnitPicker(false); }} style={{ cursor: 'pointer' }}>
            <div className="form-label">Chemical</div>
            <div className="form-select">
              <div className="form-val">{chemical}</div>
              <div className="chevron">{showChemPicker ? '▴' : '▾'}</div>
            </div>
          </div>
          {showChemPicker && (
            <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--hairline)', borderRadius: 12, boxShadow: '0 12px 32px rgba(12,12,13,0.10)', zIndex: 100, overflow: 'hidden' }}>
              {chemicals.map(c => (
                <div key={c} style={{ padding: '12px 14px', borderBottom: '1px solid var(--hairline-2)', cursor: 'pointer', fontFamily: 'Geist', fontSize: 14, fontWeight: c === chemical ? 500 : 400, color: c === chemical ? 'var(--accent)' : 'var(--ink)', background: c === chemical ? 'var(--accent-tint)' : 'transparent', letterSpacing: '-0.005em' }}
                  onClick={() => { setChemical(c); setShowChemPicker(false); }}>
                  {c}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Amount + Unit */}
        <div style={{ display: 'flex', gap: 10 }}>
          <div className="form-field" style={{ flex: 2 }}>
            <div className="form-label">Amount</div>
            <input value={amount} onChange={e => setAmount(e.target.value)} type="number" inputMode="decimal" placeholder="0"
              style={{ fontFamily: 'Geist', fontSize: 16, fontWeight: 600, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
          <div style={{ position: 'relative', flex: 1 }}>
            <div className="form-field" onClick={e => { e.stopPropagation(); setShowUnitPicker(v => !v); setShowChemPicker(false); }} style={{ cursor: 'pointer' }}>
              <div className="form-label">Unit</div>
              <div className="form-select">
                <div className="form-val">{unit}</div>
                <div className="chevron">{showUnitPicker ? '▴' : '▾'}</div>
              </div>
            </div>
            {showUnitPicker && (
              <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--hairline)', borderRadius: 12, boxShadow: '0 12px 32px rgba(12,12,13,0.10)', zIndex: 100, overflow: 'hidden' }}>
                {units.map(u => (
                  <div key={u} style={{ padding: '11px 14px', borderBottom: '1px solid var(--hairline-2)', cursor: 'pointer', fontFamily: 'Geist', fontSize: 14, fontWeight: u === unit ? 500 : 400, color: u === unit ? 'var(--accent)' : 'var(--ink)', background: u === unit ? 'var(--accent-tint)' : 'transparent', letterSpacing: '-0.005em' }}
                    onClick={() => { setUnit(u); setShowUnitPicker(false); }}>
                    {u}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="form-field">
          <div className="form-label">Date &amp; Time</div>
          <input type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)}
            style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
        </div>
      </div>
      )}

      {/* Backwash / Pool cleaner / Water test forms */}
      {(logType === 'backwash' || logType === 'aiper' || logType === 'watertest') && (
        <div className="log-form">
          <div className="form-field">
            <div className="form-label">Date &amp; Time</div>
            <input type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)}
              style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
          <div className="form-field">
            <div className="form-label">Notes (optional)</div>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. filter clean, good flow"
              style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
        </div>
      )}

      {/* Note form */}
      {logType === 'note' && (
        <div className="log-form">
          <div className="form-field">
            <div className="form-label">Note</div>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="What did you observe?"
              rows={3} style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%', resize: 'none', lineHeight: 1.5 }} />
          </div>
          <div className="form-field">
            <div className="form-label">Date &amp; Time</div>
            <input type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)}
              style={{ fontFamily: 'Geist', fontSize: 14, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>
        </div>
      )}

      <div style={{ padding: '8px 14px 0' }}>
        {errMsg && (
          <div style={{ background: 'var(--bad-tint)', color: 'var(--bad)', padding: '10px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 500, marginBottom: 10, border: '1px solid #f4cdd2' }}>
            {errMsg}
          </div>
        )}
        <button className="btn-primary" style={{ marginBottom: 16 }} onClick={handleSave}>
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
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < pending.length - 1 ? '1px solid var(--hairline-2)' : 'none', cursor: 'pointer' }}
                  onClick={() => onToggle(t.id)}>
                  <div className="todo-check" style={{ minWidth: 22 }}></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'Geist', fontSize: 13, fontWeight: 500, color: 'var(--ink)', letterSpacing: '-0.005em' }}>{t.label}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>{t.reason}</div>
                  </div>
                  <div style={{ fontFamily: 'Geist Mono, ui-monospace, monospace', color: t.color, fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t.pri}</div>
                </div>
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
              <div className="t-label" style={{ color: 'rgba(234,246,251,0.5)', marginBottom: 8 }}>History</div>
              <div className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 24, lineHeight: 1.15 }}>Activity log</div>
              <div style={{ color: 'rgba(234,246,251,0.5)', fontSize: 12.5, marginTop: 6 }}>Doses, runs, observations</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button onClick={onExport} className="chip-btn">↓ Export</button>
              <button onClick={() => fileRef.current && fileRef.current.click()} className="chip-btn">↑ Import</button>
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
function ReminderToggle() {
  const [state, setState] = React.useState('loading'); // loading|off|on|denied|unsupported
  const [bg, setBg] = React.useState(false);           // background sync granted?

  React.useEffect(() => {
    let alive = true;
    const PN = window.PoolNotify;
    if (!PN || !PN.supported()) { setState('unsupported'); return; }
    if (PN.permission() === 'denied') { setState('denied'); return; }
    PN.isEnabled().then(on => { if (alive) setState(on ? 'on' : 'off'); });
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
    <div className="card" style={{ padding: '14px 16px', marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
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
    if (window.PoolNotify) window.PoolNotify.resume();
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
      const vals = { ph: parsed.ph, fcl: parsed.freeCl, ccl: parsed.combCl, salt: parsed.salt, alk: parsed.alk, cah: parsed.caHard, cya: parsed.cya, phos: parsed.phos };
      const updatedMetrics = testData.metrics.map(m => {
        const v = vals[m.id];
        if (v === null || v === undefined) return m;
        return { ...m, val: v, status: calcStatus(v, m.lo, m.hi) };
      });
      const updated = { ...testData, date: parsed.date, pool: parsed.pool || testData.pool, lsi: parsed.lsi != null ? parsed.lsi : testData.lsi, metrics: updatedMetrics };
      setTestData(updated);
      // An imported report IS a water test — log it (once per test date) so the
      // "Get water tested" routine resets from the report's own date.
      const testTs = parseTestDate(parsed.date) || Date.now();
      setLogEntries(prev => prev.some(e => e.kind === 'watertest' && e.ts === testTs)
        ? prev : insertEntrySorted(prev, waterTestEntry(testTs)));
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
          // Match rec to a metric to get priority colour
          const metric = updatedMetrics.find(m => m.status !== 'ok' && (
            r.param.toLowerCase().includes(m.label.toLowerCase().split(' ')[0]) ||
            r.action.toLowerCase().includes(m.label.toLowerCase().split(' ')[0])
          ));
          const status = metric ? metric.status : 'bad';
          return {
            id: i + 1,
            pri: status === 'bad' ? 'HIGH' : 'MED',
            label: normalizeDose(r.action),
            reason: metric ? (metric.label + ' is ' + metric.val + ' · target ' + metric.lo + '–' + metric.hi + ' ' + metric.unit) : r.param,
          color: status === 'bad' ? '#c62436' : '#a15c00',
            done: false,
          };
        });
      } else {
        // No recommendations parsed — fall back to out-of-range metric list
        newTodos = updatedMetrics.filter(m => m.status !== 'ok').map((m, i) => ({
          id: i + 1, pri: m.status === 'bad' ? 'HIGH' : 'MED',
          label: m.label + ' out of range',
          reason: m.label + ' is ' + m.val + ' · target ' + m.lo + '–' + m.hi + ' ' + m.unit,
          color: m.status === 'bad' ? '#c62436' : '#a15c00', done: false,
        }));
      }
      setTodos(newTodos);
      console.log('Recs parsed:', parsed.recs);
      console.log('Todos built:', newTodos);
      if (window.PoolNotify && newTodos.length) {
        window.PoolNotify.notifyTodos(newTodos.length, newTodos[0] && newTodos[0].label, parsed.date);
      }
      showToast('✓ Loaded test from ' + parsed.date);
    } catch (err) {
      showToast('Could not parse PDF — try another file');
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', background: 'var(--bg)' }}>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {screens[screen]}
        </div>
        <nav className="bottom-nav">
          {navItems.map(n => (
            <button key={n.id} type="button"
              className={`nav-item${screen === n.id ? ' active' : ''}`}
              aria-current={screen === n.id ? 'page' : undefined}
              onClick={() => setScreen(n.id)}>
              <div className="nav-icon"><Icon name={n.icon} size={19} strokeWidth={screen === n.id ? 1.8 : 1.5} /></div>
              {n.label}
            </button>
          ))}
        </nav>
        <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
          {toast && toast.msg}
          {toast && toast.actionLabel && (
            <button className="toast-action" onClick={toast.onAction}>{toast.actionLabel}</button>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
