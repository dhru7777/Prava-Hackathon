#!/usr/bin/env python3
"""
MilkWatch Live — local website

Layout (top half):
  Q1 live camera  |  Q2 object detection result
  Q3 (empty)      |  Q4 (empty)

  python web_live.py
  → http://127.0.0.1:8765

Real-time: timer captures from live camera and runs detection on an interval.
Terminal prints a rolling health check.
"""

from __future__ import annotations

import sys

import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Generator

import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

from detect_outline import (  # noqa: E402
    compress,
    detect_anthropic,
    detect_openai,
    draw_boxes,
)

app = FastAPI(title="Hackathon Prava Payments")
OUT_DIR = ROOT / "frames" / "outlined"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Upstream APIs proxied same-origin (browser often blocks :8765 → :8787/:8788)
PART2_UPSTREAM = os.getenv("PART2_API", "http://127.0.0.1:8787").rstrip("/")
PART3_UPSTREAM = os.getenv("PART3_API", "http://127.0.0.1:8788").rstrip("/")


def _push_vision_inventory(objects: list) -> None:
    """Best-effort: update Part2 inventory_current.csv from this detection."""
    payload = json.dumps(
        {"objects": objects, "alert": True},
        separators=(",", ":"),
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{PART2_UPSTREAM}/api/inventory/vision-snapshot",
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        print(f"[detect] part2 inventory ← HTTP {resp.status} {raw[:160]}")


def _proxy_json(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    timeout: float = 30,
    offline_hint: str = "",
) -> JSONResponse:
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = body
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                payload = {"raw": raw.decode("utf-8", errors="replace")}
            return JSONResponse(payload, status_code=resp.status)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {"error": raw.decode("utf-8", errors="replace") or str(e)}
        return JSONResponse(payload, status_code=e.code)
    except Exception as e:
        return JSONResponse(
            {
                "error": f"Upstream unreachable ({url}): {e}",
                "hint": offline_hint,
            },
            status_code=502,
        )


def _proxy_part3(path: str, method: str = "GET", body: bytes | None = None) -> JSONResponse:
    url = f"{PART3_UPSTREAM}/api/part3/{path.lstrip('/')}"
    return _proxy_json(
        url,
        method=method,
        body=body,
        timeout=600,
        offline_hint="Run: cd part3_prava && npm run start",
    )

CAMERA_LABELS = {
    0: "Laptop",
    1: "Phone",
    2: "Phone (Continuity)",
}

DUMMY_PATH = ROOT / "assets" / "dummy_fridge.png"
# true/yes = always dummy | false/no = real camera only | auto = dummy if camera fails
_USE_DUMMY_RAW = (os.getenv("USE_DUMMY_FEED") or "auto").strip().lower()

# Active live camera shown in Q1 (switchable)
STATE_LOCK = threading.Lock()
ACTIVE_CAMERA = int(os.getenv("CAMERA_INDEX", "0"))
DETECT_INTERVAL_SEC = float(os.getenv("DETECT_INTERVAL_SEC", "8"))
AUTO_DETECT = os.getenv("AUTO_DETECT", "false").strip().lower() in {"1", "true", "yes"}

STREAMS: dict[int, "CameraStream"] = {}
LAST_DETECT: dict = {
    "path": None,
    "objects": [],
    "usage": {},
    "camera": None,
    "error": None,
    "at": None,
    "running": False,
}


def load_dummy_bgr() -> np.ndarray:
    """Static fridge still used when OpenCV has no camera (e.g. Railway)."""
    img = cv2.imread(str(DUMMY_PATH))
    if img is None:
        blank = np.full((720, 1280, 3), 36, dtype=np.uint8)
        cv2.putText(
            blank,
            "Dummy feed missing",
            (40, 360),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.2,
            (220, 220, 220),
            2,
        )
        return blank
    return img


class CameraStream:
    def __init__(self, index: int) -> None:
        self.index = index
        self._lock = threading.Lock()
        self._cap: cv2.VideoCapture | None = None
        self._frame: np.ndarray | None = None
        self._running = False
        self._thread: threading.Thread | None = None
        self._error: str | None = None
        self._frames = 0
        self._using_dummy = False

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None
        with self._lock:
            if self._cap is not None:
                self._cap.release()
                self._cap = None

    def _open(self) -> cv2.VideoCapture:
        backend = getattr(cv2, "CAP_AVFOUNDATION", 0)
        cap = (
            cv2.VideoCapture(self.index, backend)
            if backend
            else cv2.VideoCapture(self.index)
        )
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open camera {self.index}")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        return cap

    def _loop_dummy(self) -> None:
        frame = load_dummy_bgr()
        self._using_dummy = True
        self._error = None
        print(f"[camera] using dummy feed ({DUMMY_PATH.name}) for index {self.index}")
        while self._running:
            with self._lock:
                self._frame = frame
                self._frames += 1
            time.sleep(0.2)

    def _loop(self) -> None:
        force_dummy = _USE_DUMMY_RAW in {"1", "true", "yes", "dummy"}
        never_dummy = _USE_DUMMY_RAW in {"0", "false", "no", "camera"}

        if force_dummy:
            self._loop_dummy()
            return

        try:
            self._cap = self._open()
            self._error = None
            self._using_dummy = False
        except Exception as exc:  # noqa: BLE001
            if never_dummy:
                self._error = str(exc)
                self._running = False
                return
            print(f"[camera] open failed ({exc}); falling back to dummy feed")
            self._loop_dummy()
            return

        while self._running:
            assert self._cap is not None
            ret, frame = self._cap.read()
            if not ret or frame is None:
                time.sleep(0.05)
                continue
            with self._lock:
                self._frame = frame
                self._frames += 1
                self._using_dummy = False
            time.sleep(0.03)

        with self._lock:
            if self._cap is not None:
                self._cap.release()
                self._cap = None

    def get_jpeg(self, quality: int = 70) -> bytes | None:
        with self._lock:
            frame = None if self._frame is None else self._frame.copy()
        if frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return bytes(buf) if ok else None

    def get_bgr(self) -> np.ndarray | None:
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    def status(self) -> dict:
        with self._lock:
            has = self._frame is not None
            frames = self._frames
            err = self._error
            dummy = self._using_dummy
        return {
            "index": self.index,
            "label": "Live dummy" if dummy else CAMERA_LABELS.get(self.index, f"cam {self.index}"),
            "running": self._running,
            "has_frame": has,
            "frames": frames,
            "error": err,
            "dummy": dummy,
        }


def ensure_stream(index: int) -> CameraStream:
    stream = STREAMS.get(index)
    if stream is None:
        stream = CameraStream(index)
        STREAMS[index] = stream
    stream.start()
    return stream


def set_active_camera(index: int) -> int:
    global ACTIVE_CAMERA
    with STATE_LOCK:
        # Stop other streams to free Continuity / webcam exclusive access
        for i, s in list(STREAMS.items()):
            if i != index:
                s.stop()
                STREAMS.pop(i, None)
        ACTIVE_CAMERA = index
    ensure_stream(index)
    return index


def mjpeg_active() -> Generator[bytes, None, None]:
    boundary = b"--frame"
    while True:
        with STATE_LOCK:
            idx = ACTIVE_CAMERA
        stream = ensure_stream(idx)
        jpeg = stream.get_jpeg()
        if jpeg is None:
            blank = np.full((420, 740, 3), 30, dtype=np.uint8)
            msg = stream._error or f"Waiting for camera {idx}..."
            cv2.putText(
                blank, msg[:48], (24, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (220, 220, 220), 2
            )
            ok, buf = cv2.imencode(".jpg", blank)
            jpeg = bytes(buf) if ok else b""
        yield boundary + b"\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
        time.sleep(0.05)


def run_detection(camera: int) -> dict:
    stream = ensure_stream(camera)
    # brief wait for first frame after switch
    for _ in range(20):
        frame = stream.get_bgr()
        if frame is not None:
            break
        time.sleep(0.05)
    else:
        err = stream._error or f"No frame from camera {camera}"
        LAST_DETECT.update({"error": err, "at": datetime.now().isoformat(), "objects": []})
        return {"error": err}

    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        return {"error": "encode failed"}
    raw = bytes(buf)

    provider = (os.getenv("VISION_PROVIDER") or "").strip().lower()
    if not provider:
        provider = "openai" if os.getenv("OPENAI_API_KEY") else "anthropic"

    LAST_DETECT["running"] = True
    try:
        jpeg, im = compress(raw)
        if provider == "openai":
            model = os.getenv("OPENAI_VISION_MODEL", "gpt-4o")
            data, usage = detect_openai(jpeg, model)
        else:
            model = os.getenv("ANTHROPIC_VISION_MODEL", "claude-sonnet-4-5")
            data, usage = detect_anthropic(jpeg, model)
        objects = data.get("objects") or []
        annotated = draw_boxes(im, objects)
        out_path = OUT_DIR / "live_detect.jpg"
        annotated.save(out_path, quality=90)
        # Human-readable summary for Q2 chrome
        bits: list[str] = []
        for o in objects:
            lab = o.get("label", "?")
            if lab == "milk" and o.get("fill_percent") is not None:
                bits.append(
                    f"{lab}: {o.get('state', '?')} · fill {o.get('fill_percent')}%"
                    f" (id-conf {float(o.get('confidence') or 0):.2f})"
                )
            else:
                bits.append(f"{lab} {float(o.get('confidence') or 0):.2f}")
        summary = "; ".join(bits) if bits else "none"
        print(f"[detect] {summary}")
        LAST_DETECT.update(
            {
                "path": str(out_path),
                "objects": objects,
                "summary": summary,
                "usage": usage,
                "camera": camera,
                "error": None,
                "at": datetime.now().isoformat(),
                "running": False,
            }
        )
        # Push snapshot into Part2 inventory CSV + optional Linq alert
        try:
            _push_vision_inventory(objects)
        except Exception as push_exc:  # noqa: BLE001
            print(f"[detect] part2 inventory push failed: {push_exc}")
        return {
            "camera": camera,
            "objects": objects,
            "summary": summary,
            "usage": usage,
            "image_url": "/api/annotated",
            "at": LAST_DETECT["at"],
        }
    except Exception as exc:  # noqa: BLE001
        LAST_DETECT.update(
            {"error": str(exc), "at": datetime.now().isoformat(), "running": False}
        )
        return {"error": str(exc)}


def auto_detect_loop() -> None:
    while True:
        time.sleep(DETECT_INTERVAL_SEC)
        if not AUTO_DETECT:
            continue
        if LAST_DETECT.get("running"):
            continue
        with STATE_LOCK:
            cam = ACTIVE_CAMERA
        print(f"[timer] detect tick → camera {cam}")
        result = run_detection(cam)
        if "error" in result:
            print(f"[timer] detect error: {result['error']}")
        else:
            labels = ", ".join(o.get("label", "?") for o in result.get("objects", [])) or "none"
            print(f"[timer] detect ok: {labels} tokens={result.get('usage')}")


def health_loop() -> None:
    while True:
        with STATE_LOCK:
            cam = ACTIVE_CAMERA
        stream = STREAMS.get(cam)
        st = stream.status() if stream else {"has_frame": False, "error": "not started", "frames": 0}
        det_err = LAST_DETECT.get("error")
        objs = LAST_DETECT.get("objects") or []
        print(
            f"[health] {datetime.now().strftime('%H:%M:%S')} "
            f"active_cam={cam}({CAMERA_LABELS.get(cam, '?')}) "
            f"frame={'yes' if st.get('has_frame') else 'NO'} "
            f"frames={st.get('frames', 0)} "
            f"cam_err={st.get('error') or '-'} "
            f"last_detect={LAST_DETECT.get('at') or '-'} "
            f"objects={[o.get('label') for o in objs] or '-'} "
            f"detect_err={det_err or '-'} "
            f"auto={AUTO_DETECT} every={DETECT_INTERVAL_SEC}s "
            f"url=http://127.0.0.1:8765"
        )
        time.sleep(5)


PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate" />
  <title>Hackathon Prava Payments</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #f4f1ec;
      --ink: #1c1a17;
      --muted: #6f6a63;
      --line: #ddd6cc;
      --soft: #ebe6df;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: "DM Sans", system-ui, sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #f7f4ef 0%, var(--bg) 45%, #efeae3 100%);
    }
    .stage {
      height: 100vh; width: 100vw;
      display: grid;
      grid-template-columns: minmax(320px, 0.95fr) 1.05fr;
      grid-template-rows: 1fr 1fr;
      gap: 1px; background: var(--line); padding: 1px;
    }
    .quad { background: var(--soft); position: relative; overflow: hidden; min-height: 0; }
    /* Phone = left column full height (old Q1+Q3) */
    .q-phone {
      grid-column: 1;
      grid-row: 1 / 3;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 0.65rem;
      min-height: 0;
      overflow: hidden;
      background:
        radial-gradient(120% 80% at 20% 0%, #dfe8ff 0%, transparent 55%),
        radial-gradient(100% 70% at 90% 100%, #e8e0ff 0%, transparent 50%),
        #eef1f6;
    }
    /* Live camera → top-right (old Q2 slot) */
    .q-live { grid-column: 2; grid-row: 1; background: #111; }
    /* Detected → bottom-right (old Q4 slot) */
    .q-detect { grid-column: 2; grid-row: 2; background: #161616; }
    .live, #annotated {
      width: 100%; height: 100%; object-fit: cover; display: block; background: #000;
    }
    #annotated { object-fit: contain; }
    .chrome {
      position: absolute; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
      padding: 0.75rem 0.9rem;
      background: linear-gradient(transparent, rgba(0,0,0,0.6));
      color: #fff;
    }
    .chrome .left { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
    .chrome span.label { font-size: 0.78rem; letter-spacing: 0.04em; opacity: 0.92; }
    select, button {
      border: 0; border-radius: 999px; padding: 0.45rem 0.85rem;
      font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer;
    }
    select { background: rgba(255,255,255,0.16); color: #fff; }
    select option { color: #111; }
    button { background: #fff; color: var(--ink); }
    button:disabled { opacity: 0.55; cursor: wait; }
    .empty-label {
      position: absolute; inset: 0; display: grid; place-items: center;
      color: #a39c93; font-size: 0.8rem; letter-spacing: 0.1em; text-transform: uppercase;
    }
    .badge {
      position: absolute; top: 0.85rem; left: 0.9rem;
      font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase;
      color: rgba(255,255,255,0.7); font-weight: 600;
      z-index: 3;
    }
    .live-clock {
      position: absolute;
      top: 2.35rem;
      left: 0.9rem;
      z-index: 3;
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #fff;
      text-shadow: 0 1px 4px rgba(0,0,0,0.75);
      font-variant-numeric: tabular-nums;
      opacity: 0.95;
    }
    .live-clock .sec { opacity: 0.75; font-weight: 500; }
    #detectBtn {
      background: #fff;
      color: var(--ink);
      box-shadow:
        0 0 0 0 rgba(255, 214, 90, 0.85),
        0 0 18px rgba(255, 196, 60, 0.75);
      animation: detectGlow 1.6s ease-in-out infinite;
    }
    #detectBtn:hover {
      filter: brightness(1.05);
    }
    #detectBtn:disabled {
      animation: none;
      box-shadow: none;
      opacity: 0.55;
    }
    @keyframes detectGlow {
      0%, 100% {
        box-shadow:
          0 0 0 0 rgba(255, 214, 90, 0.15),
          0 0 12px rgba(255, 196, 60, 0.45);
        transform: scale(1);
      }
      50% {
        box-shadow:
          0 0 0 8px rgba(255, 214, 90, 0),
          0 0 28px rgba(255, 196, 60, 0.95);
        transform: scale(1.04);
      }
    }
    /* Per-quadrant expand for demos */
    .fs-btn {
      position: absolute;
      top: 0.65rem;
      right: 0.65rem;
      z-index: 5;
      width: 2rem;
      height: 2rem;
      padding: 0;
      border-radius: 10px;
      border: 0;
      display: grid;
      place-items: center;
      cursor: pointer;
      background: rgba(0,0,0,0.45);
      color: #fff;
      font-size: 0.95rem;
      line-height: 1;
      backdrop-filter: blur(6px);
    }
    .fs-btn:hover { background: rgba(0,0,0,0.65); }
    .q-live .fs-btn,
    .q-detect .fs-btn {
      /* Expanding Live/Detected hid the chat column — keep chats always visible */
      display: none !important;
    }
    .stage.fs-mode { display: block; position: relative; }
    .stage.fs-mode .quad { display: none; }
    .stage.fs-mode .quad.is-fs {
      display: flex;
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 20;
    }
    .stage.fs-mode .q-live.is-fs,
    .stage.fs-mode .q-detect.is-fs { display: block; }
    .stage.fs-mode .q-phone.is-fs {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .stage.fs-mode .q-phone.is-fs .q3-wrap {
      width: min(420px, 48vh);
      height: 96%;
    }
    .stage.fs-mode .q-phone.is-fs .phone {
      height: calc(100% - 1.2rem);
      max-width: 100%;
    }
    .fs-btn .icon-exit { display: none; }
    .quad.is-fs .fs-btn .icon-expand { display: none; }
    .quad.is-fs .fs-btn .icon-exit { display: inline; }

    /* Q3 — live Linq iMessage mirror (fits full phone in quadrant) */
    .q3-wrap {
      width: min(380px, 94%);
      height: 100%;
      max-height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 0.25rem;
      min-height: 0;
      padding: 0.35rem 0 0.4rem;
      box-sizing: border-box;
    }
    .q3-brand {
      flex: 0 0 auto;
      font-size: 0.68rem;
      font-weight: 600;
      color: #1c2434;
      text-align: center;
      line-height: 1.2;
    }
    .q3-brand span {
      display: block;
      margin-top: 0.05rem;
      font-size: 0.52rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #6b7280;
      font-weight: 500;
    }
    .phone {
      /* Fit entire device inside Q3 — height-first so bottom bezel isn't clipped */
      height: calc(100% - 1.35rem);
      width: auto;
      max-width: 92%;
      aspect-ratio: 9 / 17.5;
      flex: 1 1 auto;
      min-height: 0;
      background: #111214;
      border-radius: 26px;
      padding: 8px;
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.08) inset,
        0 14px 32px rgba(28, 36, 52, 0.22);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .phone-screen {
      flex: 1;
      min-height: 0;
      height: 100%;
      border-radius: 20px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: #f2f2f7;
    }
    .phone-status {
      flex: 0 0 auto;
      display: flex;
      justify-content: space-between;
      padding: 0.28rem 0.7rem 0.05rem;
      font-size: 0.55rem;
      font-weight: 700;
      color: #111;
      background: rgba(242,242,247,0.96);
    }
    .imsg-header {
      flex: 0 0 auto;
      text-align: center;
      padding: 0.1rem 0.4rem 0.35rem;
      background: rgba(242,242,247,0.96);
      border-bottom: 1px solid rgba(0,0,0,0.06);
      position: relative;
    }
    .imsg-hide {
      position: absolute;
      right: 0.45rem;
      top: 0.35rem;
      border: 0;
      background: rgba(0,0,0,0.06);
      color: #3a3a3c;
      font: inherit;
      font-size: 0.58rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      padding: 0.28rem 0.45rem;
      border-radius: 8px;
      cursor: pointer;
      z-index: 2;
    }
    .imsg-hide:hover { background: rgba(0,0,0,0.12); }
    .imsg-hide.is-on {
      background: #0b84ff;
      color: #fff;
    }
    .imsg-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      margin: 0 auto 0.15rem;
      display: grid; place-items: center;
      font-size: 0.72rem; font-weight: 700; color: #fff;
      background: linear-gradient(160deg, #5b7cfa, #2f4fd6);
    }
    .imsg-header strong {
      display: block;
      font-size: 0.68rem;
      font-weight: 700;
      color: #111;
    }
    .imsg-header small {
      color: #8e8e93;
      font-size: 0.55rem;
      display: block;
      max-width: 92%;
      margin: 0.05rem auto 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .imsg-thread {
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      overflow-x: hidden;
      overflow-y: scroll;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      touch-action: pan-y;
      padding: 0.65rem 0.7rem 0.55rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      background: #f7f7fa;
      scrollbar-width: thin;
    }
    .bubble {
      flex: 0 0 auto;
      max-width: 92%;
      padding: 0.65rem 0.75rem;
      border-radius: 18px;
      font-size: 0.92rem;
      line-height: 1.45;
      letter-spacing: 0.01em;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      -webkit-font-smoothing: antialiased;
    }
    .bubble.in {
      align-self: flex-start;
      background: #ffffff;
      color: #111827;
      border: 1px solid rgba(17, 24, 39, 0.08);
      border-bottom-left-radius: 6px;
      box-shadow: 0 1px 2px rgba(17, 24, 39, 0.06);
    }
    .bubble.out {
      align-self: flex-end;
      background: #0b84ff;
      color: #fff;
      font-weight: 550;
      border-bottom-right-radius: 6px;
      box-shadow: 0 2px 6px rgba(11, 132, 255, 0.28);
    }
    .bubble.pay {
      max-width: 96%;
      background: #fff;
      border: 1px solid rgba(28, 77, 140, 0.18);
    }
    .bubble.receipt {
      border-color: rgba(31, 107, 69, 0.28);
      background: #f3faf6;
    }
    .bubble.err {
      border-color: rgba(138, 59, 46, 0.3);
      background: #fff6f4;
    }
    .bubble .b-title {
      display: block;
      font-weight: 800;
      font-size: 1.02rem;
      margin: 0 0 0.55rem;
      color: #0f172a;
      line-height: 1.3;
    }
    .bubble .b-meta {
      display: block;
      font-size: 0.9rem;
      font-weight: 450;
      color: #334155;
      margin: 0;
      line-height: 1.35;
    }
    .bubble .b-kv {
      display: block;
      font-size: 0.9rem;
      line-height: 1.35;
      margin: 0;
      padding: 0;
      color: #334155;
      font-weight: 450;
    }
    .bubble .b-kv.addr {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      line-height: 1.35;
      max-height: 2.7em;
    }
    .bubble .b-kv b,
    .bubble .b-key {
      font-weight: 800;
      color: #0f172a;
    }
    .bubble .b-opt {
      display: block;
      font-size: 0.9rem;
      line-height: 1.35;
      margin: 0;
      color: #334155;
      font-weight: 450;
    }
    .bubble .b-opt b {
      font-weight: 800;
      color: #0f172a;
    }
    .bubble .b-ship {
      display: block;
      font-size: 0.86rem;
      color: #475569;
      margin: 0;
      line-height: 1.35;
    }
    .bubble.pay,
    .bubble.receipt {
      white-space: normal;
      line-height: 1.35;
    }
    .bubble .pay-btn {
      display: inline-block;
      margin: 0.1rem 0 0.6rem;
      padding: 0.5rem 0.9rem;
      border-radius: 10px;
      background: #0b84ff;
      color: #fff !important;
      font-weight: 700;
      font-size: 0.9rem;
      text-decoration: none !important;
      box-shadow: 0 2px 8px rgba(11, 132, 255, 0.3);
    }
    .bubble .pay-btn:hover { filter: brightness(1.05); }
    .bubble .card-box {
      display: block;
      margin: 0;
      padding: 0.55rem 0.65rem;
      border-radius: 10px;
      background: #0f172a;
      color: #f8fafc;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      letter-spacing: 0.02em;
    }
    .bubble .card-box .lbl {
      display: block;
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
      margin-bottom: 0.3rem;
      font-family: "DM Sans", system-ui, sans-serif;
    }
    .bubble .hi {
      background: #fef08a;
      color: #111;
      padding: 0.08rem 0.28rem;
      border-radius: 4px;
      font-weight: 700;
    }
    .bubble a {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
      word-break: break-all;
      cursor: pointer;
    }
    .bubble.in a:not(.pay-btn) { color: #0369a1; font-weight: 600; }
    .bubble.out a { color: #fff; }
    .imsg-hint {
      text-align: center;
      font-size: 0.62rem;
      color: #8e8e93;
      margin: 0.3rem 0;
      line-height: 1.3;
    }
    .imsg-input {
      flex: 0 0 auto;
      border-top: 1px solid rgba(0,0,0,0.06);
      padding: 0.4rem 0.5rem 0.5rem;
      display: flex;
      gap: 0.35rem;
      align-items: center;
      background: #f2f2f7;
    }
    .imsg-input input {
      flex: 1;
      border: 1px solid #d1d1d6;
      border-radius: 999px;
      padding: 0.45rem 0.8rem;
      font: inherit;
      font-size: 0.8rem;
      color: #111;
      background: #fff;
      outline: none;
      min-width: 0;
    }
    .imsg-input input::placeholder { color: #8e8e93; }
    .imsg-input button.send {
      flex: 0 0 auto;
      border: 0;
      border-radius: 999px;
      width: 2.15rem;
      height: 2.15rem;
      padding: 0;
      display: grid;
      place-items: center;
      background: #0b84ff;
      color: #fff;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
    }
    .imsg-input button.send:disabled { opacity: 0.45; cursor: wait; }
    .q-detect .placeholder {
      position: absolute; inset: 0; display: grid; place-items: center;
      color: rgba(255,255,255,0.45); font-size: 0.9rem; text-align: center; padding: 1rem;
    }
  </style>
</head>
<body>
  <div class="stage">
    <!-- Tall phone / iMessage (left column) -->
    <section class="quad q-phone" data-quad="phone">
      <button type="button" class="fs-btn" onclick="toggleQuadFs(this)" title="Expand quadrant" aria-label="Expand chat">
        <span class="icon-expand">⛶</span><span class="icon-exit">✕</span>
      </button>
      <div class="q3-wrap">
        <div class="q3-brand">Live iMessage · type here or from iPhone</div>
        <div class="phone" aria-label="Live iMessage mirror">
          <div class="phone-screen">
            <div class="phone-status"><span>9:41</span><span>▮▮▮</span></div>
            <div class="imsg-header">
              <button type="button" class="imsg-hide" id="imsgHideBtn" title="Hide old chat for the audience">Hide</button>
              <div class="imsg-avatar">I</div>
              <strong>Inventory agent</strong>
              <small id="peerLocation" title="">Connecting…</small>
            </div>
            <div class="imsg-thread" id="imsgThread">
              <p class="imsg-hint" id="imsgStatus">Connecting to Linq…</p>
            </div>
            <form class="imsg-input" id="imsgForm" autocomplete="off">
              <input id="imsgCompose" type="text" maxlength="500" placeholder="Message…" aria-label="Send as café manager" />
              <button type="submit" class="send" id="imsgSend" title="Send">↑</button>
            </form>
          </div>
        </div>
      </div>
    </section>

    <section class="quad q-live" data-quad="live">
      <button type="button" class="fs-btn" onclick="toggleQuadFs(this)" title="Expand quadrant" aria-label="Expand Live">
        <span class="icon-expand">⛶</span><span class="icon-exit">✕</span>
      </button>
      <div class="badge" id="liveBadge">Live</div>
      <div class="live-clock" id="liveClock" aria-live="polite">—</div>
      <img class="live" id="live" src="/stream" alt="Live camera" />
      <div class="chrome">
        <div class="left">
          <select id="cam" onchange="switchCam()">
            <option value="0">Laptop</option>
            <option value="1">Phone</option>
            <option value="2">Phone (Continuity)</option>
          </select>
          <span class="label" id="status">starting…</span>
        </div>
        <div class="left">
          <button id="detectBtn" onclick="runDetect()" title="Click to detect low stock">Detect now</button>
        </div>
      </div>
    </section>

    <section class="quad q-detect" data-quad="detect">
      <button type="button" class="fs-btn" onclick="toggleQuadFs(this)" title="Expand quadrant" aria-label="Expand Detected">
        <span class="icon-expand">⛶</span><span class="icon-exit">✕</span>
      </button>
      <div class="badge">Detected</div>
      <div class="placeholder" id="placeholder">Waiting for first detection…</div>
      <img id="annotated" alt="Detection result" style="display:none" />
      <div class="chrome">
        <span class="label" id="detectLabel">Click Detect now to analyze the live frame</span>
      </div>
    </section>
  </div>
  <script>
    let busy = false;

    function tickLiveClock() {
      const el = document.getElementById("liveClock");
      if (!el) return;
      const now = new Date();
      const date = now.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const time = now.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      el.textContent = date + " · " + time;
    }
    tickLiveClock();
    setInterval(tickLiveClock, 1000);

    function toggleQuadFs(btn) {
      const stage = document.querySelector(".stage");
      const quad = btn.closest(".quad");
      const already = quad.classList.contains("is-fs");
      document.querySelectorAll(".quad.is-fs").forEach((q) => q.classList.remove("is-fs"));
      stage.classList.remove("fs-mode");
      if (!already) {
        quad.classList.add("is-fs");
        stage.classList.add("fs-mode");
        btn.title = "Exit full screen";
      } else {
        btn.title = "Expand quadrant";
      }
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const stage = document.querySelector(".stage");
        document.querySelectorAll(".quad.is-fs").forEach((q) => q.classList.remove("is-fs"));
        stage.classList.remove("fs-mode");
      }
    });

    // Part 2/3 via same-origin proxy on :8765 (web_live → :8787 / :8788)
    const CHAT_API = window.CHAT_API_BASE || "";
    const PART3_API = window.PART3_API_BASE || "";
    const q4Qty = {};
    let q4PayOrderId = null;

    function q4SetQty(el) {
      const id = el.getAttribute("data-id");
      if (!id) return;
      q4Qty[id] = Math.max(1, Math.min(5, Number(el.value) || 1));
    }

    let lastChatSig = "";
    let chatStickBottom = true;
    let liveChatId = null;
    let composeBusy = false;
    /** When set, only show messages newer than this ISO time (demo hide). */
    let chatHideAfterAt = new Date().toISOString();
    /** Auto-hide history once per page load (refresh always starts hidden). */
    let autoHideDone = false;
    /** Last messages from /api/chat (Linq + local merge). */
    let lastServerMessages = [];
    /** Web-typed user lines kept until server history includes them. */
    const pendingWebUsers = [];

    function applyDefaultHide(messages) {
      if (autoHideDone) return;
      autoHideDone = true;
      let maxAt = chatHideAfterAt || new Date().toISOString();
      (messages || []).forEach(function (m) {
        if (m && m.at && String(m.at) > maxAt) maxAt = String(m.at);
      });
      pendingWebUsers.forEach(function (p) {
        if (p && p.at && String(p.at) > maxAt) maxAt = String(p.at);
      });
      chatHideAfterAt = maxAt;
      updateHideBtn();
    }

    function normMsg(t) {
      return String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function mergePendingUsers(messages) {
      const list = (messages && messages.length ? messages : lastServerMessages).slice();
      const have = {};
      list.forEach(function (m) {
        if (m && m.role === "user") have[normMsg(m.text)] = true;
      });
      pendingWebUsers.forEach(function (p) {
        const key = normMsg(p.text);
        if (!key || have[key]) return;
        list.push({
          id: p.id,
          role: "user",
          text: p.text,
          at: p.at,
        });
        have[key] = true;
      });
      list.sort(function (a, b) {
        return String(a.at || "").localeCompare(String(b.at || ""));
      });
      return list;
    }

    function prunePendingAgainst(serverMessages) {
      const have = {};
      (serverMessages || []).forEach(function (m) {
        if (m && m.role === "user") have[normMsg(m.text)] = true;
      });
      for (let i = pendingWebUsers.length - 1; i >= 0; i--) {
        if (have[normMsg(pendingWebUsers[i].text)]) {
          pendingWebUsers.splice(i, 1);
        }
      }
    }

    function escHtml(text) {
      return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function linkifyBubble(text) {
      return escHtml(text).replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
      );
    }

    function truncateMid(text, maxLen) {
      const s = String(text || "");
      const n = maxLen || 22;
      if (s.length <= n) return s;
      return s.slice(0, Math.max(0, n - 3)) + "...";
    }

    function kvHtml(key, value) {
      const k = String(key || "").replace(/:\s*$/, "").trim();
      let val = String(value || "").trim();
      if (/^Order$/i.test(k)) val = truncateMid(val, 22);
      const cls = /^Address$/i.test(k) ? "b-kv addr" : "b-kv";
      return '<span class="' + cls + '"><b>' + escHtml(k) + ':</b> ' + escHtml(val) + '</span>';
    }

    /** Bold key before first ":" or title + price. */
    function formatKvOrPlain(line) {
      const m = line.match(/^([A-Za-z][A-Za-z\s/#]+):\s*(.+)$/);
      if (m) return kvHtml(m[1], m[2]);
      const numbered = line.match(/^(\d+)\.\s*(.+)$/);
      if (numbered) {
        const rest = numbered[2];
        const priceM = rest.match(/(\$[\d.,]+(?:\s*[A-Z]{3})?)\s*$/);
        if (priceM) {
          const title = rest.slice(0, priceM.index).replace(/\s*[—\-·]\s*$/, "").split(/\s+[·]\s*/)[0].trim();
          return (
            '<span class="b-opt"><b>' + escHtml(numbered[1] + ". " + title) + "</b> " +
            escHtml(priceM[1]) + "</span>"
          );
        }
        return '<span class="b-opt"><b>' + escHtml(line) + "</b></span>";
      }
      const choose = line.match(/^(Choosing #1:)\s*(.+)$/i);
      if (choose) return kvHtml("Choosing #1", choose[2]);
      const why = line.match(/^(Why:)\s*(.+)$/i);
      if (why) return kvHtml("Why", why[2]);
      return '<span class="b-meta">' + linkifyBubble(line) + "</span>";
    }

    /** Structured, high-contrast bubbles for pay / receipt / errors (web UI only). */
    function formatBubble(text, role) {
      const raw = String(text || "");
      const isPay = /Tap to pay|Quoted and ready|sandbox\.collect/i.test(raw);
      const isReceipt = /^Receipt\b/i.test(raw.trim()) || /^Delivery\b/i.test(raw.trim());
      const isOptions = /I searched Prava for restock options/i.test(raw);
      const isErr = /Couldn.t finish|Too many open checkouts/i.test(raw);

      if (role === "user") {
        return { html: linkifyBubble(raw), kind: "out" };
      }

      if (isOptions) {
        const lines = raw.split(String.fromCharCode(10)).map(function (l) { return l.trim(); }).filter(Boolean);
        let html = "";
        lines.forEach(function (l) {
          if (/^I searched Prava/i.test(l)) {
            html += '<span class="b-title">Restock options</span>';
          } else {
            html += formatKvOrPlain(l);
          }
        });
        return { html: html, kind: "in" };
      }

      if (isPay) {
        const urlMatch = raw.match(/https?:\/\/[^\s]+/i);
        const url = urlMatch ? urlMatch[0] : "";
        const lines = raw.split(String.fromCharCode(10)).map(function (l) { return l.trim(); }).filter(Boolean);
        const skip = /^(Quoted and ready|Tap to pay|Sandbox card|CVV|OTP|I.ll text|Need a different|Why this quote|MilkWatch)/i;
        let html = '<span class="b-title">Quoted and ready</span>';
        lines.forEach(function (l) {
          if (skip.test(l) || /^https?:\/\//i.test(l) || /^\d{16}$/.test(l)) return;
          if (/^Item:|^Merchant:|^Total:|^Qty:|^Deliver to:|^Address:|^ETA:|^Ship:/i.test(l)) {
            html += formatKvOrPlain(l);
          }
        });
        const cardMatch = raw.match(/(\d{16})/);
        const cvvMatch = raw.match(/CVV\s*(\d+)/i);
        const expMatch = raw.match(/exp\s*([0-9/]+)/i);
        const otpMatch = raw.match(/OTP\s*(\d+)/i);
        if (url) {
          html += '<a class="pay-btn" href="' + escHtml(url) + '" target="_blank" rel="noopener noreferrer">Open pay link</a>';
        }
        if (cardMatch) {
          html +=
            '<span class="card-box">' +
              '<span class="lbl">Card</span>' +
              escHtml(cardMatch[1]) + '<br>' +
              'CVV <span class="hi">' + escHtml(cvvMatch ? cvvMatch[1] : "93") + '</span>' +
              ' · exp ' + escHtml(expMatch ? expMatch[1] : "12/30") + '<br>' +
              'OTP <span class="hi">' + escHtml(otpMatch ? otpMatch[1] : "456789") + '</span>' +
            '</span>';
        }
        return { html: html, kind: "in pay" };
      }

      if (isReceipt) {
        const lines = raw.split(String.fromCharCode(10)).map(function (l) { return l.trim(); }).filter(Boolean);
        let html = "";
        lines.forEach(function (l) {
          if (/^Receipt$/i.test(l)) html += '<span class="b-title">Receipt</span>';
          else if (/^Delivery$/i.test(l)) html += '<span class="b-title">Delivery</span>';
          else if (/^─+$/.test(l) || /MilkWatch/i.test(l)) return;
          else html += formatKvOrPlain(l);
        });
        return { html: html, kind: /Delivery/i.test(raw.trim().slice(0, 12)) ? "in" : "in receipt" };
      }

      if (isErr) {
        const lines = raw.split(String.fromCharCode(10)).map(function (l) { return l.trim(); }).filter(Boolean);
        const detail = lines.filter(function (l) { return !/Couldn.t finish/i.test(l); }).join(" ");
        return {
          html: '<span class="b-title">Could not finish</span>' +
            (detail ? '<span class="b-meta">' + escHtml(detail) + '</span>' : ""),
          kind: "in err",
        };
      }

      // Generic: bold Key: value lines when present
      if (/^[A-Za-z][A-Za-z\s/#]+:\s*.+/m.test(raw)) {
        const lines = raw.split(String.fromCharCode(10)).map(function (l) { return l.trim(); }).filter(Boolean);
        let html = "";
        lines.forEach(function (l) { html += formatKvOrPlain(l); });
        return { html: html, kind: "in" };
      }

      return { html: linkifyBubble(raw), kind: "in" };
    }

    function updateHideBtn() {
      const btn = document.getElementById("imsgHideBtn");
      if (!btn) return;
      if (chatHideAfterAt) {
        btn.textContent = "Show";
        btn.classList.add("is-on");
        btn.title = "Show full chat history";
      } else {
        btn.textContent = "Hide";
        btn.classList.remove("is-on");
        btn.title = "Hide old chat for the audience";
      }
    }

    function toggleHideChat() {
      if (chatHideAfterAt) {
        chatHideAfterAt = null;
      } else {
        let maxAt = new Date().toISOString();
        (lastServerMessages || []).forEach(function (m) {
          if (m && m.at && String(m.at) > maxAt) maxAt = String(m.at);
        });
        // Also cover pending web bubbles
        pendingWebUsers.forEach(function (p) {
          if (p && p.at && String(p.at) > maxAt) maxAt = String(p.at);
        });
        chatHideAfterAt = maxAt;
      }
      lastChatSig = "";
      updateHideBtn();
      renderChat(lastServerMessages);
    }

    function renderChat(messages) {
      const thread = document.getElementById("imsgThread");
      if (!thread) return;
      if (messages && messages.length) {
        lastServerMessages = messages.slice();
      }
      let list = mergePendingUsers(messages).filter(function (m) {
        return m && m.text;
      });
      if (chatHideAfterAt) {
        list = list.filter(function (m) {
          return m.at && String(m.at) > chatHideAfterAt;
        });
      }
      const sig =
        (chatHideAfterAt || "") + "||" +
        list.map(function (m) {
          return (m.role || "") + "::" + m.text;
        }).join("||");
      if (sig === lastChatSig) return;
      lastChatSig = sig;

      const nearBottom =
        thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
      const keepTop = thread.scrollTop;
      const stick = chatStickBottom || nearBottom;

      thread.innerHTML = "";
      if (!list.length) {
        thread.innerHTML = chatHideAfterAt
          ? '<p class="imsg-hint">Chat hidden — new messages appear here.</p>'
          : '<p class="imsg-hint">No messages yet — type below or text from iPhone.</p>';
        return;
      }
      for (const m of list) {
        const div = document.createElement("div");
        const formatted = formatBubble(m.text, m.role);
        div.className = "bubble " + (m.role === "user" ? "out" : formatted.kind);
        div.innerHTML = formatted.html;
        thread.appendChild(div);
      }
      if (stick) {
        thread.scrollTop = thread.scrollHeight;
        chatStickBottom = true;
      } else {
        thread.scrollTop = keepTop;
      }
    }

    // Track whether user is reading history vs following live
    (function bindChatScroll() {
      const thread = document.getElementById("imsgThread");
      if (!thread) return;
      thread.addEventListener("scroll", function () {
        const nearBottom =
          thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
        chatStickBottom = nearBottom;
      }, { passive: true });
      // Wheel over phone should scroll the thread, not the page
      thread.addEventListener("wheel", function (e) {
        e.stopPropagation();
      }, { passive: true });
    })();

    function formatLocation(loc) {
      if (!loc) return null;
      if (loc.address) return loc.address;
      if (loc.locality) return loc.locality;
      if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
        return loc.latitude.toFixed(5) + ", " + loc.longitude.toFixed(5);
      }
      return null;
    }

    async function refreshLocation() {
      const el = document.getElementById("peerLocation");
      if (!el) return;
      try {
        // Prefer fast stored pin first, then try live Linq pull
        let loc = null;
        const stored = await fetch(CHAT_API + "/api/location/stored");
        if (stored.ok) {
          const data = await stored.json();
          loc = data.location;
          const label = formatLocation(loc);
          if (label) {
            el.textContent = label;
            el.title = label + (data.source === "demo" ? " (demo pin)" : "");
          }
        }
        const live = await fetch(CHAT_API + "/api/location");
        if (live.ok) {
          const data = await live.json();
          loc = data.location || loc;
        }
        const label = formatLocation(loc);
        if (label) {
          el.textContent = label;
          el.title = label;
        } else if (!el.textContent || el.textContent === "Connecting…") {
          el.textContent = "Location unavailable";
          el.title = "Linq location not enabled — using demo when available";
        }
      } catch (e) {
        el.textContent = "Location offline";
        el.title = "Part 2 API not reachable via proxy";
      }
    }

    async function refreshChat() {
      const thread = document.getElementById("imsgThread");
      try {
        const res = await fetch(CHAT_API + "/api/chat");
        const data = await res.json();
        if (!res.ok) {
          thread.innerHTML =
            '<p class="imsg-hint">' + (data.error || data.hint || "Chat unavailable") + "</p>";
          return;
        }
        if (data.chatId) liveChatId = data.chatId;
        prunePendingAgainst(data.messages || []);
        applyDefaultHide(data.messages || []);
        renderChat(data.messages || []);
      } catch (e) {
        thread.innerHTML =
          '<p class="imsg-hint">Part 2 offline — run: cd part2_linq && npm run start</p>';
      }
    }

    async function sendCompose(ev) {
      if (ev) ev.preventDefault();
      const input = document.getElementById("imsgCompose");
      const btn = document.getElementById("imsgSend");
      if (!input || composeBusy) return;
      const text = String(input.value || "").trim();
      if (!text) return;
      composeBusy = true;
      if (btn) btn.disabled = true;
      input.value = "";

      const pending = {
        id: "web-" + Date.now(),
        text: text,
        at: new Date().toISOString(),
      };
      pendingWebUsers.push(pending);
      chatStickBottom = true;
      lastChatSig = "";
      // Keep history; only add pending blue bubble
      renderChat(lastServerMessages);

      // Poll chat while APPROVE/discover runs (can take ~60s) so agent bubbles appear live
      const pollWhileBusy = setInterval(function () {
        lastChatSig = "";
        refreshChat();
      }, 1200);

      try {
        const res = await fetch(CHAT_API + "/api/agent/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            text: text,
            dryRun: false,
            chatId: liveChatId || undefined,
            fromWeb: true,
          }),
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        if (data.chatId) liveChatId = data.chatId;
        lastChatSig = "";
        if (data.messages && data.messages.length) {
          prunePendingAgainst(data.messages);
          renderChat(data.messages);
        }
        await refreshChat();
        setTimeout(function () { lastChatSig = ""; refreshChat(); }, 1500);
      } catch (e) {
        const thread = document.getElementById("imsgThread");
        if (thread) {
          const err = document.createElement("div");
          err.className = "bubble in";
          err.textContent = "Could not send: " + (e.message || e);
          thread.appendChild(err);
        }
      } finally {
        clearInterval(pollWhileBusy);
        composeBusy = false;
        if (btn) btn.disabled = false;
        if (input) input.focus();
      }
    }

    (function bindCompose() {
      const form = document.getElementById("imsgForm");
      if (form) form.addEventListener("submit", sendCompose);
      const hideBtn = document.getElementById("imsgHideBtn");
      if (hideBtn) hideBtn.addEventListener("click", toggleHideChat);
      updateHideBtn();
    })();

    async function refreshHealth() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        document.getElementById('cam').value = String(data.active_camera);
        const st = data.stream || {};
        const liveBadge = document.getElementById('liveBadge');
        if (liveBadge) liveBadge.textContent = st.dummy ? 'Live dummy' : 'Live';
        document.getElementById('status').textContent = st.has_frame
          ? (st.dummy ? 'Live dummy' : ('live · ' + (st.label || '')))
          : ('no frame · ' + (st.error || 'check Continuity'));
        if (data.last_detect && data.last_detect.image_ready) {
          const img = document.getElementById('annotated');
          const url = '/api/annotated?t=' + (data.last_detect.at || Date.now());
          if (img.dataset.src !== url) {
            img.dataset.src = url;
            img.src = url;
            img.style.display = 'block';
            document.getElementById('placeholder').style.display = 'none';
          }
          const sum = data.last_detect.summary
            || (data.last_detect.objects || []).map(function(o) {
                if (o.label === 'milk' && o.fill_percent != null) {
                  return o.label + ': ' + (o.state || '?') + ' · fill ' + o.fill_percent + '%';
                }
                return o.label;
              }).join(', ')
            || 'none';
          document.getElementById('detectLabel').textContent = 'Found: ' + sum;
        }
      } catch (e) {
        document.getElementById('status').textContent = 'server offline';
      }
    }

    async function switchCam() {
      const cam = document.getElementById('cam').value;
      document.getElementById('status').textContent = 'switching…';
      await fetch('/api/camera?index=' + cam, { method: 'POST' });
      const live = document.getElementById('live');
      live.src = '/stream?t=' + Date.now();
      refreshHealth();
    }

    async function runDetect() {
      if (busy) return;
      busy = true;
      document.getElementById('detectBtn').disabled = true;
      document.getElementById('detectLabel').textContent = 'Detecting…';
      try {
        const cam = document.getElementById('cam').value;
        const res = await fetch('/api/detect?camera=' + cam, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'detect failed');
        const img = document.getElementById('annotated');
        img.src = data.image_url + '?t=' + Date.now();
        img.style.display = 'block';
        document.getElementById('placeholder').style.display = 'none';
        const sum = data.summary
          || (data.objects || []).map(function(o) {
              if (o.label === 'milk' && o.fill_percent != null) {
                return o.label + ': ' + (o.state || '?') + ' · fill ' + o.fill_percent + '%';
              }
              return o.label + ' ' + (o.confidence != null ? Number(o.confidence).toFixed(2) : '');
            }).join('; ')
          || 'none';
        document.getElementById('detectLabel').textContent = 'Found: ' + sum;
      } catch (e) {
        document.getElementById('detectLabel').textContent = 'Error: ' + e.message;
      } finally {
        busy = false;
        document.getElementById('detectBtn').disabled = false;
      }
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function renderOffers(snap) {
      const body = document.getElementById("q4Body");
      const ship = document.getElementById("q4Ship");
      const status = document.getElementById("q4Status");
      const paybox = document.getElementById("q4Paybox");
      if (!body) return;
      var shipLabel = snap.shipToLabel || "—";
      if (shipLabel === "Home" || shipLabel === "address on file") {
        var locEl = document.getElementById("peerLocation");
        if (locEl && locEl.textContent && locEl.textContent.indexOf("Connecting") < 0 && locEl.textContent.indexOf("offline") < 0) {
          shipLabel = "East Village Café · " + locEl.textContent;
        } else {
          shipLabel = "East Village Café";
        }
      }
      ship.textContent = "Ship-to: " + shipLabel;
      status.textContent = (snap.status || "idle") + (snap.message ? " · " + snap.message : "");

      const rows = (snap.rows || []).filter(function (o) {
        return o.status === "quoted" || o.status === "discovered";
      });
      const quoted = rows.filter(function (o) { return o.status === "quoted"; });
      const orders = snap._orders || [];
      const awaiting = orders.find(function (o) {
        return o.status === "awaiting_passkey" || o.status === "polling" || o.status === "checking_out";
      });
      // Only show receipt when it's the newest activity (not stuck on old paid)
      const newest = orders[0] || null;
      const paid =
        newest && newest.status === "paid"
          ? newest
          : null;

      let stage = "idle";
      if (awaiting) stage = "pay";
      else if (quoted.length) stage = "quote";
      else if (rows.length || snap.status === "discovering") stage = "search";
      else if (paid) stage = "receipt";

      const stepOrder = ["search", "quote", "pay", "receipt"];
      const stepIdx = stepOrder.indexOf(stage);
      document.querySelectorAll("#q4Steps li").forEach(function (li) {
        const s = li.getAttribute("data-step");
        const i = stepOrder.indexOf(s);
        li.className = "";
        if (stage === "idle") return;
        if (i < stepIdx) li.className = "done";
        else if (i === stepIdx) li.className = "on";
      });

      function figClass(title, query) {
        const b = ((title || "") + " " + (query || "")).toLowerCase();
        if (/milk|dairy|gallon/.test(b)) return "milk";
        if (/egg/.test(b)) return "egg";
        if (/coffee|espresso|bean/.test(b)) return "coffee";
        if (/choc|cocoa|truffle/.test(b)) return "choc";
        return "";
      }
      function initials(title) {
        const w = String(title || "Item").split(/\s+/).filter(Boolean);
        return ((w[0] || "P")[0] + (w[1] || w[0] || "R")[0]).toUpperCase();
      }
      function cardHtml(o, extraMeta) {
        const title = o.title || "Item";
        const merchant = (o.merchant || "—").replace(/^www\./, "");
        const total = o.total || o.quoteTotal || o.priceEstimate || "";
        const qty = o.quantity || 1;
        const fc = figClass(title, o.query);
        return (
          '<div class="q4-card" data-id="' + esc(o.id || "") + '">' +
            '<div class="q4-fig ' + fc + '">' + esc(initials(title)) + '</div>' +
            '<div>' +
              '<div class="title">' + esc(title) + '</div>' +
              '<div class="meta">' + esc(merchant) +
                (total ? ' · ' + esc(total) : '') +
                ' · qty ' + qty +
                (extraMeta || '') +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }

      let html = "";
      if (stage === "idle") {
        html = '<div class="q4-empty">Discover milk &amp; eggs — or restock from iMessage. Steps: Search → Quote → Pay → Receipt.</div>';
        if (paybox) paybox.innerHTML = "";
      } else if (stage === "search") {
        html += '<div class="q4-flow"><b>1 Search</b> — Prava found ' + rows.length + ' shippable offer(s). Quote one.</div>';
        html += rows.slice(0, 4).map(function (o) {
          const canQuote = o.status === "discovered" || o.status === "quoted";
          return (
            cardHtml(o, "") +
            (canQuote
              ? '<div class="q4-minirow">' +
                  '<button type="button" data-action="quote" data-id="' + esc(o.id) + '">Quote</button>' +
                '</div>'
              : "")
          );
        }).join("");
        if (paybox) paybox.innerHTML = "";
      } else if (stage === "quote") {
        const o = quoted[0];
        html += '<div class="q4-flow"><b>2 Quote</b> — checkout ready. Pay opens sandbox.collect.</div>';
        html += cardHtml(o, "");
        html +=
          '<div class="q4-minirow">' +
            '<button type="button" class="pay" data-action="pay" data-id="' + esc(o.id) + '">Pay</button>' +
          '</div>';
        if (paybox) paybox.innerHTML = "";
      } else if (stage === "pay") {
        html += '<div class="q4-flow"><b>3 Pay</b> — CARD-03 · CVV 93 · 12/30 · OTP 456789</div>';
        html += cardHtml(awaiting, "");
        if (paybox && awaiting.paymentUrl) {
          paybox.innerHTML =
            '<a href="' + esc(awaiting.paymentUrl) + '" target="_blank" rel="noopener">Open pay link</a>';
        }
      } else if (stage === "receipt" && paid) {
        html += '<div class="q4-flow"><b>4 Receipt</b> — Prava marked paid</div>';
        html +=
          '<div class="q4-receipt">' +
            '<div class="r-label">Purchased</div>' +
            '<div class="r-title">' + esc(paid.title || "Item") + '</div>' +
            '<div class="r-meta">' + esc(paid.merchant || "") +
              ' · ' + esc(paid.total || "") +
              ' · qty ' + (paid.quantity || 1) +
              (paid.orderId ? '<br>Order ' + esc(paid.orderId) : '') +
            '</div>' +
            '<div class="r-card">Visa ····2200 · sandbox</div>' +
          '</div>';
      }
      body.innerHTML = html;
    }


    async function refreshOffers() {
      const status = document.getElementById("q4Status");
      try {
        const res = await fetch(PART3_API + "/api/part3/offers");
        const snap = await res.json().catch(function() { return {}; });
        if (!res.ok) {
          throw new Error(snap.error || snap.hint || ("offers " + res.status));
        }
        try {
          const oRes = await fetch(PART3_API + "/api/part3/orders");
          if (oRes.ok) {
            const od = await oRes.json();
            snap._orders = od.orders || [];
          }
        } catch (e) { /* optional */ }
        renderOffers(snap);
      } catch (e) {
        if (status) status.textContent = "Part 3 offline — " + e.message;
      }
    }

    async function runDiscover() {
      const btn = document.getElementById("q4Discover");
      const status = document.getElementById("q4Status");
      btn.disabled = true;
      status.textContent = "discovering…";
      try {
        const res = await fetch(PART3_API + "/api/part3/discover", { method: "POST" });
        const data = await res.json();
        if (!res.ok && res.status !== 409) throw new Error(data.error || "discover failed");
        status.textContent = "discovering…";
        // Poll until ready
        for (let i = 0; i < 90; i++) {
          await new Promise(function(r) { setTimeout(r, 2000); });
          const snapRes = await fetch(PART3_API + "/api/part3/offers");
          const snap = await snapRes.json();
          renderOffers(snap);
          if (snap.status === "ready" || snap.status === "error") break;
        }
      } catch (e) {
        status.textContent = "Error: " + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function quoteOffer(id) {
      const qty = q4Qty[id] || 1;
      document.getElementById("q4Status").textContent = "quoting…";
      try {
        const res = await fetch(PART3_API + "/api/part3/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offerId: id, quantity: qty }),
        });
        const data = await res.json();
        await refreshOffers();
        if (!res.ok) {
          document.getElementById("q4Status").textContent = data.error || "quote failed";
          return;
        }
        document.getElementById("q4Status").textContent =
          "quoted · " + (data.quote && data.quote.quoteTotal ? data.quote.quoteTotal : "ok");
      } catch (e) {
        document.getElementById("q4Status").textContent = "quote error: " + e.message;
      }
    }

    async function payOffer(id) {
      let snap;
      try {
        snap = await (await fetch(PART3_API + "/api/part3/offers")).json();
      } catch (e) {
        document.getElementById("q4Status").textContent = "Part 3 offline";
        return;
      }
      const o = (snap.rows || []).find(function(r) { return r.id === id; });
      if (!o || !o.checkoutSessionId || !o.quoteTotal) {
        document.getElementById("q4Status").textContent = "Quote first";
        return;
      }
      const qty = q4Qty[id] || o.quantity || 1;
      let payCfg = { sandboxConfigured: false, defaultMode: "live" };
      try {
        payCfg = await (await fetch(PART3_API + "/api/part3/pay-config")).json();
      } catch (e) { /* ignore */ }
      const mode = payCfg.defaultMode || (payCfg.sandboxConfigured ? "sandbox" : "live");
      const cardHint = mode === "sandbox"
        ? "\\n\\nSandbox CARD-03: 4622943123232200 / CVV 93 / exp 12/30 / OTP 456789"
        : "\\n\\nLive: real US/CA/SEA Visa only (sandbox card will fail)";
      const ok = window.confirm(
        "Pay " + o.quoteTotal + " to " + o.merchant +
        " for qty " + qty + " × " + o.title +
        "\\nMode: " + mode +
        "\\nShip-to: " + (o.shipToLabel || snap.shipToLabel || "default") +
        cardHint
      );
      if (!ok) return;
      document.getElementById("q4Status").textContent = "starting pay (" + mode + ")…";
      try {
        const res = await fetch(PART3_API + "/api/part3/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkoutSessionId: o.checkoutSessionId,
            merchant: o.merchant,
            total: o.quoteTotal,
            currency: o.currency || "USD",
            title: o.title,
            quantity: qty,
            confirm: true,
            mode: mode,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "pay failed");
        q4PayOrderId = data.order && data.order.id;
        const box = document.getElementById("q4Paybox");
        const url = data.order && data.order.paymentUrl;
        const modeLabel = (data.order && data.order.payMode) || mode;
        if (url) {
          box.innerHTML =
            '<div>Pay in Safari (' + esc(modeLabel) + ')</div>' +
            '<a href="' + esc(url) + '" target="_blank" rel="noopener">Open payment link</a>' +
            '<div class="pay-url">' + esc(url) + '</div>';
        } else {
          box.textContent = 'Awaiting payment…';
        }
        pollPayOrder();
      } catch (e) {
        document.getElementById("q4Status").textContent = "pay error: " + e.message;
      }
    }

    async function pollPayOrder() {
      if (!q4PayOrderId) return;
      try {
        const res = await fetch(PART3_API + "/api/part3/orders/" + q4PayOrderId);
        if (!res.ok) return;
        const o = await res.json();
        document.getElementById("q4Status").textContent = "pay · " + o.status;
        const box = document.getElementById("q4Paybox");
        if (o.status === "paid") {
          box.innerHTML = '<div class="pay-ok">Payment successful ✓</div>' +
            '<div>' + esc(o.title || '') + ' · ' + esc(o.total || '') + '</div>';
          q4PayOrderId = null;
        } else if (o.status === "failed" || o.status === "cancelled") {
          box.textContent = "Failed: " + (o.error || o.status);
          q4PayOrderId = null;
        } else if (o.paymentUrl) {
          box.innerHTML =
            '<div>Pay in Safari · ' + esc(o.status) + '</div>' +
            '<a href="' + esc(o.paymentUrl) + '" target="_blank" rel="noopener">Open payment link</a>' +
            '<div class="pay-url">' + esc(o.paymentUrl) + '</div>';
        }
      } catch (e) { /* ignore */ }
    }

    setInterval(refreshHealth, 2000);
    setInterval(refreshChat, 2000);
    setInterval(refreshLocation, 8000);
    // Q4 blank — no offers UI
    const _q4Body = document.getElementById("q4Body");
    if (_q4Body) _q4Body.addEventListener("click", function (e) {
      const btn = e.target.closest("button[data-action]");
      if (!btn || btn.disabled) return;
      const id = btn.getAttribute("data-id");
      if (!id) return;
      if (btn.getAttribute("data-action") === "quote") quoteOffer(id);
      if (btn.getAttribute("data-action") === "pay") payOffer(id);
    });
    const q4ListEl = document.getElementById("q4List");
    if (q4ListEl) {
      q4ListEl.addEventListener("click", function (e) {
        const btn = e.target.closest("button[data-action]");
        if (!btn || btn.disabled) return;
        const id = btn.getAttribute("data-id");
        if (!id) return;
        if (btn.getAttribute("data-action") === "quote") quoteOffer(id);
        if (btn.getAttribute("data-action") === "pay") payOffer(id);
      });
    }
    window.q4SetQty = q4SetQty;
    refreshHealth();
    refreshChat();
    refreshLocation();
    refreshOffers();
  </script>
</body>
</html>
"""


@app.on_event("startup")
def _startup() -> None:
    # Prefer working camera: env → 0 laptop fallback
    preferred = int(os.getenv("CAMERA_INDEX", "0"))
    set_active_camera(preferred)
    # If preferred has no frame quickly, fall back to 0
    time.sleep(0.6)
    stream = STREAMS.get(preferred)
    if stream and stream.get_bgr() is None and preferred != 0:
        print(f"[startup] camera {preferred} has no frame → falling back to laptop 0")
        set_active_camera(0)
    threading.Thread(target=auto_detect_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    print(
        f"[startup] Hackathon Prava Payments http://127.0.0.1:8765 "
        f"active={ACTIVE_CAMERA} auto_detect={AUTO_DETECT} every={DETECT_INTERVAL_SEC}s"
    )


@app.on_event("shutdown")
def _shutdown() -> None:
    for s in list(STREAMS.values()):
        s.stop()


@app.get("/", response_class=HTMLResponse)
def home() -> HTMLResponse:
    return HTMLResponse(
        content=PAGE,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@app.get("/stream")
def stream() -> StreamingResponse:
    return StreamingResponse(
        mjpeg_active(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/api/state")
def api_state() -> dict:
    with STATE_LOCK:
        cam = ACTIVE_CAMERA
    stream = STREAMS.get(cam)
    last_at = LAST_DETECT.get("at")
    # rough countdown for UI (server-side interval)
    return {
        "active_camera": cam,
        "stream": stream.status() if stream else {},
        "seconds_to_next_detect": int(DETECT_INTERVAL_SEC),
        "auto_detect": AUTO_DETECT,
        "interval": DETECT_INTERVAL_SEC,
        "last_detect": {
            "at": last_at,
            "objects": LAST_DETECT.get("objects") or [],
            "summary": LAST_DETECT.get("summary"),
            "error": LAST_DETECT.get("error"),
            "image_ready": bool(LAST_DETECT.get("path")),
        },
    }


@app.post("/api/camera")
def api_camera(index: int = Query(0)):
    if index not in CAMERA_LABELS:
        return JSONResponse({"error": "invalid camera"}, status_code=400)
    set_active_camera(index)
    # wait briefly for frame
    stream = ensure_stream(index)
    for _ in range(25):
        if stream.get_bgr() is not None:
            break
        time.sleep(0.05)
    st = stream.status()
    print(f"[camera] switched → {index} ({CAMERA_LABELS.get(index)}) frame={st['has_frame']}")
    return {"active_camera": index, "stream": st}


@app.post("/api/detect")
def detect(camera: int | None = Query(None)) -> JSONResponse:
    with STATE_LOCK:
        cam = ACTIVE_CAMERA if camera is None else camera
    if camera is not None and camera != ACTIVE_CAMERA:
        set_active_camera(camera)
        cam = camera
    result = run_detection(cam)
    if "error" in result:
        return JSONResponse(result, status_code=503)
    result["interval"] = DETECT_INTERVAL_SEC
    return JSONResponse(result)


@app.get("/api/annotated")
def annotated() -> Response:
    path = LAST_DETECT.get("path")
    if not path or not Path(path).exists():
        return JSONResponse({"error": "no detection yet"}, status_code=404)
    return Response(content=Path(path).read_bytes(), media_type="image/jpeg")


@app.get("/api/chat")
def proxy_chat() -> JSONResponse:
    return _proxy_json(
        f"{PART2_UPSTREAM}/api/chat",
        offline_hint="Run: cd part2_linq && npm run start",
    )


@app.post("/api/agent/simulate")
async def proxy_agent_simulate(request: Request) -> JSONResponse:
    """Web iPhone compose → treat as inbound manager text (live Linq when dryRun false)."""
    body = await request.body()
    return _proxy_json(
        f"{PART2_UPSTREAM}/api/agent/simulate",
        method="POST",
        body=body or b"{}",
        timeout=300,
        offline_hint="Run: cd part2_linq && npm run start",
    )


@app.get("/api/location")
def proxy_location() -> JSONResponse:
    return _proxy_json(
        f"{PART2_UPSTREAM}/api/location",
        timeout=45,
        offline_hint="Run: cd part2_linq && npm run start",
    )


@app.get("/api/location/stored")
def proxy_location_stored() -> JSONResponse:
    return _proxy_json(
        f"{PART2_UPSTREAM}/api/location/stored",
        offline_hint="Run: cd part2_linq && npm run start",
    )


@app.get("/api/part3/{path:path}")
def proxy_part3_get(path: str) -> JSONResponse:
    return _proxy_part3(path, method="GET")


@app.post("/api/part3/{path:path}")
async def proxy_part3_post(path: str, request: Request) -> JSONResponse:
    body = await request.body()
    return _proxy_part3(path, method="POST", body=body or b"{}")


@app.get("/health")
def health() -> dict:
    with STATE_LOCK:
        cam = ACTIVE_CAMERA
    stream = STREAMS.get(cam)
    return {
        "ok": True,
        "active_camera": cam,
        "stream": stream.status() if stream else {},
        "part2_upstream": PART2_UPSTREAM,
        "part3_upstream": PART3_UPSTREAM,
        "last_detect": {
            "at": LAST_DETECT.get("at"),
            "objects": LAST_DETECT.get("objects"),
            "error": LAST_DETECT.get("error"),
        },
    }


if __name__ == "__main__":
    import uvicorn

    # Railway sets PORT; local default remains 8765
    port = int(os.getenv("PORT") or os.getenv("WEB_PORT", "8765"))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Hackathon Prava Payments → http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="warning")
