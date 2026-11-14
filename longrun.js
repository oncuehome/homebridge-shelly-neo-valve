'use strict';

// Watches for water that has been running without a proper stop: a tap left on, a burst, a leak that never lets the
// flow reach zero. A "run" starts when the flow rises above a small threshold and ends once the flow has been zero for
// longer than a grace period (so a blip of zero between two polls does not split it). A run can trip an alert, and
// optionally a shut-off, after a number of minutes and/or litres. 0 turns a limit off.
const MIN_FLOW_LPM = 0.05;

class RunTracker {
  constructor({ alertMinutes = 30, alertLitres = 0, shutOffMinutes = 0, shutOffLitres = 0, graceMs = 90000, minFlowLpm = MIN_FLOW_LPM } = {}) {
    this.minFlowLpm = minFlowLpm;
    this.alertMinutes = alertMinutes;
    this.alertLitres = alertLitres;
    this.shutOffMinutes = shutOffMinutes;
    this.shutOffLitres = shutOffLitres;
    this.graceMs = graceMs;
    this.reset();
  }

  reset() {
    this.start = null;
    this.lastFlowAt = null;
    this.lastAt = null;
    this.startTotal = null;
    this.litres = 0;
  }

  // nowMs: time of this reading; flowLpm: litres per minute; totalL: the valve's water counter in litres, or null.
  update(nowMs, flowLpm, totalL) {
    const flowing = typeof flowLpm === 'number' && flowLpm >= this.minFlowLpm;
    let ended = false;
    if (flowing) {
      if (this.start === null) {
        this.start = nowMs;
        this.startTotal = typeof totalL === 'number' ? totalL : null;
        this.litres = 0;
      } else if (this.lastAt !== null) {
        this.litres += (flowLpm * (nowMs - this.lastAt)) / 60000;
      }
      // The valve's own counter is the better measure when it is there (and has not been reset mid-run).
      if (this.startTotal !== null && typeof totalL === 'number' && totalL >= this.startTotal) {
        this.litres = totalL - this.startTotal;
      }
      this.lastFlowAt = nowMs;
    } else if (this.start !== null && nowMs - this.lastFlowAt > this.graceMs) {
      this.reset();
      ended = true;
    }
    this.lastAt = nowMs;

    const active = this.start !== null;
    const minutes = active ? (nowMs - this.start) / 60000 : 0;
    const litres = active ? this.litres : 0;
    const over = (limitMin, limitL) => active && ((limitMin > 0 && minutes >= limitMin) || (limitL > 0 && litres >= limitL));
    return {
      active,
      ended,
      minutes: Math.round(minutes * 10) / 10,
      litres: Math.round(litres * 10) / 10,
      alert: over(this.alertMinutes, this.alertLitres),
      shutOff: over(this.shutOffMinutes, this.shutOffLitres),
    };
  }
}

// A daily window (the Pi's own clock) when holiday rules are ignored, for sprinklers and the like. "HH:MM" strings; the window
// may cross midnight (22:00 to 02:00). Empty or invalid means no window.
function minutesOfDay(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof text === 'string' ? text.trim() : '');
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
function inWindow(date, from, to) {
  const a = minutesOfDay(from), b = minutesOfDay(to);
  if (a === null || b === null || a === b) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return a < b ? now >= a && now < b : now >= a || now < b;
}

// Slow leaks: litres used over the last 24 hours while the rule is active (holiday mode on, outside any sprinkler window), from the
// valve's own water counter, so even a drip that never makes one long run adds up. Over the allowance trips the alert; it clears
// by itself once the used litres drop back under it. 0 turns it off. Counted in hourly buckets so memory is tiny.
class Allowance {
  constructor({ litres = 0, hours = 24 } = {}) {
    this.litres = litres;
    this.hours = hours;
    this.buckets = new Map();   // hour (ms since epoch / 3600000, floored) -> litres counted in it
    this.lastTotal = null;
  }

  reset() { this.buckets.clear(); this.lastTotal = null; }

  // nowMs: time of this reading; totalL: the valve's counter in litres or null; counting: whether this stretch counts.
  update(nowMs, totalL, counting) {
    if (typeof totalL === 'number') {
      // A counter that went down was reset: count from zero. Water used while not counting is skipped, not saved up.
      if (counting && this.lastTotal !== null) {
        const delta = totalL >= this.lastTotal ? totalL - this.lastTotal : totalL;
        const hour = Math.floor(nowMs / 3600000);
        this.buckets.set(hour, (this.buckets.get(hour) || 0) + delta);
      }
      this.lastTotal = totalL;
    }
    const oldest = Math.floor(nowMs / 3600000) - this.hours + 1;
    for (const h of [...this.buckets.keys()]) if (h < oldest) this.buckets.delete(h);
    const used = [...this.buckets.values()].reduce((a, b) => a + b, 0);
    return { litres: Math.round(used * 10) / 10, over: this.litres > 0 && used >= this.litres };
  }
}

// A nightly slow-leak test: in a short quiet window (say 03:00 for 5 minutes) the valve's water counter should not move. Passive:
// it only watches, it never closes the valve. More than the allowance in the window fails the test; the failure stays until a later
// night's window passes. A window with fewer than two readings (the plugin was down) gives no result either way.
class QuietTest {
  constructor({ at = '03:00', minutes = 5, allowanceLitres = 0.5 } = {}) {
    this.at = minutesOfDay(at);
    this.minutes = Math.max(1, minutes);
    this.allowance = allowanceLitres;
    this.enabled = this.at !== null;
    this.running = false;
    this.used = 0;
    this.readings = 0;
    this.lastTotal = null;
  }

  inside(date) {
    if (!this.enabled) return false;
    const now = date.getHours() * 60 + date.getMinutes();
    const end = this.at + this.minutes;
    return end <= 1440 ? now >= this.at && now < end : now >= this.at || now < end - 1440;
  }

  // Returns { running, litres, failing, result } where result is 'pass' or 'fail' only on the poll that ends a window.
  update(date, totalL) {
    const out = { running: false, litres: 0, failing: false, result: null };
    if (!this.enabled || typeof totalL !== 'number') { if (typeof totalL === 'number') this.lastTotal = totalL; return out; }
    if (this.inside(date)) {
      if (!this.running) { this.running = true; this.used = 0; this.readings = 0; }
      else if (this.lastTotal !== null) this.used += totalL >= this.lastTotal ? totalL - this.lastTotal : totalL;
      this.readings += 1;
      out.running = true;
      out.failing = this.used > this.allowance;
    } else if (this.running) {
      this.running = false;
      if (this.readings >= 2) out.result = this.used > this.allowance ? 'fail' : 'pass';
    }
    out.litres = Math.round(this.used * 100) / 100;
    this.lastTotal = totalL;
    return out;
  }
}

module.exports = { RunTracker, MIN_FLOW_LPM, inWindow, Allowance, QuietTest };
