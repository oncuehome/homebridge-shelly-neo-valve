'use strict';

const crypto = require('crypto');
const path = require('path');
const { Recorder, gaugeBar, DEFAULT_ATMOSPHERIC_BAR } = require('./recorder.js');

const PLUGIN_NAME = 'homebridge-shelly-neo-valve';
const PLATFORM_NAME = 'ShellyNeoValve';

// Shelly Gen3 XT1 "neo-water-valve-advanced" exposes its readings as virtual components,
// identified by attrs.role. Flow is reported in m3/min; we show L/min.
const M3_PER_MIN_TO_L_PER_MIN = 1000;
const KPA_PER_BAR = 100;
const REQUEST_TIMEOUT_MS = 8000;

function parseComponents(json) {
  const out = {};
  for (const c of (json && json.components) || []) {
    const role = c.attrs && c.attrs.role;
    if (!role) continue;
    out[role] = { key: c.key, id: c.config && c.config.id, value: c.status && c.status.value };
  }
  if (!out.state || !('water_pressure' in out) || !out.water_temperature) {
    throw new Error('not a Neo water valve (missing state/pressure/temperature components)');
  }
  const total = out.water_consumption && out.water_consumption.value && out.water_consumption.value.counter
    ? out.water_consumption.value.counter.total : undefined;
  return {
    key: out.state.key,
    id: out.state.id,
    open: out.state.value === true,
    temperatureC: out.water_temperature.value,
    // As the valve reports it: absolute while no water flows (see gaugeBar in recorder.js).
    pressureBar: out.water_pressure.value / KPA_PER_BAR,
    flowLpm: (out.flow_rate ? out.flow_rate.value : 0) * M3_PER_MIN_TO_L_PER_MIN,
    // Total water used since the counter was last reset, in litres (the valve reports m3).
    consumptionL: typeof total === 'number' ? total * 1000 : null,
  };
}

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

