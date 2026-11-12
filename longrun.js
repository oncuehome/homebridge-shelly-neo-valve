'use strict';

// Watches for water that has been running without a proper stop: a tap left on, a burst, a leak that never lets the
// flow reach zero. A "run" starts when the flow rises above a small threshold and ends once the flow has been zero for
// longer than a grace period (so a blip of zero between two polls does not split it). A run can trip an alert, and
// optionally a shut-off, after a number of minutes and/or litres. 0 turns a limit off.
const MIN_FLOW_LPM = 0.05;

class RunTracker {
  constructor({ alertMinutes = 30, alertLitres = 0, shutOffMinutes = 0, shutOffLitres = 0, graceMs = 90000 } = {}) {
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
    const flowing = typeof flowLpm === 'number' && flowLpm >= MIN_FLOW_LPM;
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

module.exports = { RunTracker, MIN_FLOW_LPM };
