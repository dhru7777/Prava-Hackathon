# Part 2 — Linq messaging (agentic restock)

TypeScript + `@linqapp/sdk`. Inbound iMessage webhook can trigger Part 3 (Prava) on **APPROVE**.

## Sandbox rules baked in

1. **Inbound-first** — you text the Linq number before the agent messages you. Primary path is webhook reply.
2. **First outbound on `POST /v3/chats`** — text only (no links). Links only in follow-ups on an existing `chat_id` (pay URL is sent as a follow-up after APPROVE).

## Setup

```bash
cd part2_linq
cp .env.example .env
# fill LINQ_API_KEY + LINQ_FROM_NUMBER + LINQ_TO_EMAIL
# PART3_API=http://127.0.0.1:8788
npm install
```

## Agentic commands (iMessage)

| You text | Agent does |
|----------|------------|
| `HI` / `HELP` | Intro + commands |
| `milk is low` | Suggest restock → ask APPROVE/SKIP |
| `APPROVE` | Part 3 discover → quote → **sandbox** pay link |
| `SKIP` | Cancel |
| `STATUS` | Inventory scan + Part 3 health |
| `LOCATION` | Request Linq location share (delivery address) |

Full activity map: see **[AGENT_FLOW.md](./AGENT_FLOW.md)**.

Requires Part 3 running with `PRAVA_SECRET_KEY=sk_test_…` (CARD-03: `…2200` / CVV `93` / exp `12/30` / OTP `456789`).
Set `AGENT_OPENAI_API_KEY` for natural-language brain (falls back to keywords if unset).

### Modular tests

```bash
npm run test:modules          # inventory + memory + context + orchestrator
npm run test:inventory        # csvStore / mapVision / scanner
npm run test:agent-brain      # OpenAI (needs AGENT_OPENAI_API_KEY)
```

### Vision → inventory

Part1 `web_live.py` posts each detection to `POST /api/inventory/vision-snapshot`,
which updates `data/inventory_current.csv` (appends unknown SKUs) and history.

## Location

```bash
curl -X POST http://127.0.0.1:8787/api/location/request   # prompts iPhone
curl http://127.0.0.1:8787/api/location                     # live or demo pin
```

If entitlement was missing you used to see Linq **403 / 2011**. When enabled, `location/request` returns `Location request sent` — accept the share in iMessage, then `GET /api/location` shows real coords (`source: "linq"`). Until accepted, UI uses the demo NYU pin.

## Run end-to-end

Terminal A — Part 2 webhook:

```bash
npm run start   # :8787
```

Terminal B — Part 3 (for APPROVE):

```bash
cd ../part3_prava && npm run start   # :8788
```

Terminal C — public HTTPS tunnel:

```bash
npx localtunnel --port 8787
# copy the https URL
```

Terminal D — subscribe webhook:

```bash
WEBHOOK_PUBLIC_URL=https://YOUR_TUNNEL_URL npm run subscribe
```

Optional — Part 1 UI (Q3 chat + Q4 offers):

```bash
cd ../part1_vision && python web_live.py   # :8765
```

Then on your iPhone: text Linq `hi`, then `APPROVE`.  
You should get a quote + `sandbox.collect` pay link.

Optional outbound create (only after you’ve texted them first):

```bash
npm run send
```

## Scripts

| Command | What |
|---------|------|
| `npm run start` | Express on `:8787` |
| `npm run subscribe` | Webhook → `message.received` |
| `npm run send` | `POST /v3/chats` text-only hello |
| `npm run test:part2` | 10-step terminal health checklist |
| `npm run test:part2 -- --live` | Same + attempt live Hello World send |
