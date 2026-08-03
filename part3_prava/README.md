# Part 3 — Prava discovery, quote, pay

Online milk/eggs discovery via Prava UCP → quote (address + quantity + delivery ETA) → passkey pay.

## Setup

```bash
cd part3_prava
npm install
npm run setup
npm run setup:poll
npm run status
# address already needed for quotes — see `npx prava shop address list`
```

### Sandbox pay (CARD-03)

Prava: **CLI & MCP are production-only** (real US/CA/SEA Visa). Team test card needs **SDK/API sandbox**.

1. Copy `.env.example` → `.env`
2. Set `PRAVA_SECRET_KEY=sk_test_…` from https://dashboard.prava.space
3. Pay will open `sandbox.collect.prava.space`
4. Card: `4622943123232200` / CVV `93` / exp `12/30` / OTP `456789`

```bash
# after quote:
npm run order -- --variant <id> --merchant beprepared.com --qty 1 --pay --sandbox
```

## API + standalone UI

```bash
cd part3_prava
npm install
# API :8788 + optional dedicated UI :8790
UI_PORT=8790 npm run start
# or: npm run start:ui
```

- **API + UI together:** http://127.0.0.1:8788/
- **UI on separate port:** http://127.0.0.1:8790/ (proxies API to :8788)
- **Pay config:** `GET /api/part3/pay-config`

Discover only searches products (no auto-quote). Click **Quote** on **one** offer at a time — Prava rejects many parallel open checkouts.

## CLI

```bash
npm run test:discover
npm run order -- --variant <id> --merchant rootedraymond.com --qty 2
# sandbox pay (CARD-03):
npm run order -- --variant <id> --merchant beprepared.com --qty 1 --pay --sandbox
# live pay (real Visa):
npm run order -- --variant <id> --merchant beprepared.com --qty 1 --pay --live
```

## UI

With Part 3 running, open Part 1 live UI (`python web_live.py`) — **Q4** polls offers, lets you set quantity, quote, and pay.
