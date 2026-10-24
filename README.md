# FortPesa Donation Alerts (OBS Browser Source)

Viewer pays via M-Pesa STK push, FortPesa calls your webhook, and an alert pops up in OBS over WebSocket.

```
public/index.html -> POST /api/donate -> Fortpesa STK push -> viewer's phone
Fortpesa -> POST /webhook/fortpesa (HMAC verified, tx re-fetched) -> WS /ws -> public/overlay.html (OBS)
```

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in: `FORTPESA_API_KEY` (pb_live_...), `FORTPESA_CHANNEL_ID` (integer from Channels page), `FORTPESA_WEBHOOK_SECRET` (whsec_...), `OVERLAY_TOKEN`.
3. Top up your Fortpesa wallet (platform fees are prepaid; an empty wallet returns HTTP 402).
4. `npm start`
5. Donor page: `http://localhost:3000/` . OBS Browser Source: `http://localhost:3000/overlay.html?token=YOUR_TOKEN` (options: `&tts=0`, `&minTts=100`, `&duration=10000`).
6. Expose over HTTPS (cloudflared/ngrok/VPS) and register `https://YOUR_HOST/webhook/fortpesa` as the webhook URL in the Fortpesa dashboard.

## Fortpesa specifics implemented (per https://fortpesa.co.ke/skill)
- STK push with integer KES amount, `254XXXXXXXXX` phone (07.../+254... auto-normalised), `channel_id`, and a fresh `Idempotency-Key`.
- Webhook signature: `sha256=HMAC-SHA256("{timestamp}.{raw_body}", whsec_...)`, 5 minute replay window, constant-time compare.
- After a valid webhook the transaction is re-fetched via `GET /transactions/{uuid}`; only that result triggers the alert.
- Replies 2xx immediately; duplicate deliveries are ignored.

## Testing
- `node test-flow.js` runs the whole flow against a fake Fortpesa API (signature, replay, dedupe, alert).
- `POST /test/donate` (with `ENABLE_TEST=1`) fires a fake alert to preview the overlay.

## Limitations
Donor name/message are held in memory until the webhook arrives (lost on restart; use SQLite/Redis for production). Never commit `.env`; rotate any key you paste into chats.
