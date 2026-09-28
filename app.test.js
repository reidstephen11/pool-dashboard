// node app.test.js — routine dates, log order and trend history.
// Loads routines.jsx and app.jsx the way the browser does (Babel, react + env)
// with just enough of React and the DOM stubbed out to define their functions.
process.env.TZ = 'Australia/Sydney'; // has daylight saving; set before any Date use
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Babel = require('@babel/standalone');

global.self = global;
global.window = global;
global.document = { getElementById: () => ({}), addEventListener() {}, removeEventListener() {} };
global.React = { createElement: () => null, Component: class {}, Fragment: 'Fragment' };
global.ReactDOM = { createRoot: () => ({ render() {} }) };
const load = (file, exportNames) => {
  const code = Babel.transform(fs.readFileSync(path.join(__dirname, file), 'utf8'), { presets: ['react', 'env'] }).code;
  vm.runInThisContext(code + (exportNames ? '\n;globalThis.__exports = {' + exportNames.join(',') + '};' : ''), { filename: file });
  return global.__exports;
};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'notify-core.js'), 'utf8'));
load('routines.jsx');
const R = window.RoutinesAPI;
const core = self.PoolNotifyCore;
const A = load('app.jsx', ['planTestImport', 'migrateData', 'insertEntrySorted', 'trendFor', 'niceTicks',
  'toLocalInput', 'fromLocalInput', 'parseTestDate', 'phHistoryFrom', 'METRIC_DEFS',
  'upsertEquipment', 'filterMinutes', 'equipmentAt', 'agentSummary']);

const local = (s) => new Date(s).getTime(); // 'YYYY-MM-DDTHH:mm' is local time
const firstReminder = (dueTs, from) => {
  let t = from;
  while (!core.pickDue([{ id: 'x', dueTs }], {}, t, 8).due.length) t += 3600e3;
  return t;
};

// ── Daylight saving: clocks go back in Sydney on Sun 4 Apr 2027 ──
const cleaner = { id: 'c', schedule: { type: 'interval', intervalDays: 4 } };
const acid = { id: 'a', schedule: { type: 'dow', days: [6] } };
let due = R.nextDueTs(cleaner, local('2027-04-02T10:00'), local('2027-04-02T10:00'), true);
assert.strictEqual(due, local('2027-04-06T00:00'), 'every-4-days routine due Tue 6 Apr, not Mon 5 Apr 11pm');
assert.strictEqual(firstReminder(due, local('2027-04-02T10:00')), local('2027-04-06T08:00'));
due = R.nextDueTs(acid, local('2027-04-03T10:00'), local('2027-04-03T10:00'), true);
assert.strictEqual(due, local('2027-04-10T00:00'), 'Saturday routine due at midnight, not 11pm');
assert.strictEqual(firstReminder(due, local('2027-04-03T10:00')), local('2027-04-10T08:00'));
// …and forward on Sun 3 Oct 2027.
due = R.nextDueTs(cleaner, local('2027-10-01T10:00'), local('2027-10-01T10:00'), true);
assert.strictEqual(due, local('2027-10-05T00:00'));
// Early/late weekday logs (PR #5): Friday counts for this Saturday, Sunday for last.
assert.strictEqual(R.nextDueTs(acid, local('2026-09-18T09:00'), local('2026-09-18T09:00'), true), local('2026-09-26T00:00'));
assert.strictEqual(R.nextDueTs(acid, local('2026-09-20T09:00'), local('2026-09-20T09:00'), true), local('2026-09-26T00:00'));
assert.strictEqual(R.addDays(local('2027-04-03T15:00'), 1), local('2027-04-04T00:00'));

// ── Log order: a back-dated entry must not count as the latest ──
const today = { type: 'Backwash', kind: 'backwash', ts: local('2026-09-24T09:00') };
const lastWeek = { type: 'Backwash', kind: 'backwash', ts: local('2026-09-17T09:00') };
let entries = A.insertEntrySorted([today], lastWeek);
assert.deepStrictEqual(entries, [today, lastWeek]);
const backwash = { id: 'b', match: { logType: 'backwash' } };
assert.strictEqual(R.lastMatchTs(backwash, entries), today.ts);
// Lists saved before this fix could have it on top; loading sorts them.
const migrated = A.migrateData({ rev: 1, logEntries: [lastWeek, today, { type: 'Legacy note' }], routines: [] });
assert.deepStrictEqual(migrated.logEntries.map(e => e.ts), [today.ts, lastWeek.ts, undefined]);

