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

- OpenCV needs a real local camera device. The Railway web app cannot open your laptop or phone camera, so Live/Detect has no video feed on the hosted URL.
- Full camera demo only works on localhost (`:8765`) with webcam or Continuity Camera.
- Continuity Camera is macOS-local only. It does not stream through a remote server.
- Camera index can change when devices reconnect. If the feed is blank, switch the camera index in the UI.
- Hosted demo still supports chat, Approve, Linq messaging, and Prava/Visa sandbox pay without the camera.
