// Fortpesa API client + webhook signature verification
const crypto = require('crypto');

const API_BASE = process.env.FORTPESA_API_BASE || 'https://fortpesa.co.ke/api/v1';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Header: X-Fortpesa-Signature: sha256=HMAC-SHA256("{timestamp}.{raw_body}", whsec_...)
// Rejects timestamps outside a 5 minute window (replay protection).
function verifySignature(rawBody, sigHeader, tsHeader, secret) {
  if (!secret || !sigHeader || !tsHeader) return false;
  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const hex = crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  return safeEqual(`sha256=${hex}`, String(sigHeader).trim());
}

async function api(method, endpoint, body, extraHeaders = {}) {
  const res = await fetch(API_BASE + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.FORTPESA_API_KEY || ''}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error?.message || `HTTP ${res.status}`);
    e.code = json.error?.code;
    e.status = res.status;
    throw e;
  }
  return json.data;
}

// 07XXXXXXXX / 01XXXXXXXX / +254... / 254... -> 254XXXXXXXXX (or null)
function normalizePhone(input) {
  let p = String(input || '').replace(/[\s\-+]/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

module.exports = { api, verifySignature, normalizePhone, safeEqual };
