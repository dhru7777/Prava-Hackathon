# MilkWatch agent — activity breakdown (modular)

## Goal
Vision + café inventory CSVs + OpenAI brain + Linq iMessage + Prava discover/pay,
with **human-in-the-loop** for confirmation and **location → delivery address**.

## End-to-end activity (happy path)

```text
1. Human texts STATUS on iMessage
       │
       ▼
2. Dummy vision fixture (or live Part1 if STATUS_USE_CAMERA=1)
       │  update inventory_current.csv
       ▼
3. OpenAI writes short fridge status → Linq reply
       │
       ▼
4. Human APPROVE → discover options → quote → sandbox pay link
       │
       ▼
5. Payment successful → iMessage confirm
```

STATUS env (optional):
```bash
STATUS_VISION_CASE=half   # full | half | empty (else rotates by minute)
STATUS_USE_CAMERA=false   # true → POST Part1 /api/detect
PART1_API=http://127.0.0.1:8765
```


## Modules (each runnable alone)

| Module | Path | Test |
|--------|------|------|
| CSV store | `src/inventory/csvStore.ts` | `npm run test:inventory` |
| Vision map | `src/inventory/mapVision.ts` | `npm run test:inventory` |
| Scanner | `src/inventory/scanner.ts` | `npm run test:inventory` |
| Context pack | `src/agent/context.ts` | `npm run test:agent-context` |
| OpenAI brain | `src/agent/openaiBrain.ts` | `npm run test:agent-brain` (needs key) |
| Orchestrator | `src/agent/orchestrator.ts` | `npm run test:orchestrator` |
| Linq webhook | `src/http/webhookRoutes.ts` | `npx tsx src/http/webhookRoutes.ts` |
| Part3 client | `src/agent/part3Client.ts` | (live Part3) |

## Env
```bash
# part2_linq/.env
AGENT_OPENAI_API_KEY=sk-...   # dedicated agent key (not vision)
AGENT_OPENAI_MODEL=gpt-4o
PART3_API=http://127.0.0.1:8788
AUTO_ALERT=true
RUNWAY_ALERT_DAYS=2.5
```

## What “smart” means here
- **Deterministic tools** for inventory/orders/location/Part3 (testable).
- **OpenAI** for natural language + which tool to call next (prompt + memory).
- Fallback to keyword `replyPolicy` if no `AGENT_OPENAI_API_KEY`.
