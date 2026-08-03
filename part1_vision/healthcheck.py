#!/usr/bin/env python3
"""
Health check: Wi‑Fi, Iriun Mac app, OpenCV cameras, same-network hints.

Usage:
  python healthcheck.py
  python healthcheck.py --phone-ip 10.17.12.34   # optional: ping your iPhone IP
"""

from __future__ import annotations

import argparse
import platform
import shutil
import socket
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> str:
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
        return out.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def wifi_info() -> None:
    section("Mac Wi‑Fi / IP")
    ssid = run(["networksetup", "-getairportnetwork", "en0"])
    if not ssid:
        ssid = run(["networksetup", "-getairportnetwork", "en1"])
    print(ssid or "(could not read SSID)")
    for iface in ("en0", "en1", "bridge100"):
        ip = run(["ipconfig", "getifaddr", iface])
        if ip:
            print(f"{iface}: {ip}")
            if ip.startswith("192.0.0."):
                print("  ⚠ This IP looks like Private Relay / broken hotspot routing.")
                print("  → Iriun Wi‑Fi discovery often fails. Use USB cable, or turn off")
                print("    iPhone Settings → Wi‑Fi → Limit IP Address Tracking for hotspot,")
                print("    or disable VPN / iCloud Private Relay temporarily.")
    gw = ""
    for ln in run(["route", "-n", "get", "default"]).splitlines():
        if "gateway:" in ln:
            gw = ln.strip()
    if gw:
        print(gw)
    print(f"hostname: {socket.gethostname()}")
    print(f"OS: {platform.platform()}")


def iriun_status() -> None:
    section("Iriun Mac app")
    app = Path("/Applications/IriunWebcam.app")
    print(f"Installed: {'YES' if app.exists() else 'NO — install IriunWebcam for Mac'}")
    # process
    procs = run(["pgrep", "-fl", "-i", "iriun"])
    if procs:
        print("Running: YES")
        for line in procs.splitlines()[:5]:
            print(f"  {line}")
    else:
        print("Running: NO")
        print("  → Open /Applications/IriunWebcam.app and leave it open")
        print("  → Menu bar / window should say waiting for phone, then Connected")

    # common ports Iriun / helpers might use
    print("Listening ports (sample):")
    listen = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"])
    hits = [
        ln
        for ln in listen.splitlines()
        if any(k in ln.lower() for k in ("iriun", "python", "node"))
    ]
    if hits:
        for ln in hits[:15]:
            print(f"  {ln}")
    else:
        print("  (no obvious Iriun listener found — open the Mac app)")


def ping_host(ip: str) -> None:
    section(f"Reachability → {ip}")
    # mac ping: -c count
    out = run(["ping", "-c", "2", "-W", "1000", ip])
    if "bytes from" in out or "ttl=" in out.lower():
        print(f"PING OK — Mac can reach {ip}")
    else:
        print(f"PING FAIL — Mac cannot reach {ip}")
        print("  → Phone + Mac must be on same Wi‑Fi (or use USB in Iriun)")
        print("  → NYU/campus Wi‑Fi often blocks device-to-device; try Personal Hotspot")
    if out:
        # last lines only
        for ln in out.splitlines()[-4:]:
            print(f"  {ln}")


def camera_status() -> None:
    section("OpenCV cameras")
    try:
        import cv2
    except ImportError:
        print("opencv not installed in this venv")
        return

    backend = getattr(cv2, "CAP_AVFOUNDATION", 0)
    any_ok = False
    for i in range(4):
        cap = cv2.VideoCapture(i, backend) if backend else cv2.VideoCapture(i)
        ok = cap.isOpened()
        detail = ""
        if ok:
            ret, frame = cap.read()
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            detail = f"{w}x{h} read={ret}"
            if ret and frame is not None:
                # Detect Iriun placeholder (mostly black / text screen is still a valid frame)
                mean = float(frame.mean())
                detail += f" brightness≈{mean:.1f}"
                if mean < 15:
                    detail += " (very dark / maybe not connected)"
                any_ok = True
        print(f"  [{i}] {'OK' if ok else '—'} {detail}")
        cap.release()

    if not any_ok:
        print("No cameras readable. System Settings → Privacy → Camera → allow Terminal/Cursor")
    else:
        print("Tip: Iriun iPhone feed is usually camera index 1 after Mac app connects.")


def checklist() -> None:
    section("What to do on iPhone")
    print("1. Install/open Iriun Webcam on iPhone (App Store)")
    print("2. Allow Camera")
    print("3. Same Wi‑Fi as Mac OR plug USB and trust computer")
    print("4. Mac: IriunWebcam.app must stay open")
    print("5. When connected, Mac window shows live camera (not 'Please start Iriun Webcam')")
    print("6. Then run:")
    print("     python camera_opencv.py --shot --index 1")
    print("     python detect_outline.py --camera 1")


def main() -> None:
    parser = argparse.ArgumentParser(description="MilkWatch camera / Iriun health check")
    parser.add_argument(
        "--phone-ip",
        help="Optional iPhone LAN IP to ping (Settings → Wi‑Fi → (i) → IP Address)",
    )
    args = parser.parse_args()

    print("MilkWatch health check")
    wifi_info()
    iriun_status()
    camera_status()
    if args.phone_ip:
        ping_host(args.phone_ip.strip())
    else:
        section("Same Wi‑Fi check")
        print("To verify phone is reachable, find iPhone IP:")
        print("  iPhone Settings → Wi‑Fi → tap (i) next to network → IP Address")
        print("Then rerun:")
        print("  python healthcheck.py --phone-ip THAT_IP")
    checklist()
    print()


if __name__ == "__main__":
    main()
