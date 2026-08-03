# Part 2 — Messaging ONLY (Linq)

Architecture (strict):

1. Part 1 emits stockout  
2. Part 2 sends iMessage via Linq  
3. User replies APPROVE or SKIP  
4. Part 2 records the decision in `approvals.jsonl` and acks on iMessage  

**No Prava. No checkout. No payments.** That is Part 3 — you dictate when.

## Setup

```bash
cd part2_messaging
cp .env.example .env
# LINQ_DRY_RUN=true  until you have sandbox keys
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Linq sandbox: https://dashboard.linqapp.com/sandbox-signup/

## Commands

```bash
python notify_stockout.py                 # send alert from latest Part 1 event
python notify_stockout.py --simulate-approve   # record APPROVE (messaging only)
python notify_stockout.py --simulate-skip
```

Webhook (inbound replies): `uvicorn server:app --port 8787` → `/linq/webhook`
