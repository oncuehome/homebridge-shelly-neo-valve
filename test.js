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