// ── datetime-local round trip, read as local time ──
assert.strictEqual(A.toLocalInput(local('2026-09-24T08:05')), '2026-09-24T08:05');
assert.strictEqual(A.fromLocalInput('2026-09-24T08:05'), local('2026-09-24T08:05'));
assert.strictEqual(A.fromLocalInput(''), null);

// ── Trend history ──
const metrics = (vals) => A.METRIC_DEFS.map(d => Object.assign({}, d, { val: vals[d.id] == null ? null : vals[d.id], status: 'ok' }));
// First load of 2.7: the pH-only list (labels without a year) plus the loaded test.
const seeded = A.migrateData({
  rev: 1, routines: [], logEntries: [],
  testData: { date: '4 Sep 2026', lsi: -0.56, metrics: metrics({ ph: 7.2, fcl: 4.43, phos: 2.498 }) },
  phHistory: [{ label: '15 Nov', val: 7.8 }, { label: '2 Jul', val: 7.4 }, { label: '4 Sep', val: 7.2 }],
});
assert.deepStrictEqual(seeded.testHistory.map(p => p.date), ['15 Nov 2025', '2 Jul 2026', '4 Sep 2026']);
assert.deepStrictEqual(seeded.testHistory[2].vals, { ph: 7.2, fcl: 4.43, phos: 2.498 });
assert.deepStrictEqual(A.trendFor(seeded.testHistory, 'ph'), [
  { label: '15 Nov', val: 7.8 }, { label: '2 Jul', val: 7.4 }, { label: '4 Sep', val: 7.2 }]);
assert.deepStrictEqual(A.trendFor(seeded.testHistory, 'phos'), [{ label: '4 Sep', val: 2.498 }]);

const report = (date, vals, recs) => Object.assign({ date, pool: '40,000 L', lsi: 0.1, recs: recs || [],
  metricsParsed: Object.keys(vals).length, metricsTotal: 8 }, vals);
const state = { testData: seeded.testData, logEntries: [], testHistory: seeded.testHistory };
let plan = A.planTestImport(report('2 Oct 2026', { ph: 7.5, freeCl: 3, phos: 0.4 }), state);
assert.ok(plan.applied);
assert.deepStrictEqual(A.trendFor(plan.testHistory, 'phos').map(p => p.val), [2.498, 0.4]);
assert.deepStrictEqual(A.phHistoryFrom(plan.testHistory).map(p => p.label), ['15 Nov', '2 Jul', '4 Sep', '2 Oct']);
// An older report loaded on purpose goes in date order, not at the end.
plan = A.planTestImport(report('1 Aug 2026', { ph: 7.9 }), state, { allowOlder: true });
assert.deepStrictEqual(A.trendFor(plan.testHistory, 'ph').map(p => p.label), ['15 Nov', '2 Jul', '1 Aug', '4 Sep']);
// A report with recommendations but no readings keeps that day's readings.
plan = A.planTestImport(report('4 Sep 2026', {}, [{ param: 'PH', action: 'Add 200 mL of acid' }]), state);
assert.ok(plan.applied);
assert.deepStrictEqual(plan.testHistory, seeded.testHistory);
// The remote sync still skips a report dated the same day as the loaded test.
assert.strictEqual(A.planTestImport(report('4 Sep 2026', { ph: 7.3 }), state, { skipSameDay: true }).reason, 'same-day');

// ── Axis ticks: round numbers, thousands-separated ──
const texts = (min, max) => A.niceTicks(min, max).map(t => t.text);
assert.deepStrictEqual(texts(3380, 5120), ['3,500', '4,000', '4,500', '5,000']);
assert.deepStrictEqual(texts(6.88, 8.62), ['7', '7.5', '8', '8.5']);
assert.deepStrictEqual(texts(0, 2.698), ['0', '1', '2']);
assert.deepStrictEqual(texts(0, 0.216), ['0', '0.1', '0.2']);

