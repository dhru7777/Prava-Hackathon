/**
 * Scan current inventory + open orders → actionable alerts.
 */

import { readCurrentInventory, readOpenOrders } from "./csvStore.js";

export type InventoryAlert = {
  sku_id: string;
  sku_name: string;
  qty_on_hand: number;
  runway_days: number;
  par_level: number;
  severity: "critical" | "low" | "ok";
  reason: string;
  has_open_order: boolean;
};

export type ScanResult = {
  at: string;
  alerts: InventoryAlert[];
  critical: InventoryAlert[];
  summary: string;
};

export function scanInventory(opts?: { runwayAlertDays?: number }): ScanResult {
  const threshold = opts?.runwayAlertDays ?? Number(process.env.RUNWAY_ALERT_DAYS || 2.5);
  const open = readOpenOrders();
  const openSkus = new Set(open.map((o) => o.sku_id));
  const alerts: InventoryAlert[] = [];

  for (const r of readCurrentInventory()) {
    const qty = Number(r.qty_on_hand || 0);
    const runway = Number(r.runway_days || 0);
    const par = Number(r.par_level || 0);
    const hasOpen = openSkus.has(r.sku_id);
    let severity: InventoryAlert["severity"] = "ok";
    let reason = "OK";

    if (qty <= 0 || r.stockout_risk === "1") {
      severity = "critical";
      reason = qty <= 0 ? "stockout (qty 0)" : "below 15% of par";
    } else if (runway <= threshold) {
      severity = "low";
      reason = `runway ${runway}d ≤ ${threshold}d`;
    } else if (qty < 0.5 * par) {
      severity = "low";
      reason = `qty ${qty} < half par ${par}`;
    }

    alerts.push({
      sku_id: r.sku_id,
      sku_name: r.sku_name,
      qty_on_hand: qty,
      runway_days: runway,
      par_level: par,
      severity,
      reason,
      has_open_order: hasOpen,
    });
  }

  const critical = alerts.filter((a) => a.severity !== "ok");
  const needAction = critical.filter((a) => !a.has_open_order);
  const summary =
    needAction.length === 0
      ? critical.length
        ? `Inventory watch: ${critical.length} low SKU(s) but open PO covers them.`
        : "Inventory healthy — no restock needed."
      : `Restock needed: ${needAction
          .map((a) => `${a.sku_name} (${a.reason})`)
          .join("; ")}`;

  return {
    at: new Date().toISOString(),
    alerts,
    critical: needAction,
    summary,
  };
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== inventory/scanner.ts ===");
  const s = scanInventory({ runwayAlertDays: 2.5 });
  console.log("summary:", s.summary.slice(0, 120));
  console.log(s.alerts.length ? `PASS scanned ${s.alerts.length} SKUs` : "FAIL no rows");
  console.log("RESULT: scanner OK ✅\n");
}

const running = process.argv[1]?.includes("inventory/scanner.ts");
if (running) selfTest();
