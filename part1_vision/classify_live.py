#!/usr/bin/env python3
"""
Part 1 — Live fridge milk recognition via Android IP Webcam + vision LLM.

Loop:
  1. GET {IP_WEBCAM_URL}/shot.jpg
  2. Compress / resize for cheaper, faster vision calls
  3. Classify: ok | low | empty | not_visible
  4. Debounce low/empty → append one stockout event to events.jsonl

Providers: openai (OPENAI_API_KEY) or anthropic (ANTHROPIC_API_KEY).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
FRAMES_DIR = ROOT / "frames"
EVENTS_PATH = ROOT / "events.jsonl"

STATES_BELOW = {"low", "empty"}
VALID_STATES = {"ok", "low", "empty", "not_visible"}

# Vision payload size (keeps tokens/cost down)
MAX_SIDE = int(os.getenv("IMAGE_MAX_SIDE", "768"))
JPEG_QUALITY = int(os.getenv("IMAGE_JPEG_QUALITY", "70"))

SYSTEM_PROMPT = """You are a fridge / desk inventory vision classifier for a MILK TEST SETUP.

For this demo, ANY jug, bottle, carton, or clear plastic can/jar in frame that can hold liquid
should be treated as the milk container — even if the liquid looks like water.

Return ONLY a JSON object with keys:
  state: one of ok | low | empty | not_visible
  confidence: number from 0 to 1
  fill_percent: integer 0-100 (estimated how full the container is by liquid volume)
  fill_estimate: short string like "full", "~75%", "~50%", "~25%", "nearly empty", "empty", "unknown"
  liquid_visible: true/false (can you see a liquid surface / meniscus / contents)
  reason: short string

State rules from fill_percent:
  ok — fill_percent >= 50
  low — 1 <= fill_percent <= 49
  empty — fill_percent == 0 (container present but no usable liquid)
  not_visible — no container in frame

How to estimate fill_percent on CLEAR / translucent containers (test cans OK):
  - Look for the liquid line / meniscus / pool vs total container volume.
  - Empty clear jar = see-through, no liquid pool → fill_percent 0, state empty.
  - Half full → ~50. Be concrete; pick a number when the vessel is visible.
  - SIDEWAYS / TILTED jug (common demo mistake):
      * Liquid pools in the lowest corner only.
      * Large air pocket + small white puddle = nearly empty (0–15%), NOT full.
      * Glare on plastic is NOT milk — ignore specular highlights.
      * Wall residue droplets alone ≠ a full jug.

Opaque white gallon milk jugs (upright):
  - Uniform solid white / cloudy with no air gap often means FULL (~90-100), state ok.
  - Do NOT call a solid-white upright full jug "empty".

