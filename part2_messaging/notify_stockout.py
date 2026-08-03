"""Part 2 — Messaging only: stockout → Linq notify → APPROVE/SKIP ack.

No Prava. No orders. Approval is recorded for Part 3 to consume later.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from linq_client import LinqClient

ROOT = Path(__file__).resolve().parent
PART1_EVENTS = ROOT.parent / "part1_vision" / "events.jsonl"
PENDING_PATH = ROOT / "pending_approval.json"
APPROVALS_PATH = ROOT / "approvals.jsonl"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_dotenv_files() -> None:
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT.parent / "part1_vision" / ".env")


def latest_stockout(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"No events file at {path}. Run Part 1 first.")
    lines = [ln for ln in path.read_text().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError("events.jsonl is empty — trigger a low/empty classify first.")
    return json.loads(lines[-1])


def save_pending(chat_id: str, stockout: dict) -> None:
    data = {
        "chat_id": chat_id,
        "stockout": stockout,
        "status": "awaiting_approval",
        "updated_at": utc_now(),
    }
    PENDING_PATH.write_text(json.dumps(data, indent=2))


def load_pending() -> dict | None:
    if not PENDING_PATH.exists():
        return None
    return json.loads(PENDING_PATH.read_text())


def clear_pending() -> None:
    if PENDING_PATH.exists():
        PENDING_PATH.unlink()


def record_decision(decision: str, pending: dict) -> dict:
    """Messaging-layer outcome only — Part 3 reads approvals.jsonl later."""
    record = {
        "decision": decision,  # approved | skipped
        "chat_id": pending.get("chat_id"),
        "stockout": pending.get("stockout"),
        "timestamp": utc_now(),
    }
    with APPROVALS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    return record


def notify_from_event(event_path: Path, approval_url: str | None) -> str:
    stockout = latest_stockout(event_path)
    client = LinqClient()
    chat_id = client.notify_stockout(
        state=str(stockout.get("state", "low")),
        fill_percent=stockout.get("fill_percent"),
        confidence=float(stockout.get("confidence") or 0),
        reason=str(stockout.get("reason") or ""),
        approval_url=approval_url,
    )
    save_pending(chat_id, stockout)
    print(f"Notified. chat_id={chat_id} pending → {PENDING_PATH.name}")
    return chat_id


def simulate_reply(reply: str) -> None:
    """Local test without webhook: APPROVE / SKIP (messaging ack only)."""
    pending = load_pending()
    if not pending:
        raise RuntimeError("No pending_approval.json — run notify first.")
    client = LinqClient()
    chat_id = pending["chat_id"]
    text = reply.strip().upper()

    if text.startswith("SKIP") or text.startswith("NO"):
        record_decision("skipped", pending)
        client.send_text(chat_id, "Got it — skipped. No restock.")
        clear_pending()
        print("Messaging: SKIP recorded.")
        return

    if text.startswith("APPROVE") or text.startswith("YES"):
        record_decision("approved", pending)
        client.send_text(
            chat_id,
            "Approved. Restock request noted — order step is separate (Part 3).",
        )
        clear_pending()
        print("Messaging: APPROVE recorded → approvals.jsonl")
        return

    raise RuntimeError("Reply must start with APPROVE or SKIP")


def main() -> None:
    load_dotenv_files()
    parser = argparse.ArgumentParser(description="Part 2 — Linq messaging only")
    parser.add_argument("--events", type=Path, default=PART1_EVENTS)
    parser.add_argument(
        "--approval-url",
        default=os.getenv("APPROVAL_URL", "").strip() or None,
    )
    parser.add_argument("--simulate-approve", action="store_true")
    parser.add_argument("--simulate-skip", action="store_true")
    args = parser.parse_args()

    if args.simulate_approve:
        simulate_reply("APPROVE")
        return
    if args.simulate_skip:
        simulate_reply("SKIP")
        return

    notify_from_event(args.events, args.approval_url)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