// Gen2+ Shelly devices use HTTP digest auth with SHA-256 (the same scheme the other On Cue Shelly tools use).
function digestHeader(challenge, username, password, method, uri) {
  const p = {};
  for (const m of String(challenge).matchAll(/(\w+)="?([^",]*)"?/g)) p[m[1]] = m[2];
  if (!p.realm || !p.nonce) throw new Error('unexpected authentication challenge');
  const ha1 = sha256(`${username}:${p.realm}:${password}`);
  const ha2 = sha256(`${method}:${uri}`);
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const response = sha256(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="${username}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", ` +
    `cnonce="${cnonce}", nc=${nc}, qop=auth, response="${response}", algorithm=SHA-256`;
}

class ShellyNeoValvePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.timers = [];
    api.on('didFinishLaunching', () => this.discover());
    api.on('shutdown', () => this.timers.forEach(clearInterval));
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discover() {
    const { Service, Characteristic } = this.api.hap;
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    const seen = new Set();

    for (const dev of devices) {
      if (!dev || !dev.host) continue;
      const name = dev.name || 'Water Valve';
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${dev.host}`);
      seen.add(uuid);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info('Added %s (%s)', name, dev.host);
      }
      this.setup(accessory, name, dev.host, dev.username || 'admin', dev.password);
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info('Removing %s', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  setup(accessory, name, host, username, password) {
    const { Service, Characteristic } = this.api.hap;
    const base = `http://${host}`;
    const state = { id: 200, open: undefined };

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Neo Electronics / Shelly')
      .setCharacteristic(Characteristic.Model, 'Neo Smart Water Valve')
      .setCharacteristic(Characteristic.SerialNumber, host);

    const sub = (type, subtype, label) =>
      accessory.getServiceById(type, subtype) || accessory.addService(type, label, subtype);

    // The control is a plain On/Off switch by default (On = valve open): Home shows a Valve as running or in use,
    // which reads as water flowing when it only means the valve is open. "controlType": "valve" keeps the Valve tile.
    const asSwitch = this.config.controlType !== 'valve';
    const oldValve = accessory.getServiceById(Service.Valve, 'valve');
    const oldSwitch = accessory.getServiceById(Service.Switch, 'switch');
    let valve;
    if (asSwitch) {
      if (oldValve) accessory.removeService(oldValve);
      valve = sub(Service.Switch, 'switch', name);
      valve.setCharacteristic(Characteristic.Name, name);
    } else {
      if (oldSwitch) accessory.removeService(oldSwitch);
      valve = sub(Service.Valve, 'valve', name);
      valve.setCharacteristic(Characteristic.Name, name);
      valve.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.WATER_FAUCET);
    }

    // One accessory carries the control and the sensors. Home draws ONE tile per accessory from its primary service,
    // so mark the control as primary; otherwise Home may pick the leak sensor and show a drop where the switch should be.
    valve.setPrimaryService(true);

    // By default the readings also appear in Home (HomeKit has no pressure or flow sensor, so those two are
    // light sensors). Set "homeSensors": false to keep only the valve in Home and read the rest elsewhere.
    const homeSensors = this.config.homeSensors !== false;
    let temp, pressure, flow;
    if (homeSensors) {
      temp = sub(Service.TemperatureSensor, 'temp', `${name} temperature`);
      temp.setCharacteristic(Characteristic.Name, `${name} temperature`);
      temp.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -25, maxValue: 80 });

      const lux = (subtype, label) => {
        const s = sub(Service.LightSensor, subtype, label);
        s.setCharacteristic(Characteristic.Name, label);
        s.getCharacteristic(Characteristic.CurrentAmbientLightLevel).setProps({ minValue: 0, maxValue: 100000 });
        return s;
      };
      pressure = lux('pressure', `${name} pressure in bar`);
      flow = lux('flow', `${name} flow in L per min`);
    } else {
      for (const [type, subtype] of [[Service.TemperatureSensor, 'temp'], [Service.LightSensor, 'pressure'], [Service.LightSensor, 'flow']]) {
        const old = accessory.getServiceById(type, subtype);
        if (old) accessory.removeService(old);
      }
    }

    // Home cannot notify on a Valve changing state, but it can on sensors. So the valve also shows as a contact
    // sensor (Closed = water off) and a leak sensor that trips when the valve shuts WITHOUT being told to
    // (a valve alarm, the Shelly app, the button on the valve). "valveSensors": false removes both.
    const valveSensors = this.config.valveSensors !== false;
    let contact, alarm;
    if (valveSensors) {
      contact = sub(Service.ContactSensor, 'shut', `${name} closed`);
      contact.setCharacteristic(Characteristic.Name, `${name} closed`);
      alarm = sub(Service.LeakSensor, 'alarm', `${name} alarm`);
      alarm.setCharacteristic(Characteristic.Name, `${name} alarm`);
    } else {
      for (const [type, subtype] of [[Service.ContactSensor, 'shut'], [Service.LeakSensor, 'alarm']]) {
        const old = accessory.getServiceById(type, subtype);
        if (old) accessory.removeService(old);
      }
    }
    let lastCommandAt = 0;
    let alarmOn = false;

    const all = [valve, temp, pressure, flow, contact, alarm].filter(Boolean);

    // Snapshots: one reading every few minutes into a small JSON file (see recorder.js).
    const atmosphericBar = typeof this.config.atmosphericBar === 'number' ? this.config.atmosphericBar : DEFAULT_ATMOSPHERIC_BAR;
    let recorder = null;
    let snapshotEveryMs = 0;
    if (this.config.snapshots !== false) {
      const dir = this.config.snapshotDir || path.join(this.api.user.storagePath(), 'neo-valve');
      const slug = String(host).toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
      const days = Math.min(90, Math.max(1, this.config.historyDays || 14));
      const everyMin = Math.min(60, Math.max(1, this.config.snapshotMinutes || 10));
      recorder = new Recorder({
        file: path.join(dir, `${slug}.json`),
        device: { name, host },
        atmosphericBar,
        maxRows: Math.ceil((days * 24 * 60) / everyMin),
      });
      snapshotEveryMs = everyMin * 60 * 1000;
    }
    const setFault = (fault) => all.forEach((s) =>
      s.updateCharacteristic(Characteristic.StatusFault, fault
        ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT));

    const rpc = async (path, body) => {
      const method = body ? 'POST' : 'GET';
      const send = (auth) => fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: auth } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let res = await send();
      if (res.status === 401) {
        if (!password) throw new Error('the valve wants a password; set "password" in the config');
        res = await send(digestHeader(res.headers.get('www-authenticate'), username, password, method, path));
        if (res.status === 401) throw new Error('the valve refused the username/password');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };

    const apply = (r) => {
      state.id = r.id;
      const wasOpen = state.open;
      state.open = r.open;
      if (valveSensors) {
        contact.updateCharacteristic(Characteristic.ContactSensorState, r.open
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED);
        // wasOpen is undefined until the first reading, so a valve found already shut at start is not an alarm.
        if (wasOpen === true && !r.open && Date.now() - lastCommandAt > 60000) {
          alarmOn = true;
          this.log.warn('%s: shut by itself or from outside Home', name);
        }
        if (r.open) alarmOn = false;
        alarm.updateCharacteristic(Characteristic.LeakDetected, alarmOn
          ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
      }
      if (asSwitch) {
        valve.updateCharacteristic(Characteristic.On, r.open);
      } else {
        const active = r.open ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
        valve.updateCharacteristic(Characteristic.Active, active);
        // InUse follows the valve, not the flow reading: Active on with InUse off shows "Starting..." in Home.
        valve.updateCharacteristic(Characteristic.InUse,
          r.open ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
      }
      if (homeSensors) {
        temp.updateCharacteristic(Characteristic.CurrentTemperature, r.temperatureC);
        pressure.updateCharacteristic(Characteristic.CurrentAmbientLightLevel,
          Math.round(gaugeBar(r.pressureBar, r.flowLpm, atmosphericBar) * 100) / 100);
        flow.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, Math.round(r.flowLpm * 100) / 100);
      }
      setFault(false);
    };

    let lastErr = null;
    let reachable = false;
    let firstSnapshotDone = false;
    const poll = async () => {
      try {
        const reading = parseComponents(await rpc('/rpc/Shelly.GetComponents?dynamic_only=true'));
        apply(reading);
        reachable = true;
        if (recorder) {
          recorder.observe(reading);
          // Record the first good reading at once, so there is a snapshot as soon as the plugin starts.
          if (!firstSnapshotDone) { firstSnapshotDone = true; recorder.snapshot(true); }
        }
        if (lastErr) this.log.info('%s is reachable again', name);
        lastErr = null;
      } catch (e) {
        reachable = false;
        if (String(e) !== lastErr) this.log.warn('%s (%s): %s', name, host, e.message || e);
        lastErr = String(e);
        setFault(true);
      }
    };

    const command = async (want) => {
      lastCommandAt = Date.now();
      try {
        await rpc('/rpc/Boolean.Set', { id: state.id, value: want });
      } catch (e) {
        this.log.error('%s: could not %s the valve: %s', name, want ? 'open' : 'close', e.message || e);
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      this.log.info('%s: valve %s', name, want ? 'opened' : 'closed');
      state.open = want;
    };

    if (asSwitch) {
      valve.getCharacteristic(Characteristic.On)
        .onGet(() => state.open === true)
        .onSet(async (v) => {
          await command(v === true);
          setTimeout(poll, 1500);
        });
    } else {
      valve.getCharacteristic(Characteristic.InUse)
        .onGet(() => (state.open === true ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE));
      valve.getCharacteristic(Characteristic.Active)
        .onGet(() => (state.open === true ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE))
        .onSet(async (v) => {
          await command(v === Characteristic.Active.ACTIVE);
          // Home ignores an InUse change that arrives before it has the write response, and then sits on
          // "Starting"/"Stopping". Send it just after, and again once the next poll has confirmed the state.
          const inUse = () => valve.updateCharacteristic(Characteristic.InUse,
            state.open ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
          setTimeout(inUse, 700);
          setTimeout(poll, 1500);
        });
    }

    poll();
    this.timers.push(setInterval(poll, Math.max(5, this.config.pollSeconds || 15) * 1000));
    if (recorder) {
      this.timers.push(setInterval(() => {
        try { recorder.snapshot(reachable); } catch (e) { this.log.warn('%s: could not save the snapshot: %s', name, e.message || e); }
      }, snapshotEveryMs));
    }
  }
}

module.exports = (api) => api.registerPlatform(PLATFORM_NAME, ShellyNeoValvePlatform);
module.exports.parseComponents = parseComponents;
module.exports.digestHeader = digestHeader;
module.exports.gaugeBar = gaugeBar;
