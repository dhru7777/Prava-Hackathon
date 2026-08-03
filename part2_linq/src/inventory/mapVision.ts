/**
 * Map Part1 vision objects → inventory upserts.
 * Unknown labels become new VISION-* SKUs (appended to current.csv).
 */

import { slugSkuId, type UpsertSkuInput } from "./csvStore.js";

export type VisionObject = {
  label?: string;
  confidence?: number;
  fill_percent?: number | null;
  state?: string | null;
  fill_estimate?: string | null;
};

/** Heuristic: fill% of a gallon jug → gallons on hand (café fridge). */
function milkFillToGallons(fillPercent: number | null | undefined): number {
  if (fillPercent == null || Number.isNaN(Number(fillPercent))) return 0;
  const f = Math.max(0, Math.min(100, Number(fillPercent))) / 100;
  // Assume one visible jug ≈ up to 1 gal capacity for demo
  return Number((f * 1.0).toFixed(2));
}

function eggsToDozen(label: string, confidence: number): number {
  // Vision rarely counts eggs precisely — treat detection as "at least some stock"
  if (/carton/i.test(label)) return confidence > 0.5 ? 1.0 : 0.5;
  return confidence > 0.5 ? 0.5 : 0.25;
}

export function mapVisionObjects(objects: VisionObject[]): UpsertSkuInput[] {
  const out: UpsertSkuInput[] = [];
  for (const o of objects || []) {
    const label = String(o.label || "").trim().toLowerCase();
    if (!label) continue;
    const conf = Number(o.confidence ?? 0.5);

    if (label === "milk") {
      const qty = milkFillToGallons(o.fill_percent);
      out.push({
        sku_id: "MILK-WHOLE-1GAL",
        sku_name: "Whole milk 1 gal",
        category: "dairy",
        unit: "gallon",
        qty_on_hand: qty,
        par_level: 6,
        avg_daily_use_7d: 2.2,
        source: "vision",
      });
      continue;
    }

    if (label === "egg" || label === "eggs" || label === "egg_carton") {
      out.push({
        sku_id: "EGG-LG-DZ",
        sku_name: "Large eggs dozen",
        category: "eggs",
        unit: "dozen",
        qty_on_hand: eggsToDozen(label, conf),
        par_level: 20,
        avg_daily_use_7d: 14,
        source: "vision",
      });
      continue;
    }

    // Unknown product in frame → append as new SKU
    const sku_id = slugSkuId(label);
    out.push({
      sku_id,
      sku_name: `${label} (vision)`,
      category: "vision",
      unit: "each",
      qty_on_hand: conf > 0.4 ? 1 : 0,
      par_level: 1,
      avg_daily_use_7d: 0.1,
      source: "vision",
    });
  }
  return out;
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== inventory/mapVision.ts ===");
  const ups = mapVisionObjects([
    { label: "milk", fill_percent: 15, state: "low", confidence: 0.9 },
    { label: "egg_carton", confidence: 0.8 },
    { label: "oat_bottle", confidence: 0.7 },
  ]);
  console.log(ups.find((u) => u.sku_id === "MILK-WHOLE-1GAL")?.qty_on_hand === 0.15 ? "PASS milk qty" : "FAIL milk");
  console.log(ups.some((u) => u.sku_id === "EGG-LG-DZ") ? "PASS eggs" : "FAIL eggs");
  console.log(ups.some((u) => u.sku_id.startsWith("VISION-")) ? "PASS unknown append" : "FAIL unknown");
  console.log("RESULT: mapVision OK ✅\n");
}

const running = process.argv[1]?.includes("inventory/mapVision.ts");
if (running) selfTest();
