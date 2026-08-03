# AI Inventory Manager (Agentic Commerce Hackathon)

Fridge camera → iMessage agent (Linq) → discover/quote/pay (Prava / Visa sandbox).

## Local

```bash
# Part 1 UI
cd part1_vision && source .venv/bin/activate && python web_live.py
# → http://127.0.0.1:8765

# Part 2 Linq agent
cd part2_linq && npm start
# → :8787

# Part 3 Prava
cd part3_prava && npm start
# → :8788
```

Copy each folder’s `.env.example` → `.env` and fill keys.

## Railway

One service runs all three parts. Public URL is the Part 1 web UI (proxies Part 2/3).

Camera hardware is local-only; on Railway use chat / STATUS / Approve against live Linq + Prava sandbox.


## Links

- **GitHub:** https://github.com/dhru7777/Prava-Hackathon
- **Live demo (Railway):** https://web-production-1b465.up.railway.app
