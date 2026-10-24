// Loads .env (simple parser, no extra dependency)
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { api, verifySignature, normalizePhone, safeEqual } = require('./fortpesa');

const PORT = process.env.PORT || 3000;
const CHANNEL_ID = parseInt(process.env.FORTPESA_CHANNEL_ID || '', 10);
const WEBHOOK_SECRET = process.env.FORTPESA_WEBHOOK_SECRET || '';
const OVERLAY_TOKEN = process.env.OVERLAY_TOKEN || '';
const MIN_AMOUNT = parseInt(process.env.MIN_AMOUNT || '10', 10);
const ENABLE_TEST = process.env.ENABLE_TEST === '1';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Donor name/message, keyed by Fortpesa transaction uuid (webhooks don't carry them).
// In-memory: lost on restart; use Redis/DB in production.
const pending = new Map();
const alerted = new Set(); // dedupe retried webhooks

function broadcast(alert) {
  const data = JSON.stringify({ type: 'donation', ...alert });
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

const FRIENDLY = {
  INSUFFICIENT_BALANCE: 'Donations are temporarily unavailable.',
  CHANNEL_NOT_APPROVED: 'Donations are temporarily unavailable.',
  RATE_LIMITED: 'Too many requests, try again shortly.',
};

// Donor page -> triggers the M-Pesa STK prompt on the donor's phone.
app.post('/api/donate', express.json({ limit: '10kb' }), async (req, res) => {
  const amount = Number(req.body.amount);
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 40) || 'Anonymous';
  const message = String(req.body.message || '').trim().slice(0, 200);
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > 150000) {
    return res.status(422).json({ error: `Amount must be a whole number of KES, at least ${MIN_AMOUNT}.` });
  }
  if (!phone) return res.status(422).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678.' });
  if (!process.env.FORTPESA_API_KEY || !Number.isInteger(CHANNEL_ID)) {
    return res.status(500).json({ error: 'Server not configured.' });
  }
  try {
    const tx = await api('POST', '/payments/stk', {
      amount, phone, channel_id: CHANNEL_ID,
      account_reference: 'DONATION', description: 'Donation',
    }, { 'Idempotency-Key': 'don-' + crypto.randomUUID() });
    pending.set(tx.uuid, { name, message });
    setTimeout(() => pending.delete(tx.uuid), 30 * 60 * 1000);
    res.status(201).json({ uuid: tx.uuid, status: tx.status });
  } catch (e) {
    console.error('stk error:', e.code, e.message);
    const msg = e.code === 'VALIDATION_ERROR' ? e.message : FRIENDLY[e.code] || 'Could not start payment. Please try again.';
    res.status(e.status === 422 ? 422 : 502).json({ error: msg });
  }
});

// Donor page polls this; only exposes the status, and only for uuids we created.
app.get('/api/donate/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(uuid) || !(pending.has(uuid) || alerted.has(uuid))) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    res.json({ status: (await api('GET', `/transactions/${uuid}`)).status });
  } catch { res.status(502).json({ error: 'Lookup failed' }); }
});

// Webhook: verify HMAC on the raw body, then re-fetch the transaction and trust only that.
app.post('/webhook/fortpesa', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  const h = req.headers;
  if (!verifySignature(req.body, h['x-fortpesa-signature'], h['x-fortpesa-timestamp'], WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }
  let uuid;
  try { uuid = JSON.parse(req.body.toString('utf8'))?.data?.uuid; } catch { return res.sendStatus(400); }
  if (!uuid) return res.sendStatus(400);
  res.sendStatus(200); // ack fast, then process

  try {
    const tx = await api('GET', `/transactions/${uuid}`);
    if (tx.status !== 'success' || alerted.has(uuid)) return;
    const info = pending.get(uuid) || { name: 'Anonymous', message: '' };
    alerted.add(uuid);
    pending.delete(uuid);
    broadcast({ id: uuid, amount: tx.amount, currency: 'KES', name: info.name, message: info.message });
    console.log('alert sent for', uuid);
  } catch (e) { console.error('webhook processing failed:', e.message); }
});

if (ENABLE_TEST) {
  app.post('/test/donate', express.json(), (req, res) => {
    broadcast({ id: 'test-' + Date.now(), amount: 100, currency: 'KES', name: 'Test Fan', message: 'Asante sana! Keep streaming!', ...req.body });
    res.json({ status: 'sent' });
  });
}

app.use(express.static(path.join(__dirname, 'public')));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || (OVERLAY_TOKEN && !safeEqual(url.searchParams.get('token') || '', OVERLAY_TOKEN))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 25000);

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