// ── Equipment settings ──
assert.strictEqual(A.filterMinutes('09:00', '15:00'), 360);
assert.strictEqual(A.filterMinutes('09:30', '16:15'), 405);
assert.strictEqual(A.filterMinutes('22:00', '06:00'), 480, 'a run past midnight counts to the next morning');
const eq = (date, pct, start, end) => ({ ts: local(date), chlorinatorPct: pct, filterStart: start, filterEnd: end });
let equip = A.upsertEquipment([], eq('2026-09-20T18:30', 40, '09:00', '15:00'));
equip = A.upsertEquipment(equip, eq('2026-08-01T00:00', 60, '08:00', '16:00'));
assert.deepStrictEqual(equip.map(e => e.chlorinatorPct), [60, 40], 'kept in date order');
assert.strictEqual(equip[1].ts, local('2026-09-20T00:00'), 'stored at local midnight');
equip = A.upsertEquipment(equip, eq('2026-09-20T07:00', 45, '09:00', '15:00'));
assert.deepStrictEqual(equip.map(e => e.chlorinatorPct), [60, 45], 'a second save on the same day replaces it');
// The settings running at a test are the ones changed before the test day.
assert.strictEqual(A.equipmentAt(equip, local('2026-09-04T00:00')).chlorinatorPct, 60);
assert.strictEqual(A.equipmentAt(equip, local('2026-09-20T00:00')).chlorinatorPct, 60, 'a change on the test day came after it');
assert.strictEqual(A.equipmentAt(equip, local('2026-09-21T00:00')).chlorinatorPct, 45);
assert.strictEqual(A.equipmentAt(equip, local('2026-07-01T00:00')), null);
// Saved lists are cleaned on load; a backup without the field leaves it out.
const loaded = A.migrateData({ rev: 1, routines: [], equipmentHistory: [
  equip[1], { ts: 'x' }, eq('2026-09-01T00:00', 120, '09:00', '15:00'), eq('2026-09-02T00:00', 50, '9am', '15:00'),
  eq('2026-09-03T00:00', 50, '09:00', '09:00'), equip[0]] });
assert.deepStrictEqual(loaded.equipmentHistory, equip);
assert.strictEqual('equipmentHistory' in A.migrateData({ rev: 1, routines: [] }), false);

// ── Copy for agent ──
const summary = A.agentSummary({
  testData: { date: '4 Sep 2026', pool: '40,000 L' },
  testHistory: [
    { date: '2 Jul 2026', ts: local('2026-07-02T00:00'), vals: { ph: 7.4 }, lsi: null },
    { date: '4 Sep 2026', ts: local('2026-09-04T00:00'), vals: { ph: 7.2, fcl: 4.43 }, lsi: -0.56 },
  ],
  equipmentHistory: equip,
  todos: [{ label: 'Reduce your chlorinator hours/level', reason: 'Free Chlorine is 4.43 · target 2–4 ppm', done: false },
    { label: 'Add 600 g of Sunblock', done: true }],
  routines: [{ name: 'Add 500 mL Hydrochloric Acid', schedule: { type: 'dow', days: [6] } }],
  logEntries: [
    { type: 'Added 500 mL Hydrochloric Acid', ts: local('2026-09-19T09:00') },
    { type: 'Backwash', note: 'good flow', ts: local('2026-09-10T09:00') },
    { type: 'Old note', ts: local('2026-05-01T09:00') },
  ],
}, local('2026-09-27T12:00'));
const has = (line) => assert.ok(summary.split('\n').includes(line), 'missing line: ' + line + '\n---\n' + summary);
has('Pool Dashboard data, copied 27 Sep 2026.');
has('Pool volume: 40,000 L');
has('- Current, since 20 Sep 2026: chlorinator 45%, filter 9:00 am–3:00 pm (6 h a day)');
has('- From 1 Aug 2026: chlorinator 60%, filter 8:00 am–4:00 pm (8 h a day)');
has('- 4 Sep 2026 [chlorinator 60%, filter 8:00 am–4:00 pm (8 h a day)]: pH 7.2, Free Chlorine 4.43 ppm, LSI -0.56');
has('- 2 Jul 2026 [settings not recorded]: pH 7.4');
has('- Reduce your chlorinator hours/level (Free Chlorine is 4.43 · target 2–4 ppm)');
has('- Add 500 mL Hydrochloric Acid: Every Saturday');
has('- 19 Sep 2026: Added 500 mL Hydrochloric Acid');
has('- 10 Sep 2026: Backwash (good flow)');
assert.ok(!/Sunblock/.test(summary), 'a done action is not listed as open');
assert.ok(!/Old note/.test(summary), 'activity older than 90 days is left out');
// Nothing recorded yet still copies something readable.
assert.ok(/- Not recorded yet/.test(A.agentSummary({}, Date.now())));

console.log('app.test.js ok');
