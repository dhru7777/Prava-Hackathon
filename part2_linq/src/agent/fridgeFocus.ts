/**
 * Fridge restock focus — camera + inventory. Minimal copy.
 */

import fs from "node:fs";
import { PATHS, DATA_DIR } from "../inventory/paths.js";
import type { VisionObject } from "../inventory/mapVision.js";
import { scanInventory } from "../inventory/scanner.js";

const FOCUS_PATH = `${DATA_DIR}/fridge_restock_focus.json`;

export type FridgeFocus = "milk" | "eggs" | "both";

const LOW_FILL = 55;

function milkFill(objects: VisionObject[]): number | null {
  const o = (objects || []).find((x) =>
    /milk|dairy|jug/i.test(String(x.label || "")),
  );
  if (!o || o.fill_percent == null) return null;
  const n = Number(o.fill_percent);
  return Number.isNaN(n) ? null : n;
}

function eggFill(objects: VisionObject[]): number | null {
  const o = (objects || []).find((x) => /egg/i.test(String(x.label || "")));
  if (!o || o.fill_percent == null) return null;
  const n = Number(o.fill_percent);
  return Number.isNaN(n) ? null : n;
}

function inventoryNeeds(): { milk: boolean; eggs: boolean } {
  const scan = scanInventory();
  let milk = false;
  let eggs = false;
  for (const a of scan.critical) {
    const blob = `${a.sku_id} ${a.sku_name}`.toLowerCase();
    if (/milk|dairy|oat/.test(blob)) milk = true;
    if (/egg/.test(blob)) eggs = true;
  }
  return { milk, eggs };
}

/** What should we restock: camera lows + inventory lows. */
export function neededFridgeItems(objects: VisionObject[]): {
  milk: boolean;
  eggs: boolean;
  milkFill: number | null;
  eggFill: number | null;
} {
  const mFill = milkFill(objects);
  const eFill = eggFill(objects);
  const inv = inventoryNeeds();
  const milkCam = mFill != null && mFill <= LOW_FILL;
  const eggCam = eFill != null && eFill <= LOW_FILL;
  return {
    milk: milkCam || inv.milk,
    eggs: eggCam || inv.eggs,
    milkFill: mFill,
    eggFill: eFill,
  };
}

export function focusFromNeeded(needed: {
  milk: boolean;
  eggs: boolean;
}): FridgeFocus {
  if (needed.milk && needed.eggs) return "both";
  if (needed.milk) return "milk";
  if (needed.eggs) return "eggs";
  return "both";
}

export function saveFridgeFocusFromVision(objects: VisionObject[]): FridgeFocus {
  const needed = neededFridgeItems(objects);
  const focus = focusFromNeeded(needed);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    FOCUS_PATH,
    JSON.stringify(
      {
        focus,
        at: new Date().toISOString(),
        needed,
      },
      null,
      2,
    ),
  );
  return focus;
}

/** Short restock line for camera iMessage — includes why + urgency. */
export function cameraRestockSummary(objects: VisionObject[]): string {
  const needed = neededFridgeItems(objects);
  saveFridgeFocusFromVision(objects);
  const scan = scanInventory();

  const parts: string[] = [];
  if (needed.milk) {
    parts.push(
      needed.milkFill != null ? `milk (~${needed.milkFill}%)` : "milk",
    );
  }
  if (needed.eggs) {
    parts.push(
      needed.eggFill != null ? `eggs (~${needed.eggFill}%)` : "eggs",
    );
  }

  if (!parts.length) {
    return "Looks fine.\nReply APPROVE if you still want to restock.";
  }

  const eggAlert = scan.alerts.find((a) => /egg/i.test(`${a.sku_id} ${a.sku_name}`));
  const milkAlert = scan.alerts.find((a) =>
    /milk|dairy/i.test(`${a.sku_id} ${a.sku_name}`),
  );

  const whyBits: string[] = [];
  let urgency: "critical" | "high" | "medium" = "medium";

  if (needed.eggs) {
    if (needed.eggFill != null && needed.eggFill <= 20) {
      whyBits.push("camera shows eggs nearly empty");
      urgency = "critical";
    } else if (needed.eggFill != null && needed.eggFill <= LOW_FILL) {
      whyBits.push(`camera eggs at ~${needed.eggFill}%`);
      urgency = "high";
    } else if (eggAlert) {
      whyBits.push(eggAlert.reason);
      urgency = eggAlert.severity === "critical" ? "critical" : "high";
    } else {
      whyBits.push("eggs below safe stock");
      urgency = "high";
    }
  }

  if (needed.milk) {
    if (needed.milkFill != null && needed.milkFill <= 20) {
      whyBits.push("camera shows milk nearly empty");
      urgency = "critical";
    } else if (needed.milkFill != null && needed.milkFill <= LOW_FILL) {
      whyBits.push(`camera milk at ~${needed.milkFill}%`);
      if (urgency !== "critical") urgency = "high";
    } else if (milkAlert) {
      whyBits.push(milkAlert.reason);
      if (milkAlert.severity === "critical") urgency = "critical";
      else if (urgency !== "critical") urgency = "high";
    } else {
      whyBits.push("milk below safe stock");
      if (urgency !== "critical") urgency = "high";
    }
  }

  const why =
    whyBits.slice(0, 2).join("; ").replace(/\s+/g, " ").trim() ||
    "low stock needs restock today";

  return (
    `Needed: ${parts.join(", ")}\n` +
    `Why: ${why}\n` +
    `Urgency: ${urgency}\n` +
    `Reply APPROVE to restock.`
  );
}

export function readFridgeFocus(): FridgeFocus {
  try {
    if (fs.existsSync(FOCUS_PATH)) {
      const j = JSON.parse(fs.readFileSync(FOCUS_PATH, "utf8"));
      if (j.focus === "milk" || j.focus === "eggs" || j.focus === "both") {
        return j.focus;
      }
    }
  } catch {
    /* fall through */
  }
  try {
    if (fs.existsSync(PATHS.lastVision)) {
      const v = JSON.parse(fs.readFileSync(PATHS.lastVision, "utf8"));
      const objs = (v.objects || v.detections || []) as VisionObject[];
      if (objs.length) return saveFridgeFocusFromVision(objs);
    }
  } catch {
    /* ignore */
  }
  // Inventory-only fallback
  const inv = inventoryNeeds();
  return focusFromNeeded(inv);
}

export function setFridgeFocus(focus: FridgeFocus): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    FOCUS_PATH,
    JSON.stringify({ focus, at: new Date().toISOString(), source: "user" }, null, 2),
  );
}

export function clearFridgeFocus(): void {
  try {
    if (fs.existsSync(FOCUS_PATH)) fs.unlinkSync(FOCUS_PATH);
  } catch {
    /* ignore */
  }
}
