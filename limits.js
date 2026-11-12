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

// Everything except the read time, to tell whether the valve's settings changed since the last read.
const settingsKey = (st) => JSON.stringify({ ...st, read_at: undefined });

module.exports = { summariseSettings, describeSettings, settingsKey, LIMITS };
