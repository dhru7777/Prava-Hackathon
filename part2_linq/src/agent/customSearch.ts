/**
 * Manager NL → catalog discover → (optional) quote/pay.
 *
 * Any natural ask for a product should clarify if vague, otherwise search Prava,
 * list options, and place order when they say so (or "…and place order" in one breath).
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../inventory/paths.js";
import { readRecentChats } from "./memory.js";
import {
  discoverQueries,
  offerLine,
  part3Fetch,
  quoteAndPayOffers,
  usableOffers,
  type RestockResult,
} from "./part3Client.js";
import { msgFail } from "./messages.js";
import {
  hasPendingQuote,
  loadPendingQuote,
  parseQtyChange,
} from "./pendingQuote.js";

const PENDING_PATH = path.join(DATA_DIR, "custom_search_pending.json");

export type PendingOffer = {
  id: string;
  title: string;
  merchant: string;
  priceEstimate?: string;
  query: string;
};

export type PendingCustomSearch = {
  query: string;
  at: string;
  offers: PendingOffer[];
};

export type CatalogIntent =
  | { kind: "search"; query: string; autoBuy: boolean }
  | { kind: "fridge_restock"; focus: "milk" | "eggs" | "camera"; autoBuy: boolean }
  | { kind: "buy_pending"; pick: number }
  | { kind: "requote"; quantity: number }
  | { kind: "status_nudge" }
  | { kind: "clarify"; message: string }
  | { kind: "none" };

const STOP = new Set([
  "a",
  "an",
  "the",
  "some",
  "any",
  "me",
  "us",
  "please",
  "for",
  "to",
  "my",
  "our",
  "shop",
  "store",
  "cafe",
  "café",
  "and",
  "then",
  "also",
  "just",
]);

const FRIDGE_CMDS =
  /^(approve|yes|y|buy|status|location|share|loc|address|skip|no|n|cancel|help|hi|hello|hey)\b/i;

function stripTailNoise(q: string): string {
  return q
    .replace(/[?.!]+$/g, "")
    .replace(/\b(please|thanks|thank you)\b/gi, " ")
    .replace(
      /\b(and\s+)?(then\s+)?(place|put|make|complete|finish)?\s*(an?\s+)?order(s)?\b.*$/i,
      " ",
    )
    .replace(/\b(and\s+)?(buy|purchase|pay|checkout)(\s+it)?\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(raw: string): string {
  let q = stripTailNoise(raw);
  q = q
    .split(/\s+/)
    .filter((w) => !STOP.has(w.toLowerCase()))
    .join(" ")
    .trim();
  return q;
}

function wantsAutoBuy(text: string): boolean {
  return /\b(place|put|make|complete)\s+(an?\s+)?order\b|\band\s+(buy|order|purchase|pay)\b|\bbuy\s+(it|one|them)\b|\bcheckout\b/i.test(
    text,
  );
}

/** Confirm catalog buy — NOT fridge APPROVE/YES. */
export function isPlaceOrderConfirm(text: string): boolean {
  const t = text.trim();
  if (/^(APPROVE|YES|Y|BUY)\b/i.test(t)) return false;
  return (
    /^(place|put|make)\s+(the\s+|an?\s+)?order\b/i.test(t) ||
    /^(go\s+ahead|do\s+it|order\s+it|buy\s+it|get\s+it|proceed|please\s+proceed|confirm(ed)?)\b/i.test(
      t,
    ) ||
    /^(yes|yeah|yep|sure|ok|okay)[,.]?\s+(place|order|buy|get|proceed)\b/i.test(t) ||
    /\bconfirmed\b.*\bproceed\b/i.test(t)
  );
}

function fridgeProductFocus(q: string): "milk" | "eggs" | null {
  const s = q.toLowerCase();
  if (/^(whole\s+)?milk\b|gallon\s+milk|oat\s+milk|2%\s*milk|dairy\b/.test(s) && !/chocolate|coffee/.test(s)) {
    if (/egg/.test(s)) return null;
    return "milk";
  }
  if (/^((large|dozen)\s+)?eggs?\b|egg\s+box|egg\s+carton/.test(s)) return "eggs";
  return null;
}

export function isSearchStatusNudge(text: string): boolean {
  return /^(are\s+you\s+(looking|searching|still\s+looking|done)|still\s+looking|did\s+you\s+(find|search)|any\s+(options|results|luck)|what\s+did\s+you\s+find)\b/i.test(
    text.trim(),
  );
}

/** Last product-ish ask from recent user chats. */
export function lastProductFromChats(): string | null {
  const chats = readRecentChats(25);
  for (let i = chats.length - 1; i >= 0; i--) {
    const c = chats[i];
    if (c.role !== "user") continue;
    const parsed = parseCatalogIntent(c.text, { skipNudge: true });
    if (parsed.kind === "search") return parsed.query;
  }
  return null;
}

/**
 * Interpret manager NL for catalog flow.
 */
