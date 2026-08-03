"""FastAPI webhook: Linq message.received → APPROVE/SKIP (messaging only)."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from linq_client import LinqClient
from notify_stockout import (
    PART1_EVENTS,
    clear_pending,
    latest_stockout,
    load_pending,
    record_decision,
    save_pending,
)

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="MilkWatch Linq Messaging")
APPROVE_RE = re.compile(r"^\s*(APPROVE|YES|Y|BUY)\b", re.I)
SKIP_RE = re.compile(r"^\s*(SKIP|NO|N|CANCEL)\b", re.I)


def _extract_text(payload: dict) -> str:
    candidates = [payload.get("data"), payload.get("event"), payload]
    for block in candidates:
        if not isinstance(block, dict):
            continue
        msg = block.get("message")
        if msg is None and isinstance(block.get("data"), dict):
            msg = block["data"].get("message")
        if msg is None and "parts" in block:
            msg = block
        if not isinstance(msg, dict):
            continue
        parts = msg.get("parts") or []
        texts = [
            str(p.get("value") or "")
            for p in parts
            if isinstance(p, dict) and p.get("type") == "text"
        ]
        if texts:
            return " ".join(texts).strip()
    return ""


@app.get("/health")
def health() -> dict:
    return {"ok": True, "pending": load_pending() is not None}


@app.post("/linq/webhook")
async def linq_webhook(request: Request) -> JSONResponse:
    payload = await request.json()
    text = _extract_text(payload)
    pending = load_pending()
    print(f"[webhook] text={text!r} pending={bool(pending)}")

    if not pending:
        return JSONResponse({"ok": True, "ignored": "no_pending"})

    client = LinqClient()
    chat_id = pending.get("chat_id") or client.config.chat_id

    if SKIP_RE.search(text or ""):
        record = record_decision("skipped", pending)
        if chat_id:
            client.send_text(chat_id, "Got it — skipped. No restock.")
        clear_pending()
        return JSONResponse({"ok": True, "action": "skipped", "record": record})

    if APPROVE_RE.search(text or ""):
        record = record_decision("approved", pending)
        if chat_id:
            client.send_text(
                chat_id,
                "Approved. Restock request noted — order step is separate (Part 3).",
            )
        clear_pending()
        return JSONResponse({"ok": True, "action": "approved", "record": record})

    return JSONResponse({"ok": True, "ignored": "not_approve_or_skip", "text": text})


@app.post("/demo/notify")
async def demo_notify(request: Request) -> JSONResponse:
    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    stockout = body.get("stockout") or latest_stockout(PART1_EVENTS)
    client = LinqClient()
    chat_id = client.notify_stockout(
        state=str(stockout.get("state", "low")),
        fill_percent=stockout.get("fill_percent"),
        confidence=float(stockout.get("confidence") or 0),
        reason=str(stockout.get("reason") or ""),
        approval_url=os.getenv("APPROVAL_URL") or None,
    )
    save_pending(chat_id, stockout)
    return JSONResponse({"ok": True, "chat_id": chat_id})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8787")))
