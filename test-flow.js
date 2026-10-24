// Self-test: fake Fortpesa API + real app. Run: node test-flow.js
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SECRET = 'whsec_test';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
let stkBody = null;

const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/payments/stk') {
      stkBody = JSON.parse(b);
      return res.writeHead(201).end(JSON.stringify({ data: { uuid: UUID, status: 'pending' } }));
    }
    if (req.url === `/api/v1/transactions/${UUID}`) {
      return res.end(JSON.stringify({ data: { uuid: UUID, status: 'success', amount: 150 } }));
    }
    res.writeHead(404).end('{}');
  });
});

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

(async () => {
  await new Promise((r) => fake.listen(4555, r));
  const app = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '3222', FORTPESA_API_BASE: 'http://localhost:4555/api/v1', FORTPESA_API_KEY: 'pb_live_x',
      FORTPESA_CHANNEL_ID: '42', FORTPESA_WEBHOOK_SECRET: SECRET, OVERLAY_TOKEN: 'tok' },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 1500));

  const alerts = [];
  const ws = new WebSocket('ws://localhost:3222/ws?token=tok');
  ws.on('message', (m) => alerts.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));

  const d = await (await post('http://localhost:3222/api/donate', JSON.stringify({ amount: 150, phone: '0712345678', name: 'Wanjiku', message: 'Hongera!' }))).json();
  console.log('donate ->', d.uuid === UUID, 'phone sent:', stkBody.phone, 'channel:', stkBody.channel_id);

  const raw = JSON.stringify({ event: 'transaction.updated', data: { uuid: UUID, status: 'success' } });
  const sign = (ts) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  const ts = Math.floor(Date.now() / 1000);
  const good = { 'X-Fortpesa-Signature': sign(ts), 'X-Fortpesa-Timestamp': String(ts) };

  const bad = await post('http://localhost:3222/webhook/fortpesa', raw, { ...good, 'X-Fortpesa-Signature': 'sha256=00' });
  const old = await post('http://localhost:3222/webhook/fortpesa', raw, { 'X-Fortpesa-Signature': sign(ts - 1000), 'X-Fortpesa-Timestamp': String(ts - 1000) });
  const ok = await post('http://localhost:3222/webhook/fortpesa', raw, good);
  await post('http://localhost:3222/webhook/fortpesa', raw, good); // retry
  await new Promise((r) => setTimeout(r, 500));

  console.log('badsig:', bad.status, 'stale:', old.status, 'valid:', ok.status);
  console.log('alerts received:', alerts.length, JSON.stringify(alerts[0]));
  const pass = bad.status === 401 && old.status === 401 && ok.status === 200 && alerts.length === 1 && alerts[0].name === 'Wanjiku' && alerts[0].amount === 150 && stkBody.phone === '254712345678';
  console.log(pass ? 'PASS' : 'FAIL');
  ws.close(); app.kill(); fake.close();
  process.exit(pass ? 0 : 1);
})();
