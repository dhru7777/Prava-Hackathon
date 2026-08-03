#!/usr/bin/env python3
"""
Part 1 add-on — detect milk / eggs and draw outline boxes on the image.

How products usually do this:
  A) Classic object detection (YOLO, etc.) → tight boxes, needs training/weights
  B) Vision LLM returns approximate boxes → we draw them with Pillow (this script)

We use (B) for the hackathon: fast to test, good enough for a demo outline.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "frames" / "outlined"

DETECT_PROMPT = """You are an inventory vision system for a hackathon demo (milk + eggs).

TASKS for each object:
  1) Detect the FULL object (tight bounding box around the entire vessel / carton).
  2) Estimate how full the milk container is (liquid volume), not just that it exists.

Labels:
  - milk — plastic gallon jug, bottle, carton, OR clear test can/jar holding liquid
  - egg / eggs / egg_carton — eggs or egg carton

CRITICAL — bounding boxes (box_2d):
  - box_2d = [ymin, xmin, ymax, xmax] as integers 0–1000 (normalized to image H/W).
  - MUST cover the WHOLE object: cap, neck, handle, bottom corners, full plastic body.
  - Do NOT box only the liquid puddle or only the label sticker.
  - Container may be upright OR held sideways / tilted — still box the full silhouette.
  - Prefer a slightly larger box that contains everything over a cropped partial box.

CRITICAL — fill estimation (milk only):
  - fill_percent: integer 0–100 = estimated LIQUID VOLUME fraction (not plastic whiteness).
  - confidence: 0–1 = identity confidence ONLY ("is this milk?"), NEVER copy fill into confidence.
  - state: ok | low | empty
      ok    → fill_percent >= 50
      low   → 1 <= fill_percent <= 49
      empty → fill_percent == 0

  TRANSLUCENT / cloudy HDPE gallon jugs (very common demo):
  - Empty plastic still looks milky-white. WHITENESS ≠ FULL.
  - Decide fill by finding the liquid POOL + air pocket, not by jug color.
  - SIDEWAYS / handheld tilted jug:
      * If most of the jug body looks hollow/see-through or only a SMALL white puddle
        sits in one corner/end → fill_percent 0–15 (state empty or low).
      * A truly full sideways jug would show liquid filling almost the entire cavity,
        with at most a tiny air bubble — NOT a mostly-empty shell.
      * If background/shirt is visible through large regions of the jug → not full.
  - Upright opaque white jug with NO visible air gap / uniform dense white ≈ 90–100 ok.
  - Glare / specular highlights on plastic are NOT liquid.
  - Droplets/residue on inner walls alone ≠ a full jug.

  When unsure between "full white plastic" vs "empty translucent jug with a puddle",
  prefer LOW/EMPTY if you can see a distinct small pool and a large empty cavity.

Return ONLY JSON:
{
  "objects": [
    {
      "label": "milk" | "egg" | "eggs" | "egg_carton",
      "confidence": 0.0-1.0,
      "fill_percent": 0-100,
      "state": "ok" | "low" | "empty",
      "fill_estimate": "e.g. nearly empty / ~10% / half / full",
      "box_2d": [ymin, xmin, ymax, xmax]
    }
  ]
}

