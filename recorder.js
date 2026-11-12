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
// Local calendar date (the Pi's own time zone) as YYYY-MM-DD: the day a litre was used on.
const localDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

class Recorder {
  constructor({ file, device, atmosphericBar = DEFAULT_ATMOSPHERIC_BAR, maxRows = 2016, keepDays = 400, now = () => new Date() }) {
    this.file = file;
    // The newest reading on its own, rewritten at every poll. It is tiny, so a reader can ask for "now" without the history.
    this.nowFile = file.replace(/\.json$/, '') + '.now';
    this.keepDays = keepDays;
    // Per local day, kept long after the 10-minute rows are gone: { l: litres used, pmin, pmax, ps: sum of pressure, pn: samples }
    this.days = {};
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
      const daysOk = d.days && typeof d.days === 'object' && Object.values(d.days).every((v) => v && typeof v === 'object');
      if (daysOk) this.days = d.days;
      else this.rebuildDays();
      const lastGood = [...this.history].reverse().find((h) => h.ok && typeof h.consumption_l === 'number');
      if (lastGood) this.lastTotalL = lastGood.consumption_l;
    } catch (e) { /* first run, or an unreadable file: start fresh */ }
  }

  // First run with an older file: add up the days from the rows that are still there.
  rebuildDays() {
    this.days = {};
    for (const r of this.history) if (r.ok) this.addToDay(new Date(r.t), r.used_l, r.pressure_bar);
  }

  // Add one good row to its day: litres used, and the pressure seen.
  addToDay(when, usedL, pressureBar) {
    const k = localDate(when);
    const day = this.days[k] || (this.days[k] = { l: 0 });
    if (typeof usedL === 'number' && usedL > 0) day.l = round(day.l + usedL, 1);
    if (typeof pressureBar === 'number') {
      day.pmin = day.pmin === undefined ? pressureBar : Math.min(day.pmin, pressureBar);
      day.pmax = day.pmax === undefined ? pressureBar : Math.max(day.pmax, pressureBar);
      day.ps = round((day.ps || 0) + pressureBar, 3);
      day.pn = (day.pn || 0) + 1;
    }
    const keys = Object.keys(this.days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - this.keepDays))) delete this.days[old];
  }

  // Called on every poll of the valve with the parsed reading.
  observe(r, run = null, holiday = false) {
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
      run: run ? { minutes: run.minutes, litres: run.litres, alert: run.alert === true } : null,
      holiday: holiday === true,
    };
    this.saveNow();
  }

  // The newest reading only, atomically. Cheap enough to do every poll.
  saveNow() {
    if (!this.latest) return;
    const dir = path.dirname(this.nowFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = `${this.nowFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 1, updated_at: this.latest.at, latest: this.latest }), { mode: 0o644 });
    fs.renameSync(tmp, this.nowFile);
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
    if (row.ok) this.addToDay(this.now(), row.used_l, row.pressure_bar);
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
      days: this.days,
      history: this.history,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o755 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o644 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Recorder, gaugeBar, localDate, DEFAULT_ATMOSPHERIC_BAR };
