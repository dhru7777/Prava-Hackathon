# AI Inventory Manager

Fridge camera → iMessage agent (Linq) → discover / quote / pay (Prava · Visa sandbox).

Detects low milk or eggs, texts you on iMessage, and restocks after you approve.

## Links

- **Live demo:** https://web-production-1b465.up.railway.app
- **Repo:** https://github.com/dhru7777/Prava-Hackathon

## Stack

- OpenCV + FastAPI (camera UI)
- Linq (iMessage)
- Prava / Visa (sandbox pay)
- OpenAI (vision + agent)

## Run locally

```bash
# Part 1 — web UI + camera
cd part1_vision && source .venv/bin/activate && python web_live.py
# http://127.0.0.1:8765

# Part 2 — Linq agent
cd part2_linq && npm start

# Part 3 — Prava pay
cd part3_prava && npm start
```

Copy each `.env.example` → `.env` and fill keys.

## Limitations

**OpenCV / camera (web app)**

- OpenCV cannot open a laptop or phone camera on Railway. The hosted Live quadrant uses a static **Live dummy** fridge still (`part1_vision/assets/dummy_fridge.png`).
- Detect still runs the same flow on that image (vision → Needed alert → Approve → Prava pay).
- Real webcam / Continuity Camera only works on localhost. Set `USE_DUMMY_FEED=false` locally to force a real camera.
- Continuity Camera is macOS-local only and does not stream through a remote server.
