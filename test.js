const assert = require('assert');
const { parseComponents } = require('./index.js');
const c = (key, role, value, id) => ({ key, config: { id }, attrs: { role }, status: { value } });
const r = parseComponents({ components: [
  c('boolean:200', 'state', true, 200), c('number:200', 'flow_rate', 0.012, 200),
  c('number:201', 'water_pressure', 312.5, 201), c('number:202', 'water_temperature', 18.4, 202),
  { key: 'object:200', attrs: { role: 'water_consumption' }, status: { value: {} } } ] });
assert.strictEqual(r.open, true);
assert.strictEqual(Math.round(r.flowLpm), 12);
assert.strictEqual(r.pressureKpa, 312.5);
assert.strictEqual(r.temperatureC, 18.4);
assert.throws(() => parseComponents({ components: [] }));
console.log('ok');
