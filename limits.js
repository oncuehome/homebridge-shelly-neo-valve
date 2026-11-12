'use strict';

// The valve keeps its own alarm limits (service:0). Each is a [min, max] pair; outside it the valve takes its alarm action
// (close). The plugin reads them at every start and logs them. It writes one ONLY when the matching settings are filled in.
// Units in the valve: temperature C, pressure kPa (absolute), flow m3/min (the Shelly page shows it as L/min, x1000, so a
// stored 75 is shown as 75000 L/min). In the settings: C, bar and L/min.
const KPA_PER_BAR = 100;

const LIMITS = [
  { key: 'alarm_temp_range', label: 'temperature', unit: 'C', min: 'limitTempMin', max: 'limitTempMax', scale: 1, lo: -20, hi: 100 },
  { key: 'alarm_pressure_range', label: 'pressure', unit: 'bar', min: 'limitPressureMinBar', max: 'limitPressureMaxBar', scale: KPA_PER_BAR, lo: 0, hi: 10 },
  { key: 'alarm_flow_rate_range', label: 'flow', unit: 'L/min', min: 'limitFlowMin', max: 'limitFlowMax', scale: 0.001, lo: 0, hi: 500 },
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// current: the valve's service config. Returns { changes: { alarm_x_range: [min,max] }, notes: [text] }.
// A pair with neither value filled in is left alone; with one filled in, the other keeps the valve's current value.
function planLimits(config, current) {
  const changes = {};
  const notes = [];
  for (const l of LIMITS) {
    const wantMin = config[l.min];
    const wantMax = config[l.max];
    if (!isNum(wantMin) && !isNum(wantMax)) continue;
    const now = Array.isArray(current && current[l.key]) ? current[l.key] : null;
    const curMin = now ? Math.round(now[0] / l.scale * 1e3) / 1e3 : undefined;
    const curMax = now ? Math.round(now[1] / l.scale * 1e3) / 1e3 : undefined;
    const min = isNum(wantMin) ? wantMin : curMin;
    const max = isNum(wantMax) ? wantMax : curMax;
    if (!isNum(min) || !isNum(max)) { notes.push(`${l.label}: the valve's current limit could not be read, so set both the minimum and the maximum`); continue; }
    if (min < l.lo || max > l.hi) { notes.push(`${l.label}: ${min} to ${max} ${l.unit} is outside ${l.lo} to ${l.hi}; not changed`); continue; }
    if (!(min < max)) { notes.push(`${l.label}: the minimum (${min}) must be below the maximum (${max}); not changed`); continue; }
    const pair = [Math.round(min * l.scale * 1e6) / 1e6, Math.round(max * l.scale * 1e6) / 1e6];
    if (!now || now[0] !== pair[0] || now[1] !== pair[1]) changes[l.key] = pair;
  }
  return { changes, notes };
}

// One line per limit for the log, in the settings' own units.
function describeLimits(current) {
  return LIMITS.map((l) => {
    const v = current && current[l.key];
    return Array.isArray(v) ? `${l.label} ${Math.round(v[0] / l.scale * 1e3) / 1e3} to ${Math.round(v[1] / l.scale * 1e3) / 1e3} ${l.unit}` : `${l.label} unknown`;
  }).join(', ');
}

module.exports = { planLimits, describeLimits, LIMITS };
