#!/usr/bin/env python3
"""Update IP_WEBCAM_URL and verify shot.jpg works."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv, set_key

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"


def normalize_url(raw: str) -> str:
    raw = raw.strip().rstrip("/")
    if not raw.startswith("http"):
        raw = "http://" + raw
    # Allow pasting .../shot.jpg or bare host:port
    raw = re.sub(r"/shot\.jpg/?$", "", raw)
    return raw


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="IP Webcam URL from phone, e.g. http://10.17.x.x:8080")
    args = parser.parse_args()
    base = normalize_url(args.url)
    shot = f"{base}/shot.jpg"

    print(f"Testing {shot} ...")
    try:
        r = requests.get(shot, timeout=5)
        r.raise_for_status()
        if len(r.content) < 1000:
            raise RuntimeError("Response too small — not a camera JPEG?")
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}")
        print(
            "\nIf this fails on NYU Wi‑Fi, use a hotspot:\n"
            "  1) Phone: Personal Hotspot ON\n"
            "  2) Laptop join that hotspot\n"
            "  3) IP Webcam → Start server → paste the NEW http://…:8080 URL here"
        )
        sys.exit(1)

    if not ENV_PATH.exists():
        ENV_PATH.write_text("IP_WEBCAM_URL=\n")
    load_dotenv(ENV_PATH)
    set_key(str(ENV_PATH), "IP_WEBCAM_URL", base)
    print(f"OK — saved IP_WEBCAM_URL={base} ({len(r.content)} bytes)")
    print("Next: python detect_outline.py   OR   python classify_live.py --once")


if __name__ == "__main__":
    main()
