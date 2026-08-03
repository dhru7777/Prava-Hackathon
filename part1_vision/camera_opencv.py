#!/usr/bin/env python3
"""OpenCV camera helpers for Continuity Camera / built-in webcam (macOS)."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
FRAMES_DIR = ROOT / "frames"


def open_camera(index: int = 0) -> cv2.VideoCapture:
    # AVFoundation is required for Continuity Camera / iPhone on macOS
    backend = getattr(cv2, "CAP_AVFOUNDATION", 0)
    cap = cv2.VideoCapture(index, backend) if backend else cv2.VideoCapture(index)
    if not cap.isOpened():
        cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise RuntimeError(
            f"Could not open camera index {index}.\n"
            "macOS fix:\n"
            "  System Settings → Privacy & Security → Camera\n"
            "  Enable Camera for Terminal AND Cursor\n"
            "Continuity Camera:\n"
            "  Unlock iPhone near Mac (same Apple ID, Wi‑Fi + Bluetooth)\n"
            "  Control Center / camera apps → select iPhone as camera\n"
            "Then retry: python camera_opencv.py --list"
        )
    return cap


def list_cameras(max_index: int = 6) -> list[tuple[int, bool, str]]:
    found: list[tuple[int, bool, str]] = []
    backend = getattr(cv2, "CAP_AVFOUNDATION", 0)
    for i in range(max_index):
        cap = cv2.VideoCapture(i, backend) if backend else cv2.VideoCapture(i)
        ok = cap.isOpened()
        info = ""
        if ok:
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            ret, frame = cap.read()
            info = f"{w}x{h} read={ret}"
            if ret and frame is not None:
                info += f" shape={frame.shape}"
        found.append((i, ok, info))
        cap.release()
    return found


def grab_jpeg(index: int = 0, warmup: int = 5) -> bytes:
    cap = open_camera(index)
    try:
        frame = None
        for _ in range(max(1, warmup)):
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.05)
        if frame is None:
            raise RuntimeError("Camera opened but no frame received")
        # BGR → encode JPEG
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not ok:
            raise RuntimeError("JPEG encode failed")
        return bytes(buf)
    finally:
        cap.release()


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenCV / Continuity Camera helper")
    parser.add_argument("--list", action="store_true", help="List camera indices")
    parser.add_argument("--index", type=int, default=0, help="Camera index")
    parser.add_argument("--shot", action="store_true", help="Save one JPEG from camera")
    parser.add_argument("--preview", action="store_true", help="Live preview window (q to quit)")
    args = parser.parse_args()

    if args.list:
        print("Probing cameras (grant Camera permission if macOS prompts)...")
        rows = list_cameras()
        any_ok = False
        for i, ok, info in rows:
            print(f"  [{i}] {'OK' if ok else '—'} {info}")
            any_ok = any_ok or ok
        if not any_ok:
            print(
                "\nNo cameras available. Enable Camera for Terminal/Cursor in System Settings,\n"
                "then connect Continuity Camera (iPhone) and run again.",
                file=sys.stderr,
            )
            sys.exit(1)
        return

    if args.preview:
        cap = open_camera(args.index)
        print("Preview open — press q to quit")
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    continue
                cv2.imshow("MilkWatch camera", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
        finally:
            cap.release()
            cv2.destroyAllWindows()
        return

    if args.shot:
        FRAMES_DIR.mkdir(parents=True, exist_ok=True)
        jpeg = grab_jpeg(args.index)
        path = FRAMES_DIR / f"opencv_{args.index}.jpg"
        path.write_bytes(jpeg)
        print(f"Saved {path} ({len(jpeg)} bytes)")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
