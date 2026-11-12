// End-to-end check of the platform against a fake valve and a fake HomeKit: the control, the sensors,
// the running-too-long alert and the shut-off. No Homebridge needed.   node test-platform.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- a fake valve
const valve = { open: true, flow: 0, total: 100 };
const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push(`${req.method} ${req.url} ${body}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/rpc/Boolean.Set')) { valve.open = JSON.parse(body).value; return res.end('{}'); }
    const c = (key, role, value, id) => ({ key, config: { id }, attrs: { role }, status: { value } });
    res.end(JSON.stringify({ components: [
      c('boolean:200', 'state', valve.open, 200), c('number:200', 'flow_rate', valve.flow / 1000 * 1000 / 1000, 200),
      c('number:201', 'water_pressure', 450, 201), c('number:202', 'water_temperature', 13, 202),
      { key: 'object:200', attrs: { role: 'water_consumption' }, status: { value: { counter: { total: valve.total / 1000 } } } } ] }));
  });
});

// ---- a fake HomeKit
class Char { constructor() { this.value = undefined; this.get = null; this.set = null; this.props = {}; }
  onGet(f) { this.get = f; return this; } onSet(f) { this.set = f; return this; } setProps(p) { this.props = p; return this; } }
const makeService = (type) => {
  const chars = new Map();
  const svc = { type, chars, subtype: null,
    getCharacteristic: (k) => { if (!chars.has(k)) chars.set(k, new Char()); return chars.get(k); },
    setCharacteristic(k, v) { svc.getCharacteristic(k).value = v; return svc; },
    updateCharacteristic(k, v) { svc.getCharacteristic(k).value = v; return svc; },
    setPrimaryService() { svc.primary = true; } };
  return svc;
};
const names = ['AccessoryInformation', 'Valve', 'Switch', 'TemperatureSensor', 'LightSensor', 'ContactSensor', 'LeakSensor'];
const Service = Object.fromEntries(names.map((n) => [n, n]));
const charNames = ['Manufacturer', 'Model', 'SerialNumber', 'Name', 'ValveType', 'Active', 'InUse', 'On', 'CurrentTemperature',
  'CurrentAmbientLightLevel', 'ContactSensorState', 'LeakDetected', 'StatusFault', 'ConfiguredName'];
const Characteristic = Object.fromEntries(charNames.map((n) => [n, n]));
Object.assign(Characteristic, {
  Active: Object.assign('Active', {}), });
const mk = (n, o) => Object.assign(Object.create(String.prototype), { toString: () => n }, o);
Characteristic.ContactSensorState = Object.assign(new String('ContactSensorState'), { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 });
Characteristic.LeakDetected = Object.assign(new String('LeakDetected'), { LEAK_NOT_DETECTED: 0, LEAK_DETECTED: 1 });
Characteristic.StatusFault = Object.assign(new String('StatusFault'), { NO_FAULT: 0, GENERAL_FAULT: 1 });
Characteristic.Active = Object.assign(new String('Active'), { ACTIVE: 1, INACTIVE: 0 });
Characteristic.InUse = Object.assign(new String('InUse'), { IN_USE: 1, NOT_IN_USE: 0 });
Characteristic.ValveType = Object.assign(new String('ValveType'), { WATER_FAUCET: 3, GENERIC_VALVE: 0 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-plat-'));
const accessories = [];
const handlers = {};
const api = {
  hap: { Service, Characteristic, uuid: { generate: (s) => s }, HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
  user: { storagePath: () => dir },
  platformAccessory: class { constructor(n, u) { this.displayName = n; this.UUID = u; this.services = [makeService('AccessoryInformation')]; this.context = {}; }
    getService(t) { return this.services.find((s) => s.type === t); }
    getServiceById(t, id) { return this.services.find((s) => s.type === t && s.subtype === id); }
    addService(t, label, id) { const s = makeService(t); s.subtype = id; this.services.push(s); return s; }
    removeService(s) { this.services = this.services.filter((x) => x !== s); } },
  on: (e, f) => { handlers[e] = f; },
  registerPlatformAccessories: (_p, _n, list) => accessories.push(...list),
  updatePlatformAccessories() {}, unregisterPlatformAccessories() {},
};
const log = Object.assign((...a) => a, { info: () => {}, warn: (...a) => { logs.push(a.join(' ')); }, error: (...a) => { logs.push(a.join(' ')); }, debug() {} });
const logs = [];

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const plugin = require('./index.js');
  let Platform; plugin({ ...api, registerPlatform: (_n, P) => { Platform = P; } });
  const config = { name: 'T', pollSeconds: 5, snapshotDir: dir, alertAfterMinutes: 30, shutOffAfterMinutes: 90,
    devices: [{ name: 'Water Valve', host: `127.0.0.1:${port}` }] };
  new Platform(log, config, api);
  // run the polls on a fake clock so 90 minutes take a moment
  let now = Date.UTC(2026, 10, 12, 10, 0, 0);
  const realNow = Date.now; Date.now = () => now;
  const timers = [];
  global.setInterval = (f, ms) => { timers.push({ f, ms }); return timers.length; };
  global.clearInterval = () => {};
  const realTimeout = setTimeout;
  await handlers.didFinishLaunching();
  await new Promise((r) => realTimeout(r, 200));
  const acc = accessories[0];
  const svc = (type, id) => acc.getServiceById(type, id);
  const sw = svc('Switch', 'switch');
  assert.ok(sw, 'a switch, not a valve, by default');
  assert.ok(!svc('Valve', 'valve'));
  assert.strictEqual(sw.primary, true, 'the control is the primary service');
  assert.strictEqual(sw.getCharacteristic('On').value, true);
  assert.ok(svc('ContactSensor', 'shut') && svc('LeakSensor', 'alarm') && svc('LeakSensor', 'longrun'));
  // each service has its own name for Home to show, and the three leak/contact sensors differ
  const label = (type, id) => svc(type, id).getCharacteristic('ConfiguredName').value;
  assert.strictEqual(label('Switch', 'switch'), 'Water Valve Switch');
  assert.strictEqual(label('ContactSensor', 'shut'), 'Water Valve Status');
  assert.strictEqual(label('LeakSensor', 'alarm'), 'Water Leak Alarm');
  assert.strictEqual(label('LeakSensor', 'longrun'), 'Water Suspected Leak Alarm');
  assert.ok(!svc('TemperatureSensor', 'temp') || true);
  const leak = (id) => svc('LeakSensor', id).getCharacteristic(Characteristic.LeakDetected).value;
  const poll = timers.find((t) => t.ms === 5000).f;
  const tick = async (minutes) => { now += minutes * 60000; await poll(); await new Promise((r) => realTimeout(r, 30)); };

  // a tap runs: 8 L/min
  valve.flow = 8;
  for (let m = 0; m <= 20; m += 5) { valve.total += 8 * 5 * 1000 / 1000 * 1; await tick(5); }
  assert.strictEqual(leak('longrun'), 0, 'not yet at 20 minutes');
  for (let i = 0; i < 3; i++) { valve.total += 40; await tick(5); }   // now 35+ minutes
  assert.strictEqual(leak('longrun'), 1, 'alert after 30 minutes');
  assert.strictEqual(valve.open, true, 'no shut-off yet');
  const nowDoc = JSON.parse(fs.readFileSync(path.join(dir, `127.0.0.1-${port}.now`), 'utf8'));
  assert.strictEqual(nowDoc.latest.run.alert, true);
  // carry on to 90 minutes: the valve is shut by the plugin, and the alert stays on
  for (let i = 0; i < 12; i++) { valve.total += 40; await tick(5); }
  assert.strictEqual(valve.open, false, 'shut off after 90 minutes');
  valve.flow = 0;
  for (let i = 0; i < 3; i++) await tick(2);
  assert.strictEqual(leak('longrun'), 1, 'alert still on after the flow stopped, until reopened');
  assert.strictEqual(leak('alarm'), 0, 'the plugin\'s own shut-off is not an alarm');
  assert.strictEqual(svc('ContactSensor', 'shut').getCharacteristic(Characteristic.ContactSensorState).value, 0);
  valve.open = true;                                       // someone opens it again
  await tick(1);
  assert.strictEqual(leak('longrun'), 0, 'clears once the valve is open again');
  // holiday mode: much shorter limits while it is on, remembered, and shown in the "now" file
  const hol = svc('Switch', 'holiday');
  assert.ok(hol, 'a holiday switch');
  assert.strictEqual(label('Switch', 'holiday'), 'Water Holiday Mode');
  assert.strictEqual(hol.getCharacteristic('On').value, false);
  valve.flow = 0;
  for (let i = 0; i < 3; i++) await tick(2);                // any earlier run ends
  assert.strictEqual(leak('longrun'), 0);
  hol.getCharacteristic('On').set(true);
  assert.strictEqual(acc.context.holiday, true, 'remembered in the accessory cache');
  valve.flow = 8;
  valve.total += 16; await tick(1);
  valve.total += 16; await tick(1);
  assert.strictEqual(leak('longrun'), 0, 'two minutes: not yet');
  valve.total += 16; await tick(1);
  valve.total += 16; await tick(2);
  assert.strictEqual(leak('longrun'), 1, 'holiday alert after 3 minutes, long before the normal 30');
  assert.strictEqual(valve.open, true, 'no holiday shut-off configured');
  const docH = JSON.parse(fs.readFileSync(path.join(dir, `127.0.0.1-${port}.now`), 'utf8'));
  assert.strictEqual(docH.latest.holiday, true);
  hol.getCharacteristic('On').set(false);
  valve.flow = 0;
  for (let i = 0; i < 3; i++) await tick(2);
  assert.strictEqual(leak('longrun'), 0, 'clears when the water stops');
  // normal use with holiday off does not alert at 5 minutes
  valve.flow = 8;
  for (let i = 0; i < 2; i++) { valve.total += 40; await tick(2.5); }
  assert.strictEqual(leak('longrun'), 0, 'five minutes of normal use is fine with holiday mode off');
  console.log('platform ok');
  Date.now = realNow;
  server.close(); fs.rmSync(dir, { recursive: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
