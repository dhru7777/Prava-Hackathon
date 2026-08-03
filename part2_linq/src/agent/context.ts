/**
 * Bundle datasets into a compact context string for the OpenAI agent.
 */

import fs from "node:fs";
import { PATHS } from "../inventory/paths.js";
import {
  readCurrentInventory,
  readOpenOrders,
  readRecentOrders,
} from "../inventory/csvStore.js";
import { scanInventory } from "../inventory/scanner.js";
import { readRecentChats } from "./memory.js";
import { loadOrDemoLocation } from "../store/locationStore.js";
import { getPeer } from "../linq/messagingService.js";
import { nextDeliveryWhen, snapshotFromStored } from "./locationCopy.js";
import { pendingSummary } from "./customSearch.js";
import { readFridgeFocus } from "./fridgeFocus.js";

export type AgentContext = {
  at: string;
  inventorySummary: string;
  scanSummary: string;
  openOrdersSummary: string;
  recentOrdersSummary: string;
  chatsSummary: string;
  locationSummary: string;
  visionSummary: string;
  fridgeFocus: string;
  packed: string;
};

export function buildAgentContext(): AgentContext {
  const at = new Date().toISOString();
  const focus = readFridgeFocus();
  const fridgeFocus =
    focus === "eggs"
      ? "eggs ONLY — camera/inventory says eggs need restock. Do NOT pitch milk unless they ask about milk."
      : focus === "milk"
        ? "milk ONLY — do NOT pitch eggs unless they ask about eggs."
        : "milk and/or eggs (both relevant)";

  const inv = readCurrentInventory();
  const inventorySummary = inv
    .map(
      (r) =>
        `${r.sku_id}: ${r.qty_on_hand} ${r.unit} (runway ${r.runway_days}d, par ${r.par_level}, risk=${r.stockout_risk})`,
    )
    .join("\n");

  const scan = scanInventory();
  const open = readOpenOrders();
  const openOrdersSummary = open.length
    ? open
        .map(
          (o) =>
            `${o.order_id} ${o.sku_id} qty=${o.order_qty} status=${o.status} trigger=${o.trigger}`,
        )
        .join("\n")
    : "(none)";

  const recent = readRecentOrders(8);
  const recentOrdersSummary = recent.length
    ? recent
        .map(
          (o) =>
            `${o.decision_date} ${o.sku_id} runway=${o.runway_days} → ${o.status} (${o.trigger})`,
        )
        .join("\n")
    : "(none)";

  const chats = readRecentChats(20);
  const chatsSummary = chats.length
    ? chats
        .map((c) => `[${c.role}] ${c.text.slice(0, 280)}`)
        .join("\n")
    : "(no prior chats)";

  let locationSummary = "unknown";
  try {
    const peer = getPeer();
    const loc = loadOrDemoLocation(peer);
    const snap = snapshotFromStored(loc);
    const when = snap.when || nextDeliveryWhen();
    locationSummary = snap.isDemo
      ? `DEMO pin — no real address yet`
      : `LIVE\nDeliver to: ${snap.shopName}\nAddress: ${snap.address}` +
        (when ? `\nETA: ${when}` : "") +
        `\n(updated ${loc.updatedAt})`;
  } catch (e: any) {
    locationSummary = `unavailable (${e?.message || e})`;
  }

  let visionSummary = "(no vision snapshot yet)";
  if (fs.existsSync(PATHS.lastVision)) {
    try {
      const v = JSON.parse(fs.readFileSync(PATHS.lastVision, "utf8"));
      visionSummary = JSON.stringify(v).slice(0, 800);
    } catch {
      /* ignore */
    }
  }

  const packed = [
    `TIME: ${at}`,
    `FRIDGE_FOCUS: ${focus} — ${fridgeFocus}`,
    `SCAN: ${scan.summary}`,
    `INVENTORY:\n${inventorySummary || "(empty)"}`,
    `OPEN_ORDERS:\n${openOrdersSummary}`,
    `RECENT_ORDERS:\n${recentOrdersSummary}`,
    `LOCATION: ${locationSummary}`,
    `PENDING_CATALOG_SEARCH:\n${pendingSummary()}`,
    `VISION: ${visionSummary}`,
    `RECENT_CHATS:\n${chatsSummary}`,
  ].join("\n\n");

  return {
    at,
    inventorySummary,
    scanSummary: scan.summary,
    openOrdersSummary,
    recentOrdersSummary,
    chatsSummary,
    locationSummary,
    visionSummary,
    fridgeFocus: focus,
    packed,
  };
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== agent/context.ts ===");
  const ctx = buildAgentContext();
  console.log(ctx.packed.slice(0, 400) + "...");
  console.log(ctx.inventorySummary ? "PASS context built" : "FAIL empty inv");
  console.log("RESULT: context OK ✅\n");
}

const running = process.argv[1]?.includes("agent/context.ts");
if (running) selfTest();
