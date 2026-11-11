'use strict';

const fs = require('fs');
const path = require('path');

// The valve shows ABSOLUTE pressure while no water is flowing (Shelly's FAQ), so the real
// (gauge) pressure is the reading minus the local atmospheric pressure. With water flowing
// the reading is used as it is. Never below zero.
const DEFAULT_ATMOSPHERIC_BAR = 1.013;
const NO_FLOW_LPM = 0.01;

function gaugeBar(rawBar, flowLpm, atmosphericBar = DEFAULT_ATMOSPHERIC_BAR) {
  if (typeof rawBar !== 'number' || Number.isNaN(rawBar)) return null;
  const real = flowLpm < NO_FLOW_LPM ? rawBar - atmosphericBar : rawBar;
  return Math.max(0, Math.round(real * 1000) / 1000);
}

const round = (v, places) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.round(v * 10 ** places) / 10 ** places : null);

// Keeps one snapshot every few minutes in a small JSON file, written atomically, so a separate
// reader (a locked-down login on the Pi) can pick up the latest reading and the recent history
// without talking to the valve. The file holds readings only: no password, no address of a person.
class Recorder {
  constructor({ file, device, atmosphericBar = DEFAULT_ATMOSPHERIC_BAR, maxRows = 2016, now = () => new Date() }) {
    this.file = file;
    this.device = device;
    this.atmosphericBar = atmosphericBar;
    this.maxRows = maxRows;
    this.now = now;
    this.latest = null;        // last good reading { at, ... }
    this.peakLpm = 0;          // highest flow seen since the last snapshot
    this.history = [];
    this.lastTotalL = null;    // water counter at the previous snapshot
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.history)) this.history = d.history.slice(-this.maxRows);
      if (d.latest) this.latest = d.latest;
      const lastGood = [...this.history].reverse().find((h) => h.ok && typeof h.consumption_l === 'number');
      if (lastGood) this.lastTotalL = lastGood.consumption_l;
    } catch (e) { /* first run, or an unreadable file: start fresh */ }
  }

  // Called on every poll of the valve with the parsed reading.
  observe(r) {
    const flow = r.flowLpm;
    this.peakLpm = Math.max(this.peakLpm, flow);
    this.latest = {
      at: this.now().toISOString(),
      valve_open: r.open,
      flow_lpm: round(flow, 2),
      pressure_bar_raw: round(r.pressureBar, 3),
      pressure_bar: gaugeBar(r.pressureBar, flow, this.atmosphericBar),
      temperature_c: round(r.temperatureC, 1),
      consumption_l: round(r.consumptionL, 3),
    };
  }

  // Called every N minutes. Records the latest reading with the peak flow and litres used
  // since the previous snapshot, or a gap marker when the valve has not answered.
  snapshot(reachable = true) {
    const t = this.now().toISOString();
    let row;
    if (!reachable || !this.latest) {
      row = { t, ok: false };
    } else {
      const total = this.latest.consumption_l;
      let used = null;
      if (typeof total === 'number') {
        // a counter that went down was reset: count from zero
        used = this.lastTotalL === null ? null : round(total >= this.lastTotalL ? total - this.lastTotalL : total, 3);
        this.lastTotalL = total;
      }
      row = { t, ok: true, ...this.latest, at: undefined, flow_peak_lpm: round(Math.max(this.peakLpm, this.latest.flow_lpm), 2), used_l: used };
      delete row.at;
    }
    this.peakLpm = 0;
    this.history.push(row);
    if (this.history.length > this.maxRows) this.history = this.history.slice(-this.maxRows);
    this.save(t);
    return row;
  }

  save(updatedAt) {
    const doc = {
      schema: 1,
      device: this.device,
      atmospheric_bar: this.atmosphericBar,
      updated_at: updatedAt,
      latest: this.latest,
      history: this.history,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o755 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o644 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Recorder, gaugeBar, DEFAULT_ATMOSPHERIC_BAR };
