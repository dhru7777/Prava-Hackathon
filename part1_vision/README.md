# Part 1 — Live milk recognition (Android IP Webcam → OpenAI vision)

## Setup

1. Phone: open **IP Webcam Pro** → **Start server**. Note the URL (e.g. `http://192.168.12.248:8080`).
2. Laptop on the **same Wi‑Fi**. Browser-check: open that URL, then `/shot.jpg`.
3. On this machine:

```bash
cd part1_vision
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env — set IP_WEBCAM_URL and either OPENAI_API_KEY or ANTHROPIC_API_KEY
# VISION_PROVIDER=openai|anthropic
```

## Commands

```bash
# 1) Camera only (no API key needed)
python classify_live.py --test-shot

# 2) One classification
python classify_live.py --once

# 3) Live loop (every ~10s, debounce 2 → stockout in events.jsonl)
python classify_live.py
```

Frames land in `frames/`. Stockout events append to `events.jsonl`.

If the phone IP changes, update `IP_WEBCAM_URL` in `.env` or pass `--url http://NEW_IP:8080`.
