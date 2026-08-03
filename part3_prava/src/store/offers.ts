import fs from "node:fs";
import path from "node:path";
import { DATA } from "../prava/cli.js";
import type { OfferRow, OffersSnapshot, OrderRecord } from "../types.js";

const OFFERS_PATH = path.join(DATA, "offers.json");
const DISCOVER_PATH = path.join(DATA, "discover_results.json");
const ORDERS_PATH = path.join(DATA, "orders.jsonl");

function ensureDataDir() {
  fs.mkdirSync(DATA, { recursive: true });
}

let memory: OffersSnapshot = {
  at: new Date(0).toISOString(),
  shipToLabel: null,
  status: "idle",
  rows: [],
};

export function loadOffers(): OffersSnapshot {
  ensureDataDir();
  try {
    if (fs.existsSync(OFFERS_PATH)) {
      memory = JSON.parse(fs.readFileSync(OFFERS_PATH, "utf8")) as OffersSnapshot;
    }
  } catch {
    /* keep memory */
  }
  return memory;
}

export function saveOffers(snap: OffersSnapshot): OffersSnapshot {
  ensureDataDir();
  memory = snap;
  fs.writeFileSync(OFFERS_PATH, JSON.stringify(snap, null, 2));
  fs.writeFileSync(
    DISCOVER_PATH,
    JSON.stringify({ at: snap.at, rows: snap.rows }, null, 2),
  );
  return memory;
}

export function updateOffer(id: string, patch: Partial<OfferRow>): OfferRow | null {
  const snap = loadOffers();
  const idx = snap.rows.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  snap.rows[idx] = { ...snap.rows[idx], ...patch };
  snap.at = new Date().toISOString();
  saveOffers(snap);
  return snap.rows[idx];
}

export function setDiscovering(): OffersSnapshot {
  const snap = loadOffers();
  return saveOffers({
    ...snap,
    status: "discovering",
    message: "Searching milk & eggs…",
    at: new Date().toISOString(),
  });
}

export function appendOrder(order: OrderRecord): void {
  ensureDataDir();
  fs.appendFileSync(ORDERS_PATH, JSON.stringify(order) + "\n");
}

export function updateOrder(id: string, patch: Partial<OrderRecord>): OrderRecord | null {
  ensureDataDir();
  if (!fs.existsSync(ORDERS_PATH)) return null;
  const lines = fs.readFileSync(ORDERS_PATH, "utf8").split("\n").filter(Boolean);
  let updated: OrderRecord | null = null;
  const out = lines.map((line) => {
    try {
      const o = JSON.parse(line) as OrderRecord;
      if (o.id === id) {
        updated = { ...o, ...patch };
        return JSON.stringify(updated);
      }
      return line;
    } catch {
      return line;
    }
  });
  if (updated) fs.writeFileSync(ORDERS_PATH, out.join("\n") + "\n");
  return updated;
}

export function listOrders(limit = 20): OrderRecord[] {
  ensureDataDir();
  if (!fs.existsSync(ORDERS_PATH)) return [];
  const lines = fs.readFileSync(ORDERS_PATH, "utf8").split("\n").filter(Boolean);
  const orders: OrderRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      orders.push(JSON.parse(line) as OrderRecord);
    } catch {
      /* skip */
    }
  }
  return orders.reverse();
}

export function getOrder(id: string): OrderRecord | null {
  return listOrders(100).find((o) => o.id === id) || null;
}
