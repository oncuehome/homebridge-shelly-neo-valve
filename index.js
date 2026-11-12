'use strict';

const crypto = require('crypto');
const path = require('path');
const { Recorder, gaugeBar, DEFAULT_ATMOSPHERIC_BAR } = require('./recorder.js');
const { RunTracker, Allowance, inWindow } = require('./longrun.js');
const { summariseSettings, describeSettings, settingsKey, settingsWarnings, homeUnits, fromBar, fromLitres, pressureLabel, flowLabel } = require('./limits.js');

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

    // Home shows a tile or row for each service under the name in ConfiguredName (the plain Name is often ignored), so every
    // service gets one: otherwise the three leak sensors all show up with the accessory's name and cannot be told apart.
    const sub = (type, subtype, label) => {
      const svc = accessory.getServiceById(type, subtype) || accessory.addService(type, label, subtype);
      svc.setCharacteristic(Characteristic.ConfiguredName, label);
      return svc;
    };

    // The control is a plain On/Off switch by default (On = valve open): Home shows a Valve as running or in use,
    // which reads as water flowing when it only means the valve is open. "controlType": "valve" keeps the Valve tile.
    const asSwitch = this.config.controlType !== 'valve';
    // Tile names in Apple Home. Each can be changed in the settings; empty means the default.
    const label = (key, dflt) => (typeof this.config[key] === 'string' && this.config[key].trim() ? this.config[key].trim() : dflt);
    const switchName = label('switchName', 'Water Valve Switch');
    const statusName = label('statusName', 'Water Valve Status');
    const alarmName = label('alarmName', 'Water Critical Fault Sensor');
    const holidayName = label('holidayName', 'Water Holiday Mode');
    const suspectedName = label('suspectedLeakName', 'Water Unexpected Flow Sensor');
    const oldValve = accessory.getServiceById(Service.Valve, 'valve');
    const oldSwitch = accessory.getServiceById(Service.Switch, 'switch');
    let valve;
    if (asSwitch) {
      if (oldValve) accessory.removeService(oldValve);
      valve = sub(Service.Switch, 'switch', switchName);
      valve.setCharacteristic(Characteristic.Name, switchName);
    } else {
      if (oldSwitch) accessory.removeService(oldSwitch);
      valve = sub(Service.Valve, 'valve', switchName);
      valve.setCharacteristic(Characteristic.Name, switchName);
      valve.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.WATER_FAUCET);
    }

    // One accessory carries the control and the sensors. Home draws ONE tile per accessory from its primary service,
    // so mark the control as primary; otherwise Home may pick the leak sensor and show a drop where the switch should be.
    valve.setPrimaryService(true);

    // By default the readings also appear in Home (HomeKit has no pressure or flow sensor, so those two are
    // light sensors). Set "homeSensors": false to keep only the valve in Home and read the rest elsewhere.
    const homeSensors = this.config.homeSensors !== false;
    let units = homeUnits(this.config.homeUnits, null);
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
      // The unit follows the setting (by default the valve's own page) once the valve has been read; until then bar and L/min.
      pressure = lux('pressure', `${name} pressure in ${pressureLabel(units.pressure)}`);
      flow = lux('flow', `${name} flow in ${flowLabel(units.volume)}`);
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
      contact = sub(Service.ContactSensor, 'shut', statusName);
      contact.setCharacteristic(Characteristic.Name, statusName);
      alarm = sub(Service.LeakSensor, 'alarm', alarmName);
      alarm.setCharacteristic(Characteristic.Name, alarmName);
    } else {
      for (const [type, subtype] of [[Service.ContactSensor, 'shut'], [Service.LeakSensor, 'alarm']]) {
        const old = accessory.getServiceById(type, subtype);
        if (old) accessory.removeService(old);
      }
    }
    // Water running too long: an alert (and, if you choose, a shut-off) after a number of minutes and/or litres of
    // flow that has not properly stopped. Limits of 0 are off. The sensor stays on after a shut-off until the valve is
    // opened again, so the alert is not lost when the flow stops.
    const num = (v, d) => (typeof v === 'number' && v >= 0 ? v : d);
    const alertMinutes = num(this.config.alertAfterMinutes, 30);
    const alertLitres = num(this.config.alertAfterLitres, 0);
    const shutOffMinutes = num(this.config.shutOffAfterMinutes, 0);
    const shutOffLitres = num(this.config.shutOffAfterLitres, 0);
    // Holiday mode: a switch in Home. While it is on, nobody should be using water, so water running for a few minutes (the
    // alert) or longer (the optional shut-off) trips the same "running too long" sensor. It is remembered across restarts.
    const holidayEnabled = this.config.holidayMode !== false;
    const holidayAlertMinutes = num(this.config.holidayAlertMinutes, 3);
    const holidayShutOffMinutes = num(this.config.holidayShutOffMinutes, 0);
    // Slow leaks while away: litres over the last 24 hours in holiday mode, from the valve's counter. And a daily window when holiday
    // rules are ignored (sprinklers). Both use the Pi's own clock.
    const holidayAllowance = new Allowance({ litres: num(this.config.holidayAllowanceLitres, 0) });
    const quietFrom = this.config.holidayIgnoreFrom, quietTo = this.config.holidayIgnoreTo;
    let holiday = holidayEnabled && accessory.context.holiday === true;
    let holidaySwitch = null;
    if (holidayEnabled) {
      holidaySwitch = sub(Service.Switch, 'holiday', holidayName);
      holidaySwitch.setCharacteristic(Characteristic.Name, holidayName);
      holidaySwitch.getCharacteristic(Characteristic.On).onGet(() => holiday).onSet((v) => {
        holiday = v === true;
        accessory.context.holiday = holiday;
        holidayTracker.reset();
        holidayAllowance.reset();
        try { this.api.updatePlatformAccessories([accessory]); } catch (e) { /* the cache is saved on shutdown anyway */ }
        this.log.info('%s: holiday mode %s', name, holiday ? 'on' : 'off');
      });
      holidaySwitch.updateCharacteristic(Characteristic.On, holiday);
    } else {
      const old = accessory.getServiceById(Service.Switch, 'holiday');
      if (old) accessory.removeService(old);
    }
    const longRunRules = holidayEnabled || holidayAllowance.litres > 0 || alertMinutes > 0 || alertLitres > 0 || shutOffMinutes > 0 || shutOffLitres > 0;
    let longRun = null;
    if (longRunRules) {
      longRun = sub(Service.LeakSensor, 'longrun', suspectedName);
      longRun.setCharacteristic(Characteristic.Name, suspectedName);
    } else {
      const old = accessory.getServiceById(Service.LeakSensor, 'longrun');
      if (old) accessory.removeService(old);
    }
    const tracker = new RunTracker({
      alertMinutes, alertLitres, shutOffMinutes, shutOffLitres,
      graceMs: Math.max(90, 3 * Math.max(5, this.config.pollSeconds || 15)) * 1000,
    });
    const holidayTracker = new RunTracker({
      alertMinutes: holidayAlertMinutes, shutOffMinutes: holidayShutOffMinutes,
      graceMs: Math.max(90, 3 * Math.max(5, this.config.pollSeconds || 15)) * 1000,
    });
    let longRunOn = false;
    let shutOffLatched = false;

    let lastCommandAt = 0;
    let alarmOn = false;

    const all = [valve, temp, pressure, flow, contact, alarm, longRun, holidaySwitch].filter(Boolean);

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
          Math.round(fromBar(gaugeBar(r.pressureBar, r.flowLpm, atmosphericBar), units.pressure) * 100) / 100);
        flow.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, Math.round(fromLitres(r.flowLpm, units.volume) * 100) / 100);
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
        const run = tracker.update(Date.now(), reading.flowLpm, reading.consumptionL);
        // While holiday mode is on, its (shorter) limits count as well as the normal ones.
        // Outside any sprinkler window only: inside it the holiday rules look away (the normal limits above still apply).
        const holidayActive = holiday && !inWindow(new Date(), quietFrom, quietTo);
        const away = holidayActive ? holidayTracker.update(Date.now(), reading.flowLpm, reading.consumptionL) : null;
        if (!holidayActive) holidayTracker.reset();
        if (away) { run.alert = run.alert || away.alert; run.shutOff = run.shutOff || away.shutOff; }
        const slow = holidayAllowance.update(Date.now(), reading.consumptionL, holidayActive);
        if (longRunRules) {
          if (reading.open && shutOffLatched && !run.active) shutOffLatched = false;   // opened again: the alert can clear
          const was = longRunOn;
          longRunOn = run.alert || shutOffLatched || slow.over;
          if (longRun) {
            longRun.updateCharacteristic(Characteristic.LeakDetected, longRunOn
              ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
          }
          if (slow.over && !was && !run.alert) this.log.warn('%s: %s L used in the last 24 hours while holiday mode is on (allowance %s L)', name, slow.litres, holidayAllowance.litres);
          if (longRunOn && !was && run.alert) this.log.warn('%s: water has been running for %s min (%s L)%s', name, run.minutes, run.litres, holiday ? ' while holiday mode is on' : '');
          if (run.shutOff && reading.open && !shutOffLatched) {
            shutOffLatched = true;
            longRunOn = true;
            this.log.warn('%s: shutting the valve after %s min / %s L of continuous flow', name, run.minutes, run.litres);
            try { await command(false); } catch (e) { shutOffLatched = false; /* command() already logged it; try again next poll */ }
          }
        }
        if (recorder) {
          recorder.observe(reading, run.active || longRunOn ? { minutes: run.minutes, litres: run.litres, alert: longRunOn } : null, holiday);
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

    // The valve's own settings are mastered on the valve. Read them at start and every few hours, log them, keep a copy beside
    // the readings, and say so when they change. Never written from here.
    let lastSettingsKey = null;
    const readSettings = async () => {
      try {
        const service = await rpc('/rpc/Service.GetConfig?id=0');
        let sys = null;
        try { sys = await rpc('/rpc/Sys.GetConfig'); } catch (e) { /* the limits are the useful part */ }
        const settings = summariseSettings(service, sys);
        const newUnits = homeUnits(this.config.homeUnits, service);
        if (homeSensors && (newUnits.pressure !== units.pressure || newUnits.volume !== units.volume)) {
          units = newUnits;
          const pl = `${name} pressure in ${pressureLabel(units.pressure)}`, fl = `${name} flow in ${flowLabel(units.volume)}`;
          pressure.setCharacteristic(Characteristic.Name, pl).setCharacteristic(Characteristic.ConfiguredName, pl);
          flow.setCharacteristic(Characteristic.Name, fl).setCharacteristic(Characteristic.ConfiguredName, fl);
          this.log.info('%s: Home shows pressure in %s and flow in %s', name, pressureLabel(units.pressure), flowLabel(units.volume));
        }
        const key = settingsKey(settings);
        if (lastSettingsKey === null) this.log.info('%s: valve settings: %s', name, describeSettings(settings));
        else if (key !== lastSettingsKey) this.log.warn('%s: the valve\'s settings changed: %s', name, describeSettings(settings));
        if (key !== lastSettingsKey) for (const w of settingsWarnings(settings)) this.log.warn('%s: check the valve first: %s', name, w);
        lastSettingsKey = key;
        if (recorder) recorder.setSettings(settings);
      } catch (e) {
        this.log.warn('%s: could not read the valve\'s settings: %s', name, e.message || e);
      }
    };
    readSettings();
    this.timers.push(setInterval(readSettings, 6 * 60 * 60 * 1000));

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
