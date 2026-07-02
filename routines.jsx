// routines.jsx — recurring rule engine + Routines screen
// Loaded as a Babel script before the main app file.

// ─── Icon set (single stroke family — replaces all emoji) ───
const ICON_PATHS = {
  home:    <g><path d="M3.5 9.5 10 3.5l6.5 6" /><path d="M5.5 8.6V15.2a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8.6" /></g>,
  flask:   <g><path d="M8.2 3h3.6" /><path d="M8.8 3v4.4L4.6 14.3a1.6 1.6 0 0 0 1.4 2.4h8a1.6 1.6 0 0 0 1.4-2.4L11.2 7.4V3" /><path d="M6.3 12.2h7.4" /></g>,
  plus:    <g><path d="M10 4.5v11" /><path d="M4.5 10h11" /></g>,
  repeat:  <g><path d="M15.4 8.3a5.7 5.7 0 0 0-10.3-1.5" /><path d="M4.7 3.7v3.4h3.4" /><path d="M4.6 11.7a5.7 5.7 0 0 0 10.3 1.5" /><path d="M15.3 16.3v-3.4h-3.4" /></g>,
  list:    <g><path d="M7.5 5.5h8.5" /><path d="M7.5 10h8.5" /><path d="M7.5 14.5h8.5" /><path d="M4 5.5h.01" /><path d="M4 10h.01" /><path d="M4 14.5h.01" /></g>,
  droplet: <g><path d="M10 3.2s4.8 5.3 4.8 8.3a4.8 4.8 0 0 1-9.6 0C5.2 8.5 10 3.2 10 3.2z" /></g>,
  bot:     <g><rect x="4" y="7" width="12" height="8.5" rx="2" /><path d="M10 4.6V7" /><path d="M10 3.6h.01" /><path d="M7.4 10.6h.01" /><path d="M12.6 10.6h.01" /><path d="M8 13h4" /></g>,
  pencil:  <g><path d="M4 16l.9-3.6 8.5-8.5a1.5 1.5 0 0 1 2.1 2.1l-8.5 8.5L4 16z" /><path d="M12.2 5.1l2.1 2.1" /></g>,
  upload:  <g><path d="M10 13V4.5" /><path d="M6.5 8 10 4.5 13.5 8" /><path d="M4 15.5h12" /></g>,
};

function Icon({ name, size = 20, strokeWidth = 1.5, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }} aria-hidden="true">
      {ICON_PATHS[name] || ICON_PATHS.pencil}
    </svg>
  );
}

// Log-entry kind → icon name. Kinds: chemical | backwash | aiper | note
const KIND_ICON = { chemical: 'flask', backwash: 'droplet', aiper: 'bot', note: 'pencil' };

// Resolve an entry's kind; falls back to legacy emoji/type for old persisted data.
function entryKind(entry) {
  if (!entry) return 'note';
  if (entry.kind) return entry.kind;
  const emoji = { '🧪': 'chemical', '🔄': 'backwash', '🤖': 'aiper', '✏️': 'note' };
  if (entry.icon && emoji[entry.icon]) return emoji[entry.icon];
  const t = entry.type || '';
  if (/added|acid|chlorine|shock/i.test(t)) return 'chemical';
  if (/backwash/i.test(t)) return 'backwash';
  if (/aiper/i.test(t)) return 'aiper';
  return 'note';
}

const ruleKind = (rule) => (rule && rule.match && rule.match.logType) || 'note';

const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DOW_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_INITIAL= ['S','M','T','W','T','F','S'];

const SEED_ROUTINES = [
  {
    id: 'r-acid',
    name: 'Add 500 mL Hydrochloric Acid',
    schedule: { type: 'dow', days: [6] }, // Saturday
    match:    { logType: 'chemical', chemical: 'Hydrochloric Acid' },
  },
  {
    id: 'r-aiper',
    name: 'Run Aiper Scuba',
    schedule: { type: 'interval', intervalDays: 4 },
    match:    { logType: 'aiper' },
  },
  {
    id: 'r-backwash',
    name: 'Backwash filter',
    schedule: { type: 'interval', intervalDays: 30 },
    match:    { logType: 'backwash' },
  },
];

// Fresh copies of the seed rules anchored to "now", so a first run shows them
// as upcoming rather than instantly overdue.
function seedRoutines() {
  const now = Date.now();
  return SEED_ROUTINES.map(r => ({ ...r, createdTs: now }));
}

