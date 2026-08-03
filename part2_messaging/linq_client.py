"""Linq Partner API v3 thin client (requests). Supports DRY_RUN.

Part 2 ONLY — messaging. No payments / orders here.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Any

import requests

BASE_URL = "https://api.linqapp.com/api/partner/v3"


@dataclass
class LinqConfig:
    api_key: str
    from_number: str
    to_number: str
    dry_run: bool = False
    chat_id: str | None = None

    @classmethod
    def from_env(cls) -> "LinqConfig":
        dry = os.getenv("LINQ_DRY_RUN", "false").strip().lower() in {"1", "true", "yes"}
        key = os.getenv("LINQ_API_KEY", "").strip()
        from_n = os.getenv("LINQ_FROM_NUMBER", "").strip()
        to_n = os.getenv("LINQ_TO_NUMBER", "").strip()
        if not dry and (not key or not from_n or not to_n):
            raise RuntimeError(
                "Missing LINQ_API_KEY / LINQ_FROM_NUMBER / LINQ_TO_NUMBER. "
                "Set them in .env, or LINQ_DRY_RUN=true for local simulation."
            )
        return cls(
            api_key=key,
            from_number=from_n or "+10000000000",
            to_number=to_n or "+10000000001",
            dry_run=dry or not key,
            chat_id=os.getenv("LINQ_CHAT_ID", "").strip() or None,
        )


class LinqClient:
    def __init__(self, config: LinqConfig | None = None) -> None:
        self.config = config or LinqConfig.from_env()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    def create_chat(self, text: str) -> dict[str, Any]:
        """Create chat + first message. First message must NOT contain URLs (Linq rule)."""
        if self.config.dry_run:
            chat_id = self.config.chat_id or f"dry_chat_{uuid.uuid4().hex[:8]}"
            print(f"[LINQ DRY_RUN] create_chat from={self.config.from_number} to={self.config.to_number}")
            print(f"[LINQ DRY_RUN] text:\n{text}\n")
            return {"id": chat_id, "dry_run": True, "last_message": {"id": "dry_msg_1"}}

        payload = {
            "from": self.config.from_number,
            "to": [self.config.to_number],
            "message": {"parts": [{"type": "text", "value": text}]},
        }
        resp = requests.post(
            f"{BASE_URL}/chats",
            headers=self._headers(),
            json=payload,
            timeout=30,
        )
        if not resp.ok:
            raise RuntimeError(f"Linq create_chat failed {resp.status_code}: {resp.text}")
        data = resp.json()
        self.config.chat_id = data.get("id") or self.config.chat_id
        return data

    def send_text(self, chat_id: str, text: str) -> dict[str, Any]:
        if self.config.dry_run:
            print(f"[LINQ DRY_RUN] send_text chat={chat_id}\n{text}\n")
            return {"id": f"dry_msg_{uuid.uuid4().hex[:6]}", "dry_run": True}

        payload = {"parts": [{"type": "text", "value": text}]}
        resp = requests.post(
            f"{BASE_URL}/chats/{chat_id}/messages",
            headers=self._headers(),
            json=payload,
            timeout=30,
        )
        if not resp.ok:
            raise RuntimeError(f"Linq send_text failed {resp.status_code}: {resp.text}")
        return resp.json()

    def send_link(self, chat_id: str, url: str) -> dict[str, Any]:
        """Link parts must be alone in the message."""
        if self.config.dry_run:
            print(f"[LINQ DRY_RUN] send_link chat={chat_id} url={url}\n")
            return {"id": f"dry_link_{uuid.uuid4().hex[:6]}", "dry_run": True}

        payload = {"parts": [{"type": "link", "value": url}]}
        resp = requests.post(
            f"{BASE_URL}/chats/{chat_id}/messages",
            headers=self._headers(),
            json=payload,
            timeout=30,
        )
        if not resp.ok:
            raise RuntimeError(f"Linq send_link failed {resp.status_code}: {resp.text}")
        return resp.json()

    def notify_stockout(
        self,
        *,
        state: str,
        fill_percent: int | None,
        confidence: float,
        reason: str,
        approval_url: str | None = None,
    ) -> str:
        fill = f"{fill_percent}%" if fill_percent is not None else "n/a"
        text = (
            f"MilkWatch alert: milk looks {state} (fill≈{fill}, conf={confidence:.2f}).\n"
            f"{reason}\n\n"
            f"Reply APPROVE to restock, or SKIP to ignore."
        )
        if self.config.chat_id:
            self.send_text(self.config.chat_id, text)
            chat_id = self.config.chat_id
        else:
            chat = self.create_chat(text)
            chat_id = chat["id"]
            self.config.chat_id = chat_id

        if approval_url:
            try:
                self.send_link(chat_id, approval_url)
            except RuntimeError:
                self.send_text(chat_id, f"Approve here: {approval_url}")

        return chat_id
