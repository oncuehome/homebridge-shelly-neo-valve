const assert = require('assert');
const { parseComponents } = require('./index.js');
const c = (key, role, value, id) => ({ key, config: { id }, attrs: { role }, status: { value } });
const r = parseComponents({ components: [
  c('boolean:200', 'state', true, 200), c('number:200', 'flow_rate', 0.012, 200),
  c('number:201', 'water_pressure', 312.5, 201), c('number:202', 'water_temperature', 18.4, 202),
  { key: 'object:200', attrs: { role: 'water_consumption' }, status: { value: {} } } ] });
assert.strictEqual(r.open, true);
assert.strictEqual(Math.round(r.flowLpm), 12);
assert.strictEqual(r.pressureBar, 3.125);
assert.strictEqual(r.temperatureC, 18.4);
assert.throws(() => parseComponents({ components: [] }));
console.log('ok');

// Digest auth against a mock Shelly that checks the SHA-256 response the way a device does.
const http = require('http'), crypto = require('crypto');
const { digestHeader } = require('./index.js');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const srv = http.createServer((req, res) => {
  const a = req.headers.authorization;
  const ok = a && (() => { const p = {}; for (const m of a.matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) p[m[1]] = m[3] ?? m[2];
    const exp = sha(`${sha('admin:neo:secret')}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${sha(`${req.method}:${p.uri}`)}`);
    return p.username === 'admin' && p.response === exp; })();
  if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth", realm="neo", nonce="abc123", algorithm=SHA-256' }); return res.end(); }
  res.end('{"ok":true}');
});
srv.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}/rpc/x`;
  const first = await fetch(url);
  assert.strictEqual(first.status, 401);
  const good = await fetch(url, { headers: { Authorization: digestHeader(first.headers.get('www-authenticate'), 'admin', 'secret', 'GET', '/rpc/x') } });
  assert.strictEqual(good.status, 200);
  const bad = await fetch(url, { headers: { Authorization: digestHeader(first.headers.get('www-authenticate'), 'admin', 'wrong', 'GET', '/rpc/x') } });
  assert.strictEqual(bad.status, 401);
  console.log('digest ok'); srv.close();
});

// Snapshot recorder and the gauge pressure rule.
const { gaugeBar } = require('./index.js');
const { Recorder } = require('./recorder.js');
const fs = require('fs'), os = require('os'), path = require('path');
// no flow: the valve shows absolute pressure, so the atmosphere is subtracted
assert.strictEqual(gaugeBar(4.55, 0), 3.537);
assert.strictEqual(gaugeBar(4.55, 0, 0.95), 3.6);
// water flowing: the reading is used as it is
assert.strictEqual(gaugeBar(3.4, 12), 3.4);
// never negative, and nonsense gives null
assert.strictEqual(gaugeBar(0.5, 0), 0);
assert.strictEqual(gaugeBar(undefined, 0), null);
// consumption comes through in litres
const withTotal = parseComponents({ components: [
  c('boolean:200', 'state', true, 200), c('number:200', 'flow_rate', 0, 200), c('number:201', 'water_pressure', 455, 201), c('number:202', 'water_temperature', 13.4, 202),
  { key: 'object:200', attrs: { role: 'water_consumption' }, status: { value: { counter: { total: 0.016277263 } } } } ] });
assert.strictEqual(Math.round(withTotal.consumptionL * 1000) / 1000, 16.277);
assert.strictEqual(r.consumptionL, null);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-'));
const file = path.join(dir, 'sub', 'v.json');
let clock = new Date('2026-11-11T12:00:00Z');
const rec = new Recorder({ file, device: { name: 'V', host: 'h' }, maxRows: 3, now: () => clock });
const reading = (over) => ({ open: true, flowLpm: 0, pressureBar: 4.55, temperatureC: 13.4, consumptionL: 16.277, ...over });
rec.observe(reading());
let row = rec.snapshot(true);
assert.strictEqual(row.ok, true);
assert.strictEqual(row.pressure_bar, 3.537);          // gauge at no flow
assert.strictEqual(row.pressure_bar_raw, 4.55);        // raw kept
assert.strictEqual(row.used_l, null);                  // no earlier total to compare with
// ten minutes later: a fill happened (peak flow 11.5 L/min, 30 L used), flow back to 0 at the snapshot
clock = new Date('2026-11-11T12:10:00Z');
rec.observe(reading({ flowLpm: 11.5, pressureBar: 3.4, consumptionL: 40 }));
rec.observe(reading({ flowLpm: 0, consumptionL: 46.277 }));
row = rec.snapshot(true);
assert.strictEqual(row.flow_peak_lpm, 11.5);
assert.strictEqual(row.used_l, 30);
// the valve unreachable: a gap row, no invented numbers
clock = new Date('2026-11-11T12:20:00Z');
row = rec.snapshot(false);
assert.deepStrictEqual(Object.keys(row).sort(), ['ok', 't']);
// a counter that went down was reset: count from zero
clock = new Date('2026-11-11T12:30:00Z');
rec.observe(reading({ consumptionL: 2 }));
row = rec.snapshot(true);
assert.strictEqual(row.used_l, 2);
// only maxRows kept, written atomically, and reloaded by a restart
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.strictEqual(saved.history.length, 3);
assert.strictEqual(saved.schema, 1);
assert.strictEqual(saved.latest.valve_open, true);
assert.ok(!fs.existsSync(`${file}.tmp`));
assert.ok(!/password/i.test(JSON.stringify(saved)));
const again = new Recorder({ file, device: { name: 'V', host: 'h' }, maxRows: 3, now: () => clock });
assert.strictEqual(again.history.length, 3);
assert.strictEqual(again.lastTotalL, 2);
fs.rmSync(dir, { recursive: true });
console.log('recorder ok');

// ---- long-running rules
const { RunTracker } = require('./longrun.js');
const MIN = 60000;
{
  const t = new RunTracker({ alertMinutes: 30, shutOffMinutes: 90 });
  let s = t.update(0, 0, 100);
  assert.deepStrictEqual([s.active, s.alert, s.shutOff], [false, false, false]);
  s = t.update(1 * MIN, 8, 100.2);                      // a tap goes on
  assert.strictEqual(s.active, true);
  s = t.update(20 * MIN, 8, 250);
  assert.strictEqual(s.alert, false);                    // 19 minutes: not yet
  s = t.update(31 * MIN, 8, 340);
  assert.strictEqual(s.alert, true);                     // 30 minutes: alert
  assert.strictEqual(s.shutOff, false);
  assert.ok(Math.abs(s.litres - 239.8) < 0.2, `litres ${s.litres}`);   // from the valve's counter
  s = t.update(92 * MIN, 8, 830);
  assert.strictEqual(s.shutOff, true);                   // 90 minutes: shut off
  // flow stops: still the same run for a short grace, then it ends and everything clears
  s = t.update(92.5 * MIN, 0, 830);
  assert.strictEqual(s.active, true);
  s = t.update(94 * MIN, 0, 830);
  assert.deepStrictEqual([s.active, s.ended, s.alert, s.shutOff], [false, true, false, false]);
}
{
  // a blip of zero between polls does not split a run
  const t = new RunTracker({ alertMinutes: 10 });
  t.update(0, 5, null); t.update(5 * MIN, 5, null);
  let s = t.update(5.5 * MIN, 0, null);
  assert.strictEqual(s.active, true);
  s = t.update(6 * MIN, 5, null);
  s = t.update(11 * MIN, 5, null);
  assert.strictEqual(s.alert, true);
  assert.ok(Math.abs(s.litres - 55) < 6, `integrated litres ${s.litres}`);   // no counter: flow x time
}
{
  // litres limit, and 0 means off
  const t = new RunTracker({ alertMinutes: 0, alertLitres: 100 });
  t.update(0, 10, 0); t.update(5 * MIN, 10, 50);
  assert.strictEqual(t.update(9 * MIN, 10, 90).alert, false);
  assert.strictEqual(t.update(11 * MIN, 10, 110).alert, true);
  const off = new RunTracker({ alertMinutes: 0, alertLitres: 0 });
  off.update(0, 10, 0);
  assert.strictEqual(off.update(500 * MIN, 10, 5000).alert, false);
  // a drip below the threshold is not a run
  const drip = new RunTracker({ alertMinutes: 1 });
  drip.update(0, 0.02, 0);
  assert.strictEqual(drip.update(30 * MIN, 0.02, 1).active, false);
}
console.log('longrun ok');

// ---- the per-poll "now" file and per-day totals
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'neo2-'));
  const f2 = path.join(d2, 'v.json');
  let ck = new Date('2026-11-11T12:00:00Z');
  const r2 = new Recorder({ file: f2, device: { name: 'V', host: 'h' }, now: () => ck });
  const rd = (o) => ({ open: true, flowLpm: 0, pressureBar: 4.5, temperatureC: 13, consumptionL: 100, ...o });
  r2.observe(rd(), { minutes: 12.5, litres: 90, alert: false });
  const nowDoc = JSON.parse(fs.readFileSync(path.join(d2, 'v.now'), 'utf8'));
  assert.strictEqual(nowDoc.latest.pressure_bar, 3.487);
  assert.deepStrictEqual(nowDoc.latest.run, { minutes: 12.5, litres: 90, alert: false });
  assert.ok(!fs.existsSync(f2));                          // the history file is only written at a snapshot
  r2.snapshot(true);
  ck = new Date('2026-11-11T12:10:00Z');
  r2.observe(rd({ consumptionL: 130, pressureBar: 3.9, flowLpm: 6 }));
  r2.snapshot(true);
  ck = new Date('2026-11-12T08:00:00Z');
  r2.observe(rd({ consumptionL: 150 }));
  r2.snapshot(true);
  const doc = JSON.parse(fs.readFileSync(f2, 'utf8'));
  assert.strictEqual(doc.days['2026-11-11'].l, 30);
  assert.strictEqual(doc.days['2026-11-12'].l, 20);
  assert.strictEqual(doc.days['2026-11-11'].pmin, 3.487);
  assert.strictEqual(doc.days['2026-11-11'].pn, 2);
  // an older file with no (or the old kind of) days is rebuilt from its rows
  const old = JSON.parse(JSON.stringify(doc)); old.days = { '2026-11-11': 30 };
  fs.writeFileSync(f2, JSON.stringify(old));
  const r3 = new Recorder({ file: f2, device: { name: 'V', host: 'h' }, now: () => ck });
  assert.strictEqual(r3.days['2026-11-11'].l, 30);
  // days older than keepDays are dropped
  const r4 = new Recorder({ file: path.join(d2, 'w.json'), device: { name: 'V', host: 'h' }, keepDays: 2, now: () => ck });
  for (const day of ['08', '09', '10', '11']) { ck = new Date(`2026-11-${day}T12:00:00Z`); r4.observe(rd()); r4.snapshot(true); }
  assert.deepStrictEqual(Object.keys(r4.days).sort(), ['2026-11-10', '2026-11-11']);
  fs.rmSync(d2, { recursive: true });
  console.log('now file and days ok');
}

// --- valve alarm limits (limits.js) ---
{
  const { planLimits, describeLimits } = require('./limits.js');
  const assert2 = require('assert');
  const cur = { alarm_temp_range: [3, 50], alarm_pressure_range: [100, 550], alarm_flow_rate_range: [75, 110] };
  assert2.deepStrictEqual(planLimits({}, cur), { changes: {}, notes: [] });
  assert2.deepStrictEqual(planLimits({ limitPressureMinBar: 1.5 }, cur).changes, { alarm_pressure_range: [150, 550] });
  assert2.deepStrictEqual(planLimits({ limitTempMin: 3, limitTempMax: 50 }, cur).changes, {});
  assert2.ok(planLimits({ limitFlowMin: 100, limitFlowMax: 90 }, cur).notes[0].includes('must be below'));
  assert2.ok(planLimits({ limitPressureMaxBar: 50 }, cur).notes[0].includes('outside'));
  assert2.ok(planLimits({ limitTempMin: 5 }, {}).notes[0].includes('could not be read'));
  assert2.strictEqual(describeLimits(cur), 'temperature 3 to 50 C, pressure 1 to 5.5 bar, flow 75 to 110 L/min');
  console.log('ok limits');
}