For eggs, set fill_percent to null and omit state/fill_estimate or leave state unused.
Only include objects you can actually see. Empty list if none.
"""

COLORS = {
    "milk": (0, 180, 80),
    "egg": (255, 180, 0),
    "eggs": (255, 180, 0),
    "egg_carton": (255, 120, 0),
}


def compress(image_bytes: bytes, max_side: int = 1024, quality: int = 82) -> tuple[bytes, Image.Image]:
    with Image.open(io.BytesIO(image_bytes)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        w, h = im.size
        scale = min(1.0, max_side / float(max(w, h)))
        if scale < 1.0:
            im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=quality, optimize=True)
        return buf.getvalue(), im.copy()


def parse_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()
        if raw.startswith("json"):
            raw = raw[4:].strip()
    return json.loads(raw)


def detect_anthropic(jpeg: bytes, model: str) -> tuple[dict, dict]:
    import anthropic

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    b64 = base64.b64encode(jpeg).decode()
    msg = client.messages.create(
        model=model,
        max_tokens=1200,
        system=DETECT_PROMPT,
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
                    {
                        "type": "text",
                        "text": (
                            "Detect milk/eggs. Tight FULL-object boxes. "
                            "For milk, estimate fill_percent from the liquid pool "
                            "(sideways nearly-empty jug with a small puddle → low/empty). "
                            "Return JSON only."
                        ),
                    },
                ],
            }
        ],
    )
    text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
    usage = {
        "input_tokens": msg.usage.input_tokens,
        "output_tokens": msg.usage.output_tokens,
    }
    return normalize_objects(parse_json(text)), usage


def detect_openai(jpeg: bytes, model: str) -> tuple[dict, dict]:
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    b64 = base64.b64encode(jpeg).decode()
    completion = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": DETECT_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Detect milk/eggs. Tight FULL-object boxes. "
                            "For milk, estimate fill_percent from the liquid pool "
                            "(sideways nearly-empty jug with a small puddle → low/empty). "
                            "Return JSON only."
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{b64}",
                            "detail": "high",
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
    }
    return normalize_objects(parse_json(raw)), usage


def normalize_objects(data: dict) -> dict:
    """Align milk state with fill_percent; keep eggs as presence-only."""
    objects = data.get("objects") or []
    fixed: list[dict] = []
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        label = str(obj.get("label", "item")).strip().lower()
        try:
            conf = float(obj.get("confidence") or 0)
        except (TypeError, ValueError):
            conf = 0.0
        conf = max(0.0, min(1.0, conf))

        fill = obj.get("fill_percent", None)
        try:
            if fill is not None:
                fill = int(round(float(fill)))
                fill = max(0, min(100, fill))
        except (TypeError, ValueError):
            fill = None

        state = str(obj.get("state") or "").strip().lower()
        if label == "milk" and fill is not None:
            if fill == 0:
                state = "empty"
            elif fill < 50:
                state = "low"
            else:
                state = "ok"
        elif label == "milk" and state not in {"ok", "low", "empty"}:
            state = "low"  # unknown fill but milk present — conservative

        out = {
            **obj,
            "label": label,
            "confidence": conf,
            "fill_percent": fill,
            "state": state or None,
            "fill_estimate": str(obj.get("fill_estimate") or "").strip() or None,
        }
        fixed.append(out)
    return {**data, "objects": fixed}


def draw_boxes(im: Image.Image, objects: list[dict]) -> Image.Image:
    out = im.copy()
    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
    except OSError:
        font = ImageFont.load_default()

    w, h = out.size
    for obj in objects:
        label = str(obj.get("label", "item")).lower()
        conf = float(obj.get("confidence") or 0)
        box = obj.get("box_2d") or obj.get("bbox")
        if not box or len(box) != 4:
            continue
        ymin, xmin, ymax, xmax = [float(v) for v in box]
        # Support 0-1000 normalized OR already-pixel coords
        if max(ymin, xmin, ymax, xmax) <= 1.5:
            y1, x1, y2, x2 = ymin * h, xmin * w, ymax * h, xmax * w
        elif max(ymin, xmin, ymax, xmax) <= 1000:
            y1, x1, y2, x2 = (ymin / 1000) * h, (xmin / 1000) * w, (ymax / 1000) * h, (xmax / 1000) * w
        else:
            y1, x1, y2, x2 = ymin, xmin, ymax, xmax

        x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
        state = str(obj.get("state") or "").lower()
        fill = obj.get("fill_percent")
        # Color by fill state for milk; eggs keep default
        if label == "milk" and state == "empty":
            color = (220, 60, 60)
        elif label == "milk" and state == "low":
            color = (230, 160, 20)
        else:
            color = COLORS.get(label, (0, 140, 255))
        for t in range(3):
            draw.rectangle([x1 - t, y1 - t, x2 + t, y2 + t], outline=color)
        if label == "milk" and fill is not None:
            caption = f"{label} {state or '?'} {fill}% (id {conf:.2f})"
        else:
            caption = f"{label} {conf:.2f}"
        tw = draw.textlength(caption, font=font)
        draw.rectangle([x1, max(0, y1 - 24), x1 + int(tw) + 8, y1], fill=color)
        draw.text((x1 + 4, max(0, y1 - 22)), caption, fill=(0, 0, 0), font=font)
    return out


def fetch_shot(url: str) -> bytes:
    base = url.rstrip("/")
    resp = requests.get(f"{base}/shot.jpg", timeout=10)
    resp.raise_for_status()
    return resp.content


def main() -> None:
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description="Draw outlines around milk/eggs")
    parser.add_argument("--image", type=Path, help="Local image path")
    parser.add_argument(
        "--camera",
        type=int,
        nargs="?",
        const=int(os.getenv("CAMERA_INDEX", "0")),
        default=None,
        help="OpenCV camera index (Continuity Camera / webcam). Default index from CAMERA_INDEX or 0.",
    )
    parser.add_argument(
        "--url",
        default=os.getenv("IP_WEBCAM_URL", ""),
        help="Optional Android IP Webcam URL (legacy)",
    )
    parser.add_argument("--provider", choices=["openai", "anthropic"], default=None)
    args = parser.parse_args()

    provider = (args.provider or os.getenv("VISION_PROVIDER") or "").strip().lower()
    if not provider:
        if os.getenv("OPENAI_API_KEY"):
            provider = "openai"
        elif os.getenv("ANTHROPIC_API_KEY"):
            provider = "anthropic"
        else:
            print("Need OPENAI_API_KEY or ANTHROPIC_API_KEY in .env", file=sys.stderr)
            sys.exit(1)

    if args.image:
        raw = args.image.read_bytes()
        src_name = args.image.stem
    elif args.camera is not None or not args.url:
        from camera_opencv import grab_jpeg

        cam_index = args.camera if args.camera is not None else int(os.getenv("CAMERA_INDEX", "0"))
        try:
            raw = grab_jpeg(cam_index)
            src_name = f"opencv_{cam_index}"
        except Exception as exc:  # noqa: BLE001
            print(f"OpenCV camera unavailable ({exc})", file=sys.stderr)
            sys.exit(1)
    else:
        try:
            raw = fetch_shot(args.url)
            src_name = "live"
        except Exception as exc:  # noqa: BLE001
            print(f"Camera unavailable ({exc}). Try --camera 0", file=sys.stderr)
            sys.exit(1)

    jpeg, im = compress(raw)
    if provider == "openai":
        if not os.getenv("OPENAI_API_KEY"):
            print("OPENAI_API_KEY missing. Add it to part1_vision/.env", file=sys.stderr)
            sys.exit(1)
        model = os.getenv("OPENAI_VISION_MODEL", "gpt-4o")
        data, usage = detect_openai(jpeg, model)
    else:
        model = os.getenv("ANTHROPIC_VISION_MODEL", "claude-sonnet-4-5")
        data, usage = detect_anthropic(jpeg, model)

    objects = data.get("objects") or []
    annotated = draw_boxes(im, objects)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{src_name}_outlined.jpg"
    annotated.save(out_path, quality=90)

    print(f"provider={provider} model={model}")
    print(f"objects={json.dumps(objects, indent=2)}")
    print(f"tokens={usage}")
    print(f"saved={out_path}")


if __name__ == "__main__":
    main()