Prefer empty/low over ok when most of the jug is air and only a small pool remains.
"""

USER_TEXT = (
    "This is a milk restock TEST. Treat the jug/can/jar in frame as milk even if the liquid "
    "looks like water. Estimate fill_percent from the liquid POOL (sideways jug with a small "
    "puddle = nearly empty / low). Clear/translucent mostly-air container = empty or low. "
    "Reply with JSON only."
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_shot(base_url: str, timeout: float = 10.0) -> bytes:
    url = base_url.rstrip("/") + "/shot.jpg"
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    if not resp.content:
        raise RuntimeError("Empty image from IP Webcam")
    return resp.content


def compress_image(
    image_bytes: bytes,
    *,
    max_side: int = MAX_SIDE,
    quality: int = JPEG_QUALITY,
) -> tuple[bytes, dict]:
    """Resize + JPEG-compress. Returns (jpeg_bytes, meta)."""
    with Image.open(io.BytesIO(image_bytes)) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        w, h = im.size
        scale = min(1.0, max_side / float(max(w, h)))
        if scale < 1.0:
            new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
            im = im.resize(new_size, Image.Resampling.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=quality, optimize=True)
        compressed = out.getvalue()
        meta = {
            "orig_bytes": len(image_bytes),
            "orig_size": (w, h),
            "out_bytes": len(compressed),
            "out_size": im.size,
            "quality": quality,
            "max_side": max_side,
        }
        return compressed, meta


def save_frame(jpeg_bytes: bytes, prefix: str = "frame") -> Path:
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = FRAMES_DIR / f"{prefix}_{stamp}.jpg"
    path.write_bytes(jpeg_bytes)
    with Image.open(path) as im:
        im.verify()
    return path


def parse_classification(raw: str) -> dict:
    data = json.loads(raw)
    state = str(data.get("state", "not_visible")).strip().lower()
    if state not in VALID_STATES:
        state = "not_visible"
    try:
        confidence = float(data.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    fill_percent = data.get("fill_percent", None)
    try:
        if fill_percent is not None:
            fill_percent = int(round(float(fill_percent)))
            fill_percent = max(0, min(100, fill_percent))
    except (TypeError, ValueError):
        fill_percent = None

    # Align state with fill_percent when present (test harness consistency)
    if fill_percent is not None and state != "not_visible":
        if fill_percent == 0:
            state = "empty"
        elif fill_percent < 50:
            state = "low"
        else:
            state = "ok"

    reason = str(data.get("reason", "")).strip()
    fill_estimate = str(data.get("fill_estimate", "")).strip()
    if not fill_estimate and fill_percent is not None:
        fill_estimate = f"{fill_percent}%"

    liquid_visible = data.get("liquid_visible", None)
    if isinstance(liquid_visible, str):
        liquid_visible = liquid_visible.strip().lower() in {"1", "true", "yes"}

    return {
        "state": state,
        "confidence": confidence,
        "reason": reason,
        "fill_estimate": fill_estimate,
        "fill_percent": fill_percent,
        "liquid_visible": liquid_visible,
    }


def classify_openai(jpeg_bytes: bytes, model: str) -> tuple[dict, dict]:
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY")
    client = OpenAI(api_key=api_key)
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    completion = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_TEXT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{b64}",
                            "detail": "low",
                        },
                    },
                ],
            },
        ],
    )
    raw = completion.choices[0].message.content or "{}"
    usage = {
        "input_tokens": getattr(completion.usage, "prompt_tokens", None),
        "output_tokens": getattr(completion.usage, "completion_tokens", None),
        "total_tokens": getattr(completion.usage, "total_tokens", None),
    }
    return parse_classification(raw), usage


def classify_anthropic(jpeg_bytes: bytes, model: str) -> tuple[dict, dict]:
    import anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Missing ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=api_key)
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    message = client.messages.create(
        model=model,
        max_tokens=300,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": USER_TEXT},
                ],
            }
        ],
    )
    raw = "".join(
        block.text for block in message.content if getattr(block, "type", None) == "text"
    )
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
        if raw.endswith("```"):
            raw = raw[: -3]
        raw = raw.strip()
        if raw.startswith("json"):
            raw = raw[4:].strip()
    usage = {
        "input_tokens": message.usage.input_tokens,
        "output_tokens": message.usage.output_tokens,
        "total_tokens": message.usage.input_tokens + message.usage.output_tokens,
    }
    return parse_classification(raw), usage


def classify_image(provider: str, model: str, jpeg_bytes: bytes) -> tuple[dict, dict]:
    if provider == "openai":
        return classify_openai(jpeg_bytes, model)
    if provider == "anthropic":
        return classify_anthropic(jpeg_bytes, model)
    raise ValueError(f"Unknown VISION_PROVIDER: {provider}")


def append_event(event: dict) -> None:
    with EVENTS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")


def resolve_provider_and_model() -> tuple[str, str]:
    provider = os.getenv("VISION_PROVIDER", "").strip().lower()
    if not provider:
        if os.getenv("OPENAI_API_KEY", "").strip():
            provider = "openai"
        elif os.getenv("ANTHROPIC_API_KEY", "").strip():
            provider = "anthropic"
        else:
            provider = "openai"

    if provider == "openai":
        model = os.getenv("OPENAI_VISION_MODEL", "gpt-4o")
    else:
        model = os.getenv("ANTHROPIC_VISION_MODEL", "claude-sonnet-4-5")
    return provider, model


def classify_bytes(
    *,
    provider: str,
    model: str,
    raw_bytes: bytes,
    save_prefix: str = "frame",
) -> tuple[dict, dict, dict, Path]:
    compressed, img_meta = compress_image(raw_bytes)
    frame_path = save_frame(compressed, prefix=save_prefix)
    result, usage = classify_image(provider, model, compressed)
    return result, usage, img_meta, frame_path


def run_loop(
    *,
    grab_frame,
    source_label: str,
    interval: float,
    debounce: int,
    provider: str,
    model: str,
    once: bool,
) -> None:
    print(f"Source: {source_label}")
    print(
        f"Provider: {provider} | model={model} | interval={interval}s | "
        f"debounce={debounce} | max_side={MAX_SIDE} q={JPEG_QUALITY}"
    )
    print("Point the camera at the milk. Ctrl+C to stop.\n")

    below_streak = 0
    emitted_for_streak = False
    total_in = 0
    total_out = 0

    while True:
        try:
            jpeg = grab_frame()
            result, usage, img_meta, frame_path = classify_bytes(
                provider=provider, model=model, raw_bytes=jpeg
            )
            state = result["state"]
            conf = result["confidence"]
            reason = result["reason"]
            fill = result.get("fill_estimate") or "?"
            fill_pct = result.get("fill_percent")
            fill_pct_s = f"{fill_pct}%" if fill_pct is not None else "?"
            liquid = result.get("liquid_visible")

            tin = usage.get("input_tokens") or 0
            tout = usage.get("output_tokens") or 0
            total_in += tin
            total_out += tout

            print(
                f"[{utc_now()}] {state:12} conf={conf:.2f} "
                f"fill={fill_pct_s:>4} ({fill}) liquid={liquid}  "
                f"{img_meta['orig_bytes']}B→{img_meta['out_bytes']}B "
                f"{img_meta['orig_size']}→{img_meta['out_size']}  "
                f"tokens in={tin} out={tout}  file={frame_path.name}"
            )
            print(f"           {reason}")

            if state in STATES_BELOW:
                below_streak += 1
            else:
                below_streak = 0
                emitted_for_streak = False

            if below_streak >= debounce and not emitted_for_streak:
                event = {
                    "sku": "milk",
                    "state": state,
                    "confidence": conf,
                    "fill_percent": fill_pct,
                    "fill_estimate": fill,
                    "liquid_visible": liquid,
                    "reason": reason,
                    "timestamp": utc_now(),
                    "frame_path": str(frame_path),
                    "source": source_label,
                    "usage": usage,
                    "image": img_meta,
                }
                append_event(event)
                emitted_for_streak = True
                print(f"  >>> STOCKOUT EVENT written to {EVENTS_PATH.name}")
                print(f"  >>> {json.dumps(event)}")

        except KeyboardInterrupt:
            print(f"\nStopped. Session tokens: in={total_in} out={total_out} total={total_in + total_out}")
            break
        except Exception as exc:  # noqa: BLE001 — keep loop alive for demo
            print(f"[{utc_now()}] ERROR: {exc}", file=sys.stderr)
            below_streak = 0
            emitted_for_streak = False

        if once:
            print(f"Session tokens: in={total_in} out={total_out} total={total_in + total_out}")
            break
        time.sleep(interval)


def main() -> None:
    load_dotenv(ROOT / ".env")

    default_provider, default_model = resolve_provider_and_model()

    parser = argparse.ArgumentParser(
        description="Live milk stock classifier (OpenCV Continuity Camera / webcam)"
    )
    parser.add_argument(
        "--camera",
        type=int,
        default=int(os.getenv("CAMERA_INDEX", "0")),
        help="OpenCV camera index (default 0 — Continuity Camera / FaceTime)",
    )
    parser.add_argument(
        "--url",
        default=os.getenv("IP_WEBCAM_URL", "").strip(),
        help="Optional legacy Android IP Webcam URL (overrides --camera if set)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.getenv("SAMPLE_INTERVAL_SEC", "10")),
        help="Seconds between samples",
    )
    parser.add_argument(
        "--debounce",
        type=int,
        default=int(os.getenv("DEBOUNCE_COUNT", "2")),
        help="Consecutive low/empty reads before stockout event",
    )
    parser.add_argument(
        "--provider",
        choices=["openai", "anthropic"],
        default=default_provider,
        help="Vision provider",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Vision model (defaults from .env / provider)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Fetch and classify a single frame then exit",
    )
    parser.add_argument(
        "--image",
        type=Path,
        default=None,
        help="Classify a local image file instead of live camera",
    )
    parser.add_argument(
        "--test-shot",
        action="store_true",
        help="Only capture one frame (no vision API) to verify camera",
    )
    args = parser.parse_args()

    model = args.model
    if not model:
        model = (
            os.getenv("OPENAI_VISION_MODEL", "gpt-4o")
            if args.provider == "openai"
            else os.getenv("ANTHROPIC_VISION_MODEL", "claude-sonnet-4-5")
        )

    if args.image:
        raw = args.image.read_bytes()
        result, usage, img_meta, frame_path = classify_bytes(
            provider=args.provider,
            model=model,
            raw_bytes=raw,
            save_prefix="recheck",
        )
        print(
            f"state={result['state']} conf={result['confidence']:.2f} "
            f"fill_percent={result.get('fill_percent')} "
            f"fill={result.get('fill_estimate')} "
            f"liquid_visible={result.get('liquid_visible')} — {result['reason']}"
        )
        print(
            f"image {img_meta['orig_bytes']}B→{img_meta['out_bytes']}B "
            f"{img_meta['orig_size']}→{img_meta['out_size']}  saved={frame_path.name}"
        )
        print(
            f"tokens in={usage.get('input_tokens')} out={usage.get('output_tokens')} "
            f"total={usage.get('total_tokens')}"
        )
        return

    if args.url:
        source_label = args.url.rstrip("/") + "/shot.jpg"

        def grab_frame() -> bytes:
            return fetch_shot(args.url)
    else:
        from camera_opencv import grab_jpeg

        source_label = f"opencv://{args.camera}"

        def grab_frame() -> bytes:
            return grab_jpeg(args.camera)

    if args.test_shot:
        jpeg = grab_frame()
        compressed, meta = compress_image(jpeg)
        path = save_frame(compressed, prefix="test")
        print(
            f"OK — saved {path} raw={meta['orig_bytes']}B "
            f"compressed={meta['out_bytes']}B {meta['orig_size']}→{meta['out_size']} "
            f"source={source_label}"
        )
        return

    run_loop(
        grab_frame=grab_frame,
        source_label=source_label,
        interval=args.interval,
        debounce=args.debounce,
        provider=args.provider,
        model=model,
        once=args.once,
    )


if __name__ == "__main__":
    main()
