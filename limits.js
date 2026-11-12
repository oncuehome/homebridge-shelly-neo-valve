'use strict';

// The valve keeps its own settings (alarm limits, units, what to do when power returns). They are MASTERED ON THE VALVE:
// this plugin only reads them, logs them and saves a copy beside the readings, so what we show can be read against what the
// valve was set to at the time. It never writes them.
// Units in the valve: temperature C, pressure kPa (absolute), flow m3/min (the Shelly page shows x1000 as L/min, so a stored
// 75 is shown there as 75000 L/min). Here they are given in C, bar and L/min.
const KPA_PER_BAR = 100;
const round = (v, p = 3) => Math.round(v * 10 ** p) / 10 ** p;

const LIMITS = [
  { name: 'temperature', key: 'alarm_temp_range', action: 'alarm_temp_action', unit: 'C', scale: 1 },
  { name: 'pressure', key: 'alarm_pressure_range', action: 'alarm_pressure_action', unit: 'bar', scale: KPA_PER_BAR },
  { name: 'flow', key: 'alarm_flow_rate_range', action: 'alarm_flow_rate_action', unit: 'L/min', scale: 0.001 },
];

// service: Service.GetConfig(id 0); sys: Sys.GetConfig (optional). Returns a plain object safe to store and relay:
// no address, password or coordinates.
function summariseSettings(service, sys, now = new Date()) {
  const s = service || {};
  const limits = {};
  for (const l of LIMITS) {
    const v = s[l.key];
    limits[l.name] = Array.isArray(v) && v.length === 2
      ? { min: round(v[0] / l.scale), max: round(v[1] / l.scale), unit: l.unit, action: s[l.action] || null }
      : null;
  }
  return {
    read_at: now.toISOString(),
    limits,
    units_on_valve_page: { temperature: s.temp_unit || null, pressure: s.pressure_unit || null, volume: s.volume_unit || null },
    on_power_restore: s.on_power_restore || null,
    timezone: (sys && sys.location && sys.location.tz) || null,
    firmware: (sys && sys.device && sys.device.fw_id) || null,
    pressure_is_absolute_at_zero_flow: true,
  };
}

// One line for the log.
function describeSettings(st) {
  const l = st.limits;
  const one = (n) => (l[n] ? `${n} ${l[n].min} to ${l[n].max} ${l[n].unit} (${l[n].action})` : `${n} unknown`);
  return `${one('temperature')}, ${one('pressure')}, ${one('flow')}; on power restore: ${st.on_power_restore}; ` +
    `valve page units: ${st.units_on_valve_page.temperature}, ${st.units_on_valve_page.pressure}, ${st.units_on_valve_page.volume}; ` +
    `time zone ${st.timezone}; firmware ${st.firmware}`;
}

// Things to check on the valve before relying on it. The limits are mastered on the valve, so a valve fresh out of the box (or one whose
// limits were never chosen) is not protecting anything: its flow limit is far above anything a house can use.
function settingsWarnings(st) {
  const out = [];
  const l = st.limits || {};
  if (!l.flow || l.flow.max === null || l.flow.max > 500) out.push('the flow alarm is far above what a house can use (or unknown), so it will never close the valve: set a realistic maximum in the Shelly app');
  if (!l.pressure || l.pressure.max === null || l.pressure.max >= 10) out.push('the pressure alarm is very wide (or unknown): set minimum and maximum pressure in the Shelly app');
  if (!l.temperature || l.temperature.min === null || l.temperature.max === null) out.push('the temperature alarm is unknown: set it in the Shelly app');
  for (const n of ['temperature', 'pressure', 'flow']) if (l[n] && l[n].action && l[n].action !== 'close') out.push(`the ${n} alarm action is "${l[n].action}", not close, so the valve will not shut when it trips`);
  return out;
}

// Everything except the read time, to tell whether the valve's settings changed since the last read.
const settingsKey = (st) => JSON.stringify({ ...st, read_at: undefined });

// What the plugin shows in Apple Home (the pressure and flow tiles) and logs, so it matches the valve's own page. choice is the
// plugin setting: "valve" (follow the valve's units, the default), "metric" (bar, L/min) or "us" (PSI, gal/min). The snapshot copy, the
// hub status, the app and Backstage always use bar and litres.
const PSI_PER_BAR = 14.5037738;
const LITRES_PER_GALLON = 3.785411784;
function homeUnits(choice, service) {
  const p = String((service && service.pressure_unit) || '').toLowerCase();
  const v = String((service && service.volume_unit) || '').toLowerCase();
  const pick = choice === 'metric' || choice === 'us' ? choice : 'valve';
  const pressure = pick === 'metric' ? 'bar' : pick === 'us' ? 'psi' : (p === 'psi' ? 'psi' : p === 'kpa' ? 'kpa' : 'bar');
  const volume = pick === 'metric' ? 'L' : pick === 'us' ? 'gal' : (v.startsWith('gal') ? 'gal' : 'L');
  return { pressure, volume };
}
const fromBar = (bar, unit) => (unit === 'psi' ? bar * PSI_PER_BAR : unit === 'kpa' ? bar * KPA_PER_BAR : bar);
const fromLitres = (l, unit) => (unit === 'gal' ? l / LITRES_PER_GALLON : l);
const pressureLabel = (unit) => (unit === 'psi' ? 'PSI' : unit === 'kpa' ? 'kPa' : 'bar');
const flowLabel = (unit) => (unit === 'gal' ? 'gal per min' : 'L per min');

module.exports = { settingsWarnings, homeUnits, fromBar, fromLitres, pressureLabel, flowLabel, summariseSettings, describeSettings, settingsKey, LIMITS };