// ─── Date helpers ─────────────────────────────────
const DAY_MS = 86400000;
function dayStart(ts) { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function dayDiff(a, b) { return Math.round((dayStart(a) - dayStart(b)) / DAY_MS); }

// ─── Matching log entries against a rule ──────────
function matchesRule(rule, entry) {
  const m = rule.match || {};
  if (!entry) return false;
  const kind = entryKind(entry);
  if (m.logType === 'chemical') {
    if (kind !== 'chemical' && !/added/i.test(entry.type || '')) return false;
    if (!m.chemical) return true;
    return (entry.type || '').toLowerCase().includes(m.chemical.toLowerCase());
  }
  if (m.logType === 'aiper')    return kind === 'aiper' || /aiper/i.test(entry.type || '');
  if (m.logType === 'backwash') return kind === 'backwash' || /backwash/i.test(entry.type || '');
  if (m.logType === 'note')     return entry.kind === 'note' || entry.icon === '✏️';
  return false;
}

// Find timestamp of most recent matching log entry (entries newest-first)
function lastMatchTs(rule, entries) {
  for (const e of entries) {
    if (e && e.ts && matchesRule(rule, e)) return e.ts;
  }
  return null;
}

// Compute next-due timestamp (day-precision) given last-done ts
function nextDueTs(rule, lastTs, nowMs) {
  const today = dayStart(nowMs);
  if (!rule || !rule.schedule) return today;

  if (rule.schedule.type === 'interval') {
    const n = Math.max(1, rule.schedule.intervalDays || 7);
    if (!lastTs) return today;
    return dayStart(lastTs) + n * DAY_MS;
  }

  if (rule.schedule.type === 'dow') {
    const days = rule.schedule.days || [];
    if (days.length === 0) return today;
    // Start searching from day after lastDone, or from 6 days ago if never logged.
    let cursor = lastTs ? dayStart(lastTs) + DAY_MS : today - 6 * DAY_MS;
    for (let i = 0; i < 21; i++) {
      const dow = new Date(cursor).getDay();
      if (days.includes(dow)) return cursor;
      cursor += DAY_MS;
    }
    return today;
  }

  return today;
}

function ruleStatus(rule, entries, nowMs) {
  const lastTs = lastMatchTs(rule, entries);
  // Never-logged rules anchor to their creation date so they start "upcoming",
  // not instantly overdue on first run.
  const anchor = lastTs != null ? lastTs : (rule.createdTs || null);
  const dueTs  = nextDueTs(rule, anchor, nowMs);
  const diff   = dayDiff(nowMs, dueTs); // positive = overdue, 0 = due today, negative = upcoming
  let status;
  if (diff > 0) status = 'overdue';
  else if (diff === 0) status = 'due';
  else status = 'upcoming';
  return { status, dueTs, lastTs, daysOver: diff };
}

// ─── Text helpers ─────────────────────────────────
function recurrenceText(rule) {
  if (!rule || !rule.schedule) return '';
  if (rule.schedule.type === 'dow') {
    const days = (rule.schedule.days || []).slice().sort();
    if (days.length === 0) return 'No days set';
    if (days.length === 7) return 'Every day';
    if (days.length === 1) return 'Every ' + DOW_LABELS[days[0]];
    return days.map(d => DOW_SHORT[d]).join(' · ');
  }
  if (rule.schedule.type === 'interval') {
    const n = rule.schedule.intervalDays || 7;
    return 'Every ' + n + ' day' + (n !== 1 ? 's' : '');
  }
  return '';
}

function dueText(state, nowMs) {
  if (state.status === 'overdue') {
    return state.daysOver === 1 ? 'Overdue 1 day' : 'Overdue ' + state.daysOver + ' days';
  }
  if (state.status === 'due') return 'Due today';
  const d = -state.daysOver;
  if (d === 1) return 'Tomorrow';
  if (d <= 6) {
    const dow = new Date(state.dueTs).getDay();
    return DOW_SHORT[dow] + ' · in ' + d + 'd';
  }
  return 'In ' + d + ' days';
}

function shortDueChipText(state) {
  if (state.status === 'overdue') return 'overdue ' + state.daysOver + 'd';
  if (state.status === 'due') return 'due today';
  const d = -state.daysOver;
  if (d === 1) return 'due tomorrow';
  if (d <= 6) return 'due ' + DOW_SHORT[new Date(state.dueTs).getDay()];
  return 'due in ' + d + 'd';
}

function lastDoneText(state, nowMs) {
  if (!state.lastTs) return 'never logged';
  const d = dayDiff(nowMs, state.lastTs);
  if (d === 0) return 'done today';
  if (d === 1) return 'done yesterday';
  return 'done ' + d + 'd ago';
}

// Convert a routine + state into a Dashboard-list todo card
function routineToTodo(rule, state) {
  let color, pri;
  const over = state.daysOver;
  if (state.status === 'overdue' && over >= 4) {
    color = 'oklch(0.55 0.19 25)';            // red
    pri = 'OVERDUE ' + over + 'D';
  } else if (state.status === 'overdue' && over >= 2) {
    color = 'oklch(0.62 0.14 70)';            // amber
    pri = 'OVERDUE ' + over + 'D';
  } else if (state.status === 'overdue') {
    color = 'oklch(0.55 0.06 240)';           // slate
    pri = 'ROUTINE · OVERDUE';
  } else {
    color = 'oklch(0.55 0.06 240)';           // slate (due)
    pri = 'ROUTINE';
  }
  return {
    id: 'rt-' + rule.id,
    routineId: rule.id,
    isRoutine: true,
    pri, color,
    label: rule.name,
    reason: recurrenceText(rule) + ' · ' + lastDoneText(state, Date.now()),
    done: false,
  };
}

// ─── Routines screen ──────────────────────────────
function RoutinesScreen({ rules, entries, onAdd, onEdit, onDelete }) {
  const now = Date.now();
  const enriched = rules.map(r => ({ r, s: ruleStatus(r, entries, now) }));
  // Sort: most overdue first → due → upcoming (soonest first)
  enriched.sort((a, b) => b.s.daysOver - a.s.daysOver);

  return (
    <div className="screen">
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="t-label" style={{ color: 'rgba(246,245,242,0.5)', marginBottom: 8 }}>Routines</div>
              <div className="t-display" style={{ color: 'var(--hero-fg)', fontSize: 24, lineHeight: 1.15 }}>Recurring tasks</div>
              <div style={{ color: 'rgba(246,245,242,0.5)', fontSize: 12.5, marginTop: 6 }}>Rules watch your log and remind you</div>
            </div>
            <button onClick={onAdd} className="chip-btn" style={{ flexShrink: 0 }}>+ New rule</button>
          </div>
        </div>
      </div>

      <div style={{ padding: '16px 14px 100px' }}>
        {enriched.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
            <div className="t-title" style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 6 }}>No routines yet</div>
            <div style={{ fontSize: 12.5, marginBottom: 18 }}>Add a rule like "500ml acid every Saturday".</div>
            <button onClick={onAdd} className="btn-primary" style={{ maxWidth: 220, margin: '0 auto' }}>+ Add a routine</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {enriched.map(({ r, s }) => (
              <RoutineCard key={r.id} rule={r} state={s} onEdit={onEdit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusAccent(state) {
  if (state.status === 'overdue' && state.daysOver >= 4) return { c: 'oklch(0.55 0.19 25)', bg: 'var(--bad-tint)', label: 'OVERDUE ' + state.daysOver + 'D' };
  if (state.status === 'overdue' && state.daysOver >= 2) return { c: 'oklch(0.62 0.14 70)', bg: 'var(--warn-tint)', label: 'OVERDUE ' + state.daysOver + 'D' };
  if (state.status === 'overdue')                        return { c: 'oklch(0.55 0.06 240)', bg: 'oklch(0.965 0.012 240)', label: 'OVERDUE' };
  if (state.status === 'due')                            return { c: 'oklch(0.55 0.06 240)', bg: 'oklch(0.965 0.012 240)', label: 'DUE TODAY' };
  return { c: 'var(--muted)', bg: 'var(--surface-2)', label: 'UPCOMING' };
}

function RoutineCard({ rule, state, onEdit }) {
  const acc = statusAccent(state);
  return (
    <div className="card fade-up" role="button" tabIndex={0}
      onClick={() => onEdit(rule)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(rule); } }}
      style={{ padding: '14px 16px', position: 'relative', cursor: 'pointer' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--hairline-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-2)', flexShrink: 0 }}>
          <Icon name={KIND_ICON[ruleKind(rule)]} size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ background: acc.bg, color: acc.c, fontFamily: 'Geist Mono, ui-monospace, monospace', fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999, whiteSpace: 'nowrap' }}>{acc.label}</span>
          </div>
          <div className="t-title" style={{ fontSize: 14.5, color: 'var(--ink)', lineHeight: 1.3 }}>{rule.name}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
            {recurrenceText(rule)} · <span style={{ color: 'var(--ink-2)' }}>{dueText(state, Date.now())}</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2, fontFamily: 'Geist Mono, ui-monospace, monospace' }}>
            {lastDoneText(state, Date.now())}
          </div>
        </div>
        <div aria-hidden="true" style={{ color: 'var(--faint)', fontSize: 16, alignSelf: 'center' }}>›</div>
      </div>
    </div>
  );
}

// ─── Add / Edit sheet ─────────────────────────────
function RoutineEditor({ initial, onSave, onCancel, onDelete }) {
  const [name, setName]         = React.useState(initial?.name || '');
  const [logType, setLogType]   = React.useState(initial?.match?.logType || 'chemical');
  const [chemical, setChemical] = React.useState(initial?.match?.chemical || 'Hydrochloric Acid');
  const [schedType, setSched]   = React.useState(initial?.schedule?.type || 'dow');
  const [days, setDays]         = React.useState(initial?.schedule?.days || [6]);
  const [interval, setInt]      = React.useState(initial?.schedule?.intervalDays || 7);

  const chemicals = ['Hydrochloric Acid', 'Non Chlorine Shock', 'Calcium Up', 'Sunblock', 'Algaecide', 'Clarifier', 'Chlorine', 'Other'];

  const toggleDay = (d) => {
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort());
  };

  const save = () => {
    const id = initial?.id || ('r-' + Date.now().toString(36));
    let finalName = name.trim();
    if (!finalName) {
      finalName = logType === 'chemical' ? 'Add ' + chemical : (logType === 'aiper' ? 'Run Aiper Scuba' : logType === 'backwash' ? 'Backwash filter' : 'Routine');
    }
    const rule = {
      id, name: finalName,
      createdTs: initial?.createdTs || Date.now(),
      schedule: schedType === 'dow' ? { type: 'dow', days } : { type: 'interval', intervalDays: Math.max(1, parseInt(interval, 10) || 7) },
      match: logType === 'chemical' ? { logType, chemical } : { logType },
    };
    onSave(rule);
  };

  const remove = () => {
    if (initial && window.confirm('Delete this routine? This cannot be undone.')) {
      onDelete(initial.id);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(12,12,13,0.55)', zIndex: 200, display: 'flex', alignItems: 'flex-end', animation: 'fadeUp 0.18s ease both' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', width: '100%', borderRadius: '20px 20px 0 0', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 -8px 30px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '14px 18px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--hairline)' }}>
          <div className="t-title" style={{ fontSize: 16 }}>{initial ? 'Edit routine' : 'New routine'}</div>
          <button onClick={onCancel} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 20, cursor: 'pointer', padding: 4 }}>×</button>
        </div>

        <div style={{ padding: 16 }}>
          {/* Name */}
          <div className="form-field">
            <div className="form-label">Name</div>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. 500ml acid"
              style={{ fontFamily: 'Geist', fontSize: 15, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%' }} />
          </div>

          {/* Match type */}
          <div className="form-field">
            <div className="form-label">What counts as done?</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginTop: 6 }}>
              {[
                { id: 'chemical', label: 'Chemical' },
                { id: 'aiper',    label: 'Aiper' },
                { id: 'backwash', label: 'Backwash' },
                { id: 'note',     label: 'Note' },
              ].map(o => (
                <button key={o.id} onClick={() => setLogType(o.id)}
                  style={{ background: logType === o.id ? 'var(--ink)' : 'var(--surface)', color: logType === o.id ? '#fff' : 'var(--ink-2)', border: '1px solid', borderColor: logType === o.id ? 'var(--ink)' : 'var(--hairline)', borderRadius: 10, padding: '8px 4px', fontSize: 11.5, fontWeight: 500, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <Icon name={KIND_ICON[o.id]} size={16} />{o.label}
                </button>
              ))}
            </div>
          </div>

          {logType === 'chemical' && (
            <div className="form-field">
              <div className="form-label">Chemical</div>
              <select value={chemical} onChange={e => setChemical(e.target.value)}
                style={{ fontFamily: 'Geist', fontSize: 15, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: '100%', appearance: 'none', cursor: 'pointer' }}>
                {chemicals.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          )}

          {/* Schedule type */}
          <div className="form-field">
            <div className="form-label">When?</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {[
                { id: 'dow', label: 'On certain days' },
                { id: 'interval', label: 'Every N days' },
              ].map(o => (
                <button key={o.id} onClick={() => setSched(o.id)}
                  style={{ flex: 1, background: schedType === o.id ? 'var(--ink)' : 'var(--surface)', color: schedType === o.id ? '#fff' : 'var(--ink-2)', border: '1px solid', borderColor: schedType === o.id ? 'var(--ink)' : 'var(--hairline)', borderRadius: 10, padding: '10px 8px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {schedType === 'dow' ? (
            <div className="form-field">
              <div className="form-label">Days of week</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 5, marginTop: 6 }}>
                {DOW_INITIAL.map((l, i) => {
                  const on = days.includes(i);
                  return (
                    <button key={i} onClick={() => toggleDay(i)}
                      style={{ aspectRatio: '1', background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)', border: '1px solid', borderColor: on ? 'var(--ink)' : 'var(--hairline)', borderRadius: 10, fontFamily: 'Geist', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      {l}
                    </button>
                  );
                })}
              </div>
              <div style={{ color: 'var(--faint)', fontSize: 11, marginTop: 8, fontFamily: 'Geist Mono, ui-monospace, monospace' }}>
                {days.length === 0 ? 'pick at least one' : days.map(d => DOW_SHORT[d]).join(', ')}
              </div>
            </div>
          ) : (
            <div className="form-field">
              <div className="form-label">Every</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <input type="number" min={1} max={365} value={interval} onChange={e => setInt(e.target.value)}
                  style={{ fontFamily: 'Geist', fontSize: 22, fontWeight: 600, color: 'var(--ink)', border: 'none', background: 'none', outline: 'none', width: 70 }} />
                <span style={{ color: 'var(--muted)', fontSize: 14 }}>day{(parseInt(interval, 10) || 1) !== 1 ? 's' : ''} since last log</span>
              </div>
            </div>
          )}

          <button onClick={save} className="btn-primary" style={{ marginTop: 12 }}
            disabled={schedType === 'dow' && days.length === 0}>
            {initial ? 'Save changes' : 'Add routine'}
          </button>
          {initial && (
            <div style={{ textAlign: 'center', marginTop: 14, paddingBottom: 6 }}>
              <button onClick={remove}
                style={{ background: 'transparent', border: 'none', color: 'var(--bad)', fontSize: 12.5, fontWeight: 500, fontFamily: 'Geist, sans-serif', cursor: 'pointer', padding: '8px 14px' }}>
                Delete routine
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Upcoming chips strip (Dashboard) ─────────────
function UpcomingChips({ rules, entries, onNav }) {
  const now = Date.now();
  const upcoming = rules
    .map(r => ({ r, s: ruleStatus(r, entries, now) }))
    .filter(({ s }) => s.status === 'upcoming')
    .sort((a, b) => a.s.daysOver - b.s.daysOver); // closer to due first (less negative)
  // Take just nearest 3
  const shown = upcoming.slice(-3).reverse();
  if (shown.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 6, padding: '4px 18px 0', flexWrap: 'wrap' }}>
      {shown.map(({ r, s }) => (
        <div key={r.id} onClick={onNav} style={{
          background: 'var(--surface)', border: '1px dashed var(--hairline)',
          borderRadius: 999, padding: '4px 10px 4px 8px',
          fontFamily: 'Geist', fontSize: 11.5, color: 'var(--muted)',
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        }}>
          <span style={{ color: 'var(--muted)', display: 'inline-flex' }}><Icon name={KIND_ICON[ruleKind(r)]} size={12} /></span>
          <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{r.name.replace(/^(Add\s+)?\d+(?:\.\d+)?\s*(mL|ml|L|g|kg)\s*(of\s+)?/i, '')}</span>
          <span style={{ color: 'var(--muted)', fontFamily: 'Geist Mono, ui-monospace, monospace', fontSize: 10 }}>
            {shortDueChipText(s)}
          </span>
        </div>
      ))}
    </div>
  );
}

window.RoutinesAPI = {
  SEED_ROUTINES, seedRoutines, DOW_LABELS, DOW_SHORT, DOW_INITIAL,
  matchesRule, lastMatchTs, nextDueTs, ruleStatus,
  recurrenceText, dueText, lastDoneText, shortDueChipText, routineToTodo, dayDiff,
  entryKind, ruleKind, KIND_ICON,
};
window.RoutinesScreen = RoutinesScreen;
window.RoutineEditor  = RoutineEditor;
window.UpcomingChips  = UpcomingChips;
window.Icon           = Icon;
