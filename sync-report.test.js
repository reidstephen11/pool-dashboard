// node sync-report.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.self = global;
eval(fs.readFileSync(path.join(__dirname, 'sync-report.js'), 'utf8'));
const S = self.PoolSync;

function report(over) {
  return Object.assign({
    schema: 1,
    reportId: '6457546',
    testedAt: '2026-09-04',
    source: 'poolwerx-email',
    publishedAt: '2026-09-04T01:23:45.000Z',
    metrics: {
      ph: 7.4, freeCl: 3.1, combCl: 0.2, salt: 4200,
      alk: 100, caHard: 280, cya: 50, phos: 0, lsi: 0.1, pool: 40000
    },
    recs: [{ metric: 'ph', text: 'Add 200 mL of hydrochloric acid', priority: 'HIGH' }]
  }, over || {});
}

const placeholder = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'sync/4e8cb7b87063376d4420d3cc2e3d0ea45f8bf099f26fdbac/latest.json'), 'utf8'));
assert.strictEqual(S.classify(placeholder).kind, 'empty');
assert.strictEqual(S.classify(null).kind, 'empty');
assert.strictEqual(S.classify({}).kind, 'empty');

const c = S.classify(report());
assert.strictEqual(c.kind, 'report');
assert.strictEqual(c.id, '6457546');
assert.strictEqual(c.parsed.date, '4 Sep 2026');
assert.strictEqual(c.parsed.ph, 7.4);
assert.strictEqual(c.parsed.freeCl, 3.1);
assert.strictEqual(c.parsed.combCl, 0.2);
assert.strictEqual(c.parsed.salt, 4200);
assert.strictEqual(c.parsed.alk, 100);
assert.strictEqual(c.parsed.caHard, 280);
assert.strictEqual(c.parsed.cya, 50);
assert.strictEqual(c.parsed.phos, 0);
assert.strictEqual(c.parsed.lsi, 0.1);
assert.strictEqual(c.parsed.pool, '40,000 L');
assert.strictEqual(c.parsed.metricsParsed, 8);
assert.strictEqual(c.parsed.metricsTotal, 8);
assert.deepStrictEqual(c.parsed.recs, [{ action: 'Add 200 mL of hydrochloric acid', param: 'PH' }]);
assert.strictEqual(c.parsed.priority, undefined);
assert.ok(!JSON.stringify(c.parsed).includes('HIGH'));

// Parser-native rec shape, numeric report id, comma-grouped salt, date spelling.
const native = S.classify(report({
  reportId: 6457546,
  testedAt: '4 September 2026',
  metrics: { salt: '4,200', ph: 7.2 },
  recs: [{ param: 'COMBINED CHLORINE', action: 'Add 100 mls of shock' }]
}));
assert.strictEqual(native.id, '6457546');
assert.strictEqual(native.parsed.date, '4 September 2026');
assert.strictEqual(native.parsed.salt, 4200);
assert.strictEqual(native.parsed.metricsParsed, 2);
assert.strictEqual(native.parsed.recs[0].param, 'COMBINED CHLORINE');

// Metric ids land on headings metricIdForParam already matches.
const ids = S.classify(report({
  recs: [
    { metric: 'freeCl', text: 'Reduce chlorinator' },
    { metric: 'combCl', text: 'Shock' },
    { metric: 'caHard', text: 'Add calcium' },
    { metric: 'alk', text: 'Add buffer' },
    { metric: 'cya', text: 'Add stabiliser' },
    { metric: 'phos', text: 'Add phosphate remover' },
    { metric: 'salt', text: 'Add salt' }
  ]
}));
assert.deepStrictEqual(ids.parsed.recs.map(r => r.param), [
  'CHLORINE', 'COMBINED CHLORINE', 'CALCIUM HARDNESS', 'ALKALINITY', 'CYANURIC', 'PHOSPHATES', 'SALT'
]);

// Identity-only placeholder fields, and documents that must not apply.
assert.strictEqual(S.classify(report({ schema: 2 })).kind, 'mismatch');
assert.strictEqual(S.classify(report({ testedAt: 'yesterday' })).kind, 'mismatch');
assert.strictEqual(S.classify(report({ metrics: {}, recs: [] })).kind, 'mismatch');
assert.strictEqual(S.classify(report({ reportId: null, testedAt: null })).kind, 'empty');

// Stray contact fields on a published file are not copied into the parsed result.
const dirty = S.classify(report({
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '0400000000',
  address: '1 Harbour Street'
}));
const dumped = JSON.stringify(dirty.parsed);
assert.ok(!dumped.includes('Ada'));
assert.ok(!dumped.includes('example.com'));
assert.ok(!dumped.includes('0400'));
assert.ok(!dumped.includes('Harbour'));

const pending = S.classifyPending({
  id: '6457546',
  testedAtMs: c.testedAtMs,
  parsed: Object.assign({}, c.parsed, { email: 'ada@example.com', name: 'Ada' })
});
assert.strictEqual(pending.kind, 'report');
assert.ok(!JSON.stringify(pending.parsed).includes('ada@'));
assert.ok(!JSON.stringify(pending.parsed).includes('Ada'));

const older = S.classify(report({ reportId: '1', testedAt: '2026-08-01' }));
const newer = S.classify(report({ reportId: '2', testedAt: '2026-09-04' }));
assert.strictEqual(S.prefer(older, newer).id, '2');
assert.strictEqual(S.prefer(newer, older).id, '2');
assert.strictEqual(S.prefer(newer, newer).id, '2');

assert.strictEqual(S.PATH, 'sync/4e8cb7b87063376d4420d3cc2e3d0ea45f8bf099f26fdbac/latest.json');
self.location = { href: 'https://reidstephen11.github.io/pool-dashboard/index.html' };
assert.strictEqual(S.url(), 'https://reidstephen11.github.io/pool-dashboard/' + S.PATH);
self.location = { href: 'https://reidstephen11.github.io/pool-dashboard/sw.js' };
assert.strictEqual(S.url(), 'https://reidstephen11.github.io/pool-dashboard/' + S.PATH);
assert.ok(S.fetchReport.toString().includes('no-store'));

const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
assert.ok(!readme.includes('4e8cb7b87063376d4420d3cc2e3d0ea45f8bf099f26fdbac'), 'README must not advertise the sync token');
assert.ok(readme.includes('Remote sync'));

const placeholderText = fs.readFileSync(
  path.join(__dirname, 'sync/4e8cb7b87063376d4420d3cc2e3d0ea45f8bf099f26fdbac/latest.json'), 'utf8');
assert.ok(!placeholderText.includes('@'));
assert.ok(!/04\d{8}/.test(placeholderText));

console.log('sync-report.test.js ok');