export function parseCatalogIntent(
  text: string,
  opts?: { skipNudge?: boolean },
): CatalogIntent {
  const t = text.trim();
  if (!t || t.length < 2) return { kind: "none" };

  // Bare fridge commands
  if (/^(STATUS|LOCATION|SHARE|LOC|ADDRESS|SKIP|HELP|HI|HELLO|HEY)\b/i.test(t)) {
    return { kind: "none" };
  }

  if (!opts?.skipNudge && isSearchStatusNudge(t)) {
    return { kind: "status_nudge" };
  }

  // Agentic qty change on the open quote (real re-quote, not LLM chat)
  const qtyChange = parseQtyChange(t);
  if (qtyChange != null && hasPendingQuote()) {
    return { kind: "requote", quantity: qtyChange };
  }

  // Pending confirm → buy #1 catalog
  if (isPlaceOrderConfirm(t) && hasPendingCustomSearch()) {
    return { kind: "buy_pending", pick: 1 };
  }
  // "proceed" after a pay link — keep same item (don't restart fridge search)
  if (isPlaceOrderConfirm(t) && hasPendingQuote()) {
    const q = loadPendingQuote()!;
    return { kind: "requote", quantity: q.quantity };
  }
  // "please proceed" with no catalog/quote pending → fridge restock using camera focus
  if (isPlaceOrderConfirm(t) && !hasPendingCustomSearch()) {
    return { kind: "fridge_restock", focus: "camera", autoBuy: true };
  }

  const pick =
    t.match(/^(?:#?\s*)([1-4])\s*[.)]?$/) ||
    t.match(/^(?:pick|choose|buy|option|number)\s*#?\s*([1-4])\b/i) ||
    t.match(/^i(?:'ll)?\s+(?:take|go with)\s*#?\s*([1-4])\b/i);
  if (pick) {
    return { kind: "buy_pending", pick: Number(pick[1]) };
  }

  const autoBuy = wantsAutoBuy(t);

  const patterns: RegExp[] = [
    /(?:search|find|look\s*(?:for|up)|source|shop\s+for)\s+(?:for\s+)?(.+)/i,
    /^search\s+(.+)/i,
    /(?:place|put|make)\s+(?:an?\s+)?order\s+(?:for\s+)?(.+)/i,
    /(?:order|buy|get|purchase|procure)\s+(?:me\s+|us\s+)?(.+)/i,
    /(?:can\s+you|could\s+you|please|pls)\s+(?:search|find|look\s*(?:for|up)|order|buy|get|source)\s+(?:for\s+|me\s+)?(.+)/i,
    /^i\s+(?:want|need|wanna)\s+(.+)/i,
    /^(?:we|the\s+café|the\s+cafe|shop)\s+(?:want|need)\s+(.+)/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    let q = cleanQuery(m[1]);
    if (!q) continue;
    if (FRIDGE_CMDS.test(q)) continue;

    const fridge = fridgeProductFocus(q);
    if (fridge) {
      return { kind: "fridge_restock", focus: fridge, autoBuy: true };
    }

    if (q.length >= 2 && q.length <= 80) {
      return { kind: "search", query: q, autoBuy };
    }
  }

  // Vague order with no product
  if (
    /^(place|put|make)\s+(the\s+|an?\s+)?order\b/i.test(t) ||
    /^(order|buy)\s+(something|stuff)?\s*$/i.test(t)
  ) {
    if (hasPendingCustomSearch()) {
      return { kind: "buy_pending", pick: 1 };
    }
    return {
      kind: "clarify",
      message:
        "What should I order? e.g. coffee packs, dark chocolate, oat milk — then I’ll search, quote, and send a pay link.",
    };
  }

  return { kind: "none" };
}

/** @deprecated prefer parseCatalogIntent */
export function extractCatalogQuery(text: string): string | null {
  const p = parseCatalogIntent(text);
  return p.kind === "search" ? p.query : null;
}

export function extractPickIndex(text: string): number | null {
  const p = parseCatalogIntent(text);
  return p.kind === "buy_pending" ? p.pick : null;
}

export function loadPendingSearch(): PendingCustomSearch | null {
  try {
    if (!fs.existsSync(PENDING_PATH)) return null;
    const raw = JSON.parse(
      fs.readFileSync(PENDING_PATH, "utf8"),
    ) as PendingCustomSearch;
    if (!raw?.offers?.length || !raw.query) return null;
    if (Date.now() - new Date(raw.at).getTime() > 30 * 60_000) {
      clearPendingSearch();
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function savePendingSearch(pending: PendingCustomSearch): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

export function clearPendingSearch(): void {
  try {
    if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
  } catch {
    /* ignore */
  }
}

export function hasPendingCustomSearch(): boolean {
  return Boolean(loadPendingSearch()?.offers?.length);
}

function formatOptionsMessage(query: string, offers: PendingOffer[]): string {
  const list = offers
    .slice(0, 4)
    .map((o, i) => {
      const price = o.priceEstimate ? ` · ${o.priceEstimate}` : "";
      return `${i + 1}. ${o.title.slice(0, 40)} · ${o.merchant.replace(/^www\./, "")}${price}`;
    })
    .join("\n");
  return (
    `I searched Prava for "${query}":\n` +
    `${list}\n\n` +
    `Reply 1–${Math.min(4, offers.length)}, or “place the order” for #1.`
  );
}

/**
 * Search only — never pays. Saves pending picks for follow-up.
 */
export async function runCatalogSearch(
  query: string,
  onStep?: (msg: string) => Promise<void>,
): Promise<{ ok: boolean; message: string; pending: PendingCustomSearch | null }> {
  const q = query.trim();
  if (!q) {
    return {
      ok: false,
      message:
        "What should I search for? e.g. chocolates, coffee packs, oat milk.",
      pending: null,
    };
  }

  await onStep?.(
    `On it — searching Prava for "${q}"…\nI’ll list shippable options next.`,
  );

  try {
    const rows = await discoverQueries([q]);
    const usable = usableOffers(rows);
    if (!usable.length) {
      clearPendingSearch();
      const message = msgFail(
        `No shippable "${q}" offers yet. Try another name, or say what else you need.`,
      );
      await onStep?.(message);
      return { ok: false, message, pending: null };
    }

    const pending: PendingCustomSearch = {
      query: q,
      at: new Date().toISOString(),
      offers: usable.slice(0, 4).map((r) => ({
        id: String(r.id),
        title: String(r.title || "Item"),
        merchant: String(r.merchant || "?"),
        priceEstimate: String(r.priceEstimate || r.quoteTotal || ""),
        query: String(r.query || q),
      })),
    };
    savePendingSearch(pending);
    const message = formatOptionsMessage(q, pending.offers);
    await onStep?.(message);
    return { ok: true, message, pending };
  } catch (e: any) {
    const message = msgFail(e?.message || String(e));
    await onStep?.(message);
    return { ok: false, message, pending: null };
  }
}

/**
 * Full NL path: search → optional auto-buy #1 (quote + pay link).
 */
export async function runCatalogFlow(
  query: string,
  autoBuy: boolean,
  onStep?: (msg: string) => Promise<void>,
): Promise<{
  ok: boolean;
  message: string;
  intent: string;
  pay?: RestockResult;
}> {
  const searched = await runCatalogSearch(query, onStep);
  if (!searched.ok || !searched.pending) {
    return {
      ok: false,
      message: searched.message,
      intent: "catalog_search",
    };
  }
  if (!autoBuy) {
    return {
      ok: true,
      message: searched.message,
      intent: "catalog_search",
    };
  }
  await onStep?.(
    `You asked to place the order — quoting #1: ${searched.pending.offers[0].title}…`,
  );
  const pay = await buyPendingPick(1, onStep);
  return {
    ok: pay.ok,
    message: pay.message,
    intent: pay.ok ? "catalog_buy" : "catalog_buy_failed",
    pay,
  };
}

export async function buyPendingPick(
  pickIndex: number,
  onStep?: (msg: string) => Promise<void>,
): Promise<RestockResult> {
  const pending = loadPendingSearch();
  if (!pending?.offers?.length) {
    const message = msgFail(
      "No pending options. Tell me what to search for first (e.g. coffee packs).",
    );
    await onStep?.(message);
    return { ok: false, error: "no_pending", message, steps: [message] };
  }

  const idx = Math.max(1, Math.min(pending.offers.length, pickIndex)) - 1;
  const pick = pending.offers[idx];
  await onStep?.(
    `Quoting #${idx + 1}: ${pick.title} · ${pick.merchant}\nHang tight for a pay link…`,
  );

  let liveRows: any[] = [];
  try {
    const snap = await part3Fetch("/api/part3/offers");
    liveRows = usableOffers(snap.rows || []);
  } catch {
    /* empty */
  }

  const byId = new Map(liveRows.map((r) => [String(r.id), r]));
  const orderedIds = [
    ...pending.offers.slice(idx).map((o) => o.id),
    ...pending.offers.slice(0, idx).map((o) => o.id),
  ];
  const candidates = orderedIds
    .map((id) => byId.get(id))
    .filter(
      (r): r is any =>
        Boolean(r && Array.isArray(r.variants) && r.variants.length),
    );

  if (!candidates.length) {
    const message = msgFail(
      `Couldn't quote "${pick.title}" — say “search for ${pending.query}” again.`,
    );
    await onStep?.(message);
    return { ok: false, error: "offer_stale", message, steps: [message] };
  }

  const result = await quoteAndPayOffers(candidates, onStep);
  if (result.ok) clearPendingSearch();
  return result;
}

export function isCatalogSearchIntent(text: string): boolean {
  const p = parseCatalogIntent(text);
  return p.kind === "search" || p.kind === "clarify" || p.kind === "status_nudge";
}

export function pendingSummary(): string {
  const p = loadPendingSearch();
  if (!p) return "(no pending catalog search)";
  return (
    `Pending search "${p.query}":\n` +
    p.offers.map((o, i) => `${i + 1}. ${offerLine(o as any)}`).join("\n")
  );
}
