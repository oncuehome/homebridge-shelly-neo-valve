const assert = require('assert');
const { parseComponents } = require('./index.js');
const c = (key, role, value, id) => ({ key, config: { id }, attrs: { role }, status: { value } });
const r = parseComponents({ components: [
  c('boolean:200', 'state', true, 200), c('number:200', 'flow_rate', 0.012, 200),
  c('number:201', 'water_pressure', 312.5, 201), c('number:202', 'water_temperature', 18.4, 202),
  { key: 'object:200', attrs: { role: 'water_consumption' }, status: { value: {} } } ] });
assert.strictEqual(r.open, true);
assert.strictEqual(Math.round(r.flowLpm), 12);
assert.strictEqual(r.pressureBar, 3.125);
assert.strictEqual(r.temperatureC, 18.4);
assert.throws(() => parseComponents({ components: [] }));
console.log('ok');

// Digest auth against a mock Shelly that checks the SHA-256 response the way a device does.
const http = require('http'), crypto = require('crypto');
const { digestHeader } = require('./index.js');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const srv = http.createServer((req, res) => {
  const a = req.headers.authorization;
  const ok = a && (() => { const p = {}; for (const m of a.matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) p[m[1]] = m[3] ?? m[2];
    const exp = sha(`${sha('admin:neo:secret')}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${sha(`${req.method}:${p.uri}`)}`);
    return p.username === 'admin' && p.response === exp; })();
  if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth", realm="neo", nonce="abc123", algorithm=SHA-256' }); return res.end(); }
  res.end('{"ok":true}');
});
srv.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}/rpc/x`;
  const first = await fetch(url);
  assert.strictEqual(first.status, 401);
  const good = await fetch(url, { headers: { Authorization: digestHeader(first.headers.get('www-authenticate'), 'admin', 'secret', 'GET', '/rpc/x') } });
  assert.strictEqual(good.status, 200);
  const bad = await fetch(url, { headers: { Authorization: digestHeader(first.headers.get('www-authenticate'), 'admin', 'wrong', 'GET', '/rpc/x') } });
  assert.strictEqual(bad.status, 401);
  console.log('digest ok'); srv.close();
});
