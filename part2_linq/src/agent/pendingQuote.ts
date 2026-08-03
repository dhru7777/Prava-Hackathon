/**
 * Last open quote — so "qty 2" / "change quantity" can re-quote for real
 * (not LLM pretending to adjust).
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../inventory/paths.js";

const PATH = path.join(DATA_DIR, "pending_quote.json");

export type PendingQuote = {
  offerId: string;
  title: string;
  merchant: string;
  quantity: number;
  quoteTotal?: string;
  paymentUrl?: string;
  orderId?: string;
  checkoutSessionId?: string;
  at: string;
};

export function loadPendingQuote(): PendingQuote | null {
  try {
    if (!fs.existsSync(PATH)) return null;
    const j = JSON.parse(fs.readFileSync(PATH, "utf8")) as PendingQuote;
    if (!j?.offerId || !j.title) return null;
    if (Date.now() - new Date(j.at).getTime() > 45 * 60_000) {
      clearPendingQuote();
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

export function savePendingQuote(q: PendingQuote): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PATH, JSON.stringify(q, null, 2));
}

export function clearPendingQuote(): void {
  try {
    if (fs.existsSync(PATH)) fs.unlinkSync(PATH);
  } catch {
    /* ignore */
  }
}

export function hasPendingQuote(): boolean {
  return Boolean(loadPendingQuote()?.offerId);
}

/** "change the quantity to 2", "qty 2", "quantity 2" */
export function parseQtyChange(text: string): number | null {
  const t = text.trim();
  const m =
    t.match(
      /\b(?:change|update|set|make)\s+(?:the\s+)?(?:qty|quantity)\s+(?:to\s+)?(\d{1,2})\b/i,
    ) ||
    t.match(/\b(?:qty|quantity)\s*[:=]?\s*(\d{1,2})\b/i) ||
    t.match(/^(?:to\s+)?(\d{1,2})\s*(?:x|units?|gallons?|dozen)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  // Don't steal bare "1"–"4" catalog picks when search options are pending
  if (/^[1-4]$/.test(t)) return null;
  return n;
}
