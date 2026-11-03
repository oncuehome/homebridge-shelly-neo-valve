'use strict';

const crypto = require('crypto');

const PLUGIN_NAME = 'homebridge-shelly-neo-valve';
const PLATFORM_NAME = 'ShellyNeoValve';

// Shelly Gen3 XT1 "neo-water-valve-advanced" exposes its readings as virtual components,
// identified by attrs.role. Flow is reported in m3/min; we show L/min.
const M3_PER_MIN_TO_L_PER_MIN = 1000;
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
  return {
    key: out.state.key,
    id: out.state.id,
    open: out.state.value === true,
    temperatureC: out.water_temperature.value,
    pressureKpa: out.water_pressure.value,
    flowLpm: (out.flow_rate ? out.flow_rate.value : 0) * M3_PER_MIN_TO_L_PER_MIN,
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
    const state = { id: 200, open: false };

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Neo Electronics / Shelly')
      .setCharacteristic(Characteristic.Model, 'Neo Smart Water Valve')
      .setCharacteristic(Characteristic.SerialNumber, host);

    const sub = (type, subtype, label) =>
      accessory.getServiceById(type, subtype) || accessory.addService(type, label, subtype);

    const valve = sub(Service.Valve, 'valve', name);
    valve.setCharacteristic(Characteristic.Name, name);
    valve.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.GENERIC_VALVE);

    const temp = sub(Service.TemperatureSensor, 'temp', `${name} temperature`);
    temp.setCharacteristic(Characteristic.Name, `${name} temperature`);
    temp.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -25, maxValue: 80 });

    const lux = (subtype, label) => {
      const s = sub(Service.LightSensor, subtype, label);
      s.setCharacteristic(Characteristic.Name, label);
      s.getCharacteristic(Characteristic.CurrentAmbientLightLevel).setProps({ minValue: 0, maxValue: 100000 });
      return s;
    };
    const pressure = lux('pressure', `${name} pressure in kPa`);
    const flow = lux('flow', `${name} flow in L per min`);

    const all = [valve, temp, pressure, flow];
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
      state.open = r.open;
      const active = r.open ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
      valve.updateCharacteristic(Characteristic.Active, active);
      valve.updateCharacteristic(Characteristic.InUse,
        r.open && r.flowLpm > 0 ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
      temp.updateCharacteristic(Characteristic.CurrentTemperature, r.temperatureC);
      pressure.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, Math.round(r.pressureKpa * 10) / 10);
      flow.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, Math.round(r.flowLpm * 100) / 100);
      setFault(false);
    };

    let lastErr = null;
    const poll = async () => {
      try {
        apply(parseComponents(await rpc('/rpc/Shelly.GetComponents?dynamic_only=true')));
        if (lastErr) this.log.info('%s is reachable again', name);
        lastErr = null;
      } catch (e) {
        if (String(e) !== lastErr) this.log.warn('%s (%s): %s', name, host, e.message || e);
        lastErr = String(e);
        setFault(true);
      }
    };

    valve.getCharacteristic(Characteristic.Active)
      .onGet(() => (state.open ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE))
      .onSet(async (v) => {
        const want = v === Characteristic.Active.ACTIVE;
        try {
          await rpc('/rpc/Boolean.Set', { id: state.id, value: want });
        } catch (e) {
          this.log.error('%s: could not %s the valve: %s', name, want ? 'open' : 'close', e.message || e);
          throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        this.log.info('%s: valve %s', name, want ? 'opened' : 'closed');
        state.open = want;
        setTimeout(poll, 1500);
      });

    poll();
    this.timers.push(setInterval(poll, Math.max(5, this.config.pollSeconds || 15) * 1000));
  }
}

module.exports = (api) => api.registerPlatform(PLATFORM_NAME, ShellyNeoValvePlatform);
module.exports.parseComponents = parseComponents;
module.exports.digestHeader = digestHeader;
