/**
 * STATUS path: camera (optional) or dummy vision fixture → inventory update.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyVisionUpserts } from "../inventory/csvStore.js";
import { mapVisionObjects, type VisionObject } from "../inventory/mapVision.js";
import { scanInventory, type ScanResult } from "../inventory/scanner.js";
import { PATHS } from "../inventory/paths.js";
import { appendMemory } from "./memory.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = path.join(ROOT, "fixtures", "vision");

const CASE_FILES = [
  "case1_full.json",
  "case2_half.json",
  "case3_empty.json",
] as const;

export type StatusCheckResult = {
  source: "camera" | "dummy";
  caseId: string;
  description: string;
  objects: VisionObject[];
  scan: ScanResult;
};

function pickDummyFile(): string {
  const forced = (process.env.STATUS_VISION_CASE || "").toLowerCase().trim();
  if (forced === "full" || forced === "1" || forced === "1_full") {
    return CASE_FILES[0];
  }
  if (forced === "half" || forced === "2" || forced === "2_half") {
    return CASE_FILES[1];
  }
  if (forced === "empty" || forced === "3" || forced === "3_empty") {
    return CASE_FILES[2];
  }
  // Rotate by minute so demos show variety without env churn
  const idx = Math.floor(Date.now() / 60_000) % CASE_FILES.length;
  return CASE_FILES[idx];
}

function loadFixture(file: string): {
  caseId: string;
  description: string;
  objects: VisionObject[];
} {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
  return {
    caseId: String(raw.case || file),
    description: String(raw.description || "dummy vision"),
    objects: (raw.objects || []) as VisionObject[],
  };
}

/** Best-effort live detect via Part1; returns null if camera off / unreachable. */
async function tryPart1Detect(): Promise<VisionObject[] | null> {
  const useCam = (process.env.STATUS_USE_CAMERA || "").toLowerCase();
  if (!(useCam === "1" || useCam === "true" || useCam === "yes")) {
    return null;
  }
  const base = (process.env.PART1_API || "http://127.0.0.1:8765").replace(
    /\/$/,
    "",
  );
  try {
    const res = await fetch(`${base}/api/detect?camera=0`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const objects = (json.objects || []) as VisionObject[];
    return objects.length ? objects : null;
  } catch (e: any) {
    console.warn("[statusCheck] Part1 detect skip", e?.message || e);
    return null;
  }
}

/**
 * Run vision (camera if enabled, else dummy fixture) and upsert inventory.
 */
export async function runStatusVisionCheck(): Promise<StatusCheckResult> {
  const live = await tryPart1Detect();
  let source: "camera" | "dummy" = "dummy";
  let caseId = "dummy";
  let description = "dummy vision fixture";
  let objects: VisionObject[] = [];

  if (live?.length) {
    source = "camera";
    caseId = "live_camera";
    description = "live Part1 detect";
    objects = live;
  } else {
    const file = pickDummyFile();
    const fix = loadFixture(file);
    caseId = fix.caseId;
    description = fix.description;
    objects = fix.objects;
  }

  const upserts = mapVisionObjects(objects);
  applyVisionUpserts(upserts);
  fs.writeFileSync(
    PATHS.lastVision,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        source,
        case: caseId,
        description,
        objects,
        upserts,
      },
      null,
      2,
    ),
  );

  const scan = scanInventory();
  appendMemory({
    type: "status_vision",
    source,
    case: caseId,
    summary: scan.summary,
  });

  return { source, caseId, description, objects, scan };
}

export function formatVisionLines(objects: VisionObject[]): string {
  return (objects || [])
    .map((o) => {
      const label = String(o.label || "item").trim() || "item";
      const fill =
        o.fill_percent != null && !Number.isNaN(Number(o.fill_percent))
          ? `${Number(o.fill_percent)}%`
          : "seen";
      const state = o.state ? ` (${o.state})` : "";
      return `• ${label} ${fill}${state}`;
    })
    .join("\n");
}
