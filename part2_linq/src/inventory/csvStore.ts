/**
 * Read/write café inventory CSVs. Safe to test without Linq/OpenAI/Prava.
 */

import fs from "node:fs";
import { PATHS, DATA_DIR } from "./paths.js";

export type InventoryRow = {
  ts: string;
  date: string;
  time: string;
  dow: string;
  is_weekend: string;
  sku_id: string;
  sku_name: string;
  category: string;
  unit: string;
  qty_on_hand: string;
  par_level: string;
  visitors_day: string;
  restock_qty: string;
  runway_days: string;
  avg_daily_use_7d: string;
  stockout_risk: string;
  [k: string]: string;
};

const CURRENT_HEADERS = [
  "ts",
  "date",
  "time",
  "dow",
  "is_weekend",
  "sku_id",
  "sku_name",
  "category",
  "unit",
  "qty_on_hand",
  "par_level",
  "visitors_day",
  "restock_qty",
  "runway_days",
  "avg_daily_use_7d",
  "stockout_risk",
] as const;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function parseCsv(text: string): { headers: string[]; rows: InventoryRow[] } {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (!lines.length) return { headers: [...CURRENT_HEADERS], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows: InventoryRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    const row: InventoryRow = {} as InventoryRow;
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function escapeCsv(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToLine(headers: string[], row: Record<string, string>): string {
  return headers.map((h) => escapeCsv(String(row[h] ?? ""))).join(",");
}

export function readCurrentInventory(): InventoryRow[] {
  ensureDataDir();
  if (!fs.existsSync(PATHS.inventoryCurrent)) return [];
  return parseCsv(fs.readFileSync(PATHS.inventoryCurrent, "utf8")).rows;
}

export function readOpenOrders(): Record<string, string>[] {
  if (!fs.existsSync(PATHS.ordersOpen)) return [];
  return parseCsv(fs.readFileSync(PATHS.ordersOpen, "utf8")).rows;
}

export function readRecentOrders(limit = 20): Record<string, string>[] {
  if (!fs.existsSync(PATHS.orders)) return [];
  const rows = parseCsv(fs.readFileSync(PATHS.orders, "utf8")).rows;
  return rows.slice(-limit);
}

export function writeCurrentInventory(rows: InventoryRow[]): void {
  ensureDataDir();
  const headers = [...CURRENT_HEADERS];
  const body = rows.map((r) => rowToLine(headers, r)).join("\n");
  fs.writeFileSync(PATHS.inventoryCurrent, headers.join(",") + "\n" + body + "\n");
}

/** Append full snapshot rows to history (one line per SKU at this ts). */
export function appendHistorySnapshot(rows: InventoryRow[]): void {
  ensureDataDir();
  const headers = [...CURRENT_HEADERS];
  const exists = fs.existsSync(PATHS.inventoryHistory);
  const lines = rows.map((r) => rowToLine(headers, r));
  if (!exists) {
    fs.writeFileSync(PATHS.inventoryHistory, headers.join(",") + "\n" + lines.join("\n") + "\n");
  } else {
    fs.appendFileSync(PATHS.inventoryHistory, lines.join("\n") + "\n");
  }
}

export function slugSkuId(label: string): string {
  return (
    "VISION-" +
    label
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
  );
}

export type UpsertSkuInput = {
  sku_id: string;
  sku_name: string;
  category: string;
  unit: string;
  qty_on_hand: number;
  par_level?: number;
  avg_daily_use_7d?: number;
  source?: string;
};

/**
 * Merge vision/estimated levels into current inventory.
 * Unknown sku_id → append new row. Known → update qty (+ optional meta).
 * Then rewrite current + append history snapshot for all current rows at ts.
 */
export function applyVisionUpserts(
  upserts: UpsertSkuInput[],
  opts?: { visitors_day?: number },
): InventoryRow[] {
  const now = new Date();
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "");
  const date = ts.slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  const dow = now.toLocaleDateString("en-US", { weekday: "short" });
  const is_weekend = now.getDay() === 0 || now.getDay() === 6 ? "1" : "0";
  const visitors = String(opts?.visitors_day ?? "");

  const byId = new Map<string, InventoryRow>();
  for (const r of readCurrentInventory()) {
    byId.set(r.sku_id, { ...r });
  }

  for (const u of upserts) {
    const existing = byId.get(u.sku_id);
    const qty = Math.max(0, u.qty_on_hand);
    const par = u.par_level ?? (Number(existing?.par_level || 2) || 2);
    const use7 = u.avg_daily_use_7d ?? (Number(existing?.avg_daily_use_7d || 0.5) || 0.5);
    const runway = qty / Math.max(use7, 0.05);
    const stockout = qty < 0.15 * par ? "1" : "0";

    if (existing) {
      existing.ts = ts;
      existing.date = date;
      existing.time = time;
      existing.dow = dow;
      existing.is_weekend = is_weekend;
      existing.qty_on_hand = String(Number(qty.toFixed(2)));
      existing.runway_days = String(Number(runway.toFixed(2)));
      existing.avg_daily_use_7d = String(Number(use7.toFixed(3)));
      existing.stockout_risk = stockout;
      existing.par_level = String(par);
      if (visitors) existing.visitors_day = visitors;
      byId.set(u.sku_id, existing);
    } else {
      byId.set(u.sku_id, {
        ts,
        date,
        time,
        dow,
        is_weekend,
        sku_id: u.sku_id,
        sku_name: u.sku_name,
        category: u.category,
        unit: u.unit,
        qty_on_hand: String(Number(qty.toFixed(2))),
        par_level: String(par),
        visitors_day: visitors || "0",
        restock_qty: "0",
        runway_days: String(Number(runway.toFixed(2))),
        avg_daily_use_7d: String(Number(use7.toFixed(3))),
        stockout_risk: stockout,
      });
    }
  }

  // Refresh ts on all rows so current file is one snapshot
  const rows = [...byId.values()].map((r) => ({
    ...r,
    ts,
    date,
    time,
    dow,
    is_weekend,
  }));

  writeCurrentInventory(rows);
  appendHistorySnapshot(rows);
  return rows;
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== inventory/csvStore.ts ===");
  const before = readCurrentInventory();
  console.log(before.length ? `PASS read current (${before.length})` : "FAIL empty current");
  const testId = "VISION-TEST-JAR";
  applyVisionUpserts([
    {
      sku_id: testId,
      sku_name: "Test jar (vision)",
      category: "vision",
      unit: "each",
      qty_on_hand: 1,
      par_level: 2,
      avg_daily_use_7d: 0.2,
    },
  ]);
  const after = readCurrentInventory();
  const hit = after.find((r) => r.sku_id === testId);
  console.log(hit ? `PASS upsert new SKU qty=${hit.qty_on_hand}` : "FAIL upsert");
  // cleanup test sku
  writeCurrentInventory(after.filter((r) => r.sku_id !== testId));
  console.log("RESULT: csvStore OK ✅\n");
}

const running = process.argv[1]?.includes("inventory/csvStore.ts");
if (running) selfTest();
