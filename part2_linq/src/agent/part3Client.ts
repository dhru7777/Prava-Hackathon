/**
 * Call Part 3 (Prava) from Part 2 — discover → show options → quote → sandbox pay.
 * Progress steps are short iMessage-friendly strings via onStep.
 */

import {
  msgFail,
  msgOptionsFound,
  msgPayLink,
} from "./messages.js";
import { readLiveLocSnapshot } from "./locationCopy.js";
import { readFridgeFocus } from "./fridgeFocus.js";
import { savePendingQuote, loadPendingQuote } from "./pendingQuote.js";

const PART3_API = (process.env.PART3_API || "http://127.0.0.1:8788").replace(
  /\/$/,
  "",
);

export async function part3Fetch(path: string, init?: RequestInit): Promise<any> {
  const url = `${PART3_API}${path}`;
  console.log("[part3Client]", init?.method || "GET", url);
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(
      json?.error || json?.message || text.slice(0, 200) || `Part3 HTTP ${res.status}`,
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export type RestockResult = {
  ok: boolean;
  title?: string;
  merchant?: string;
  quoteTotal?: string;
  paymentUrl?: string;
  orderId?: string;
  payMode?: string;
  error?: string;
  message: string;
  steps: string[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Title (key) — price (value). Merchant stays on the Choosing line. */
function offerLine(r: any): string {
  const title = String(r.title || "Item").slice(0, 40);
  const price = String(r.quoteTotal || r.priceEstimate || "").trim();
  return price ? `${title} — ${price}` : title;
}

export { offerLine };

function parseMoney(v: unknown): number | null {
  const m = String(v || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** ~6–7 words: why #1 was chosen (not “eggs are low”). */
function pickWhy(pick: any, ranked: any[]): string {
  const pickPrice = parseMoney(pick?.quoteTotal || pick?.priceEstimate);
  const prices = ranked
    .map((r) => parseMoney(r?.quoteTotal || r?.priceEstimate))
    .filter((n): n is number => n != null && Number.isFinite(n));
  const lowest = prices.length ? Math.min(...prices) : null;
  const blob = `${pick?.title || ""} ${pick?.query || ""}`.toLowerCase();
  const isEgg = /egg/.test(blob);
  const isMilk = /milk|dairy|gallon/.test(blob);

  if (pickPrice != null && lowest != null && pickPrice === lowest) {
    return isEgg
      ? "Lowest shippable egg price available."
      : isMilk
        ? "Lowest shippable milk price available."
        : "Lowest shippable price among options.";
  }
  if (isEgg) return "Best shippable eggs for restock.";
  if (isMilk) return "Best shippable milk for restock.";
  return "Best shippable match for restock.";
}

/** Prefer milk/eggs for fridge APPROVE — never coffee/catalog leftovers. */
function rankOffers(rows: any[], focus: "milk" | "eggs" | "both" = "both"): any[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  const usable = rows.filter(
    (r) =>
      r &&
      r.status !== "unshippable" &&
      Array.isArray(r.variants) &&
      r.variants.length > 0,
  );
  // Fridge path: only milk/egg queries (drop chocolates/coffee from a prior custom search)
  const fridgeOnly = usable.filter((r) => {
    const blob = `${r.query || ""} ${r.title || ""}`.toLowerCase();
    return /milk|egg|dairy|gallon|dozen/.test(blob);
  });
  const pool = fridgeOnly.length ? fridgeOnly : usable;
  const score = (r: any) => {
    const blob = `${r.query || ""} ${r.title || ""} ${r.merchant || ""}`.toLowerCase();
    let s = 0;
    const isEgg = /egg/.test(blob);
    const isMilk = /milk|dairy|gallon/.test(blob);
    if (focus === "milk") {
      if (isMilk) s += 10;
      if (isEgg) s += 3;
    } else if (focus === "eggs") {
      if (isEgg) s += 10;
      if (isMilk) s += 3;
    } else {
      if (isMilk) s += 8;
      if (isEgg) s += 7;
    }
    if (/beprepared|lehmans|nourish|rooted|hollandia|localmarket/.test(blob)) s += 2;
    if (r.status === "error") s -= 2;
    if (/coffee|chocolate|candy|snack/.test(blob)) s -= 20;
    // Prefer normal dozen/gal over specialty bulk boxes when scores are close
    const price = parseMoney(r.quoteTotal || r.priceEstimate);
    if (price != null) {
      if (price <= 15) s += 4;
      else if (price <= 30) s += 2;
      else if (price >= 50) s -= 3;
    }
    return s;
  };
  return [...pool].sort((a, b) => {
    const ds = score(b) - score(a);
    if (ds !== 0) return ds;
    const pa = parseMoney(a.quoteTotal || a.priceEstimate) ?? 9_999;
    const pb = parseMoney(b.quoteTotal || b.priceEstimate) ?? 9_999;
    return pa - pb;
  });
}

/** Usable offers only (any catalog query). */
export function usableOffers(rows: any[]): any[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.filter(
    (r) =>
      r &&
      r.status !== "unshippable" &&
      Array.isArray(r.variants) &&
      r.variants.length > 0,
  );
}

async function loadOrDiscoverOffers(): Promise<any[]> {
  try {
    const existing = await part3Fetch("/api/part3/offers");
    if (
      existing?.status === "ready" &&
      Array.isArray(existing.rows) &&
      existing.rows.length
    ) {
      return existing.rows;
    }
  } catch {
    /* discover */
  }

  await part3Fetch("/api/part3/discover", { method: "POST", body: "{}" });
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      const snap = await part3Fetch("/api/part3/offers");
      if (snap.status === "discovering") continue;
      if (snap.status === "error") {
        throw new Error(snap.message || "discover failed");
      }
      if (snap.status === "ready") return snap.rows || [];
    } catch (e: any) {
      console.warn("[part3Client] offers poll", e?.message || e);
    }
  }
  return [];
}

/** Discover with custom queries (replaces offer list). */
export async function discoverQueries(queries: string[]): Promise<any[]> {
  const q = queries.map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (!q.length) return [];
  await part3Fetch("/api/part3/discover", {
    method: "POST",
    body: JSON.stringify({ queries: q }),
  });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    try {
      const snap = await part3Fetch("/api/part3/offers");
      if (snap.status === "discovering") continue;
      if (snap.status === "error") {
        throw new Error(snap.message || "discover failed");
      }
      if (snap.status === "ready") return snap.rows || [];
    } catch (e: any) {
      if (i > 2) console.warn("[part3Client] custom discover poll", e?.message || e);
    }
  }
  return [];
}

/** Quote + sandbox pay for a ranked candidate list (first success wins). */
export async function quoteAndPayOffers(
  candidates: any[],
  onStep?: (msg: string) => Promise<void>,
  quantity = 1,
): Promise<RestockResult> {
  const steps: string[] = [];
  const step = async (msg: string) => {
    steps.push(msg);
    if (onStep) await onStep(msg);
  };
  const quoteErrors: string[] = [];
  const qty = Math.max(1, Math.min(5, Number(quantity) || 1));

  for (const candidate of candidates.slice(0, 6)) {
    try {
      const quoteRes = await part3Fetch("/api/part3/quote", {
        method: "POST",
        body: JSON.stringify({
          offerId: candidate.id,
          quantity: qty,
        }),
      });
      if (!(quoteRes.ok && quoteRes.quote?.ok)) {
        const errMsg = String(
          quoteRes.error || quoteRes.quote?.rawError || "quote failed",
        );
        quoteErrors.push(`${candidate.merchant}: ${errMsg.slice(0, 60)}`);
        continue;
      }
      const offer = quoteRes.offer || candidate;
      const quote = quoteRes.quote;
      const checkoutSessionId =
        quote.checkoutSessionId || offer.checkoutSessionId;
      const total = quote.quoteTotal || offer.quoteTotal;
      const merchant = quote.merchant || offer.merchant;
      const title = offer.title || "Item";

      if (!checkoutSessionId || !total) {
        quoteErrors.push(`${merchant}: missing checkout`);
        continue;
      }

      let payRes: any;
      try {
        payRes = await part3Fetch("/api/part3/pay", {
          method: "POST",
          body: JSON.stringify({
            checkoutSessionId,
            merchant,
            total,
            currency: quote.currency || offer.currency || "USD",
            title,
            quantity: qty,
            confirm: true,
            mode: "sandbox",
          }),
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        quoteErrors.push(`${merchant}: ${msg.slice(0, 80)}`);
        if (/already exists|external_order_ref/i.test(msg)) continue;
        throw e;
      }

      const order = payRes.order || {};
      const paymentUrl = order.paymentUrl;
      if (!paymentUrl) {
        quoteErrors.push(`${merchant}: no pay link`);
        continue;
      }

      const snap = readLiveLocSnapshot();
      const locNote = snap.isDemo
        ? undefined
        : [
            `Deliver to: ${snap.shopName}`,
            `Address: ${snap.address}`,
            snap.when ? `ETA: ${snap.when}` : null,
          ]
            .filter(Boolean)
            .join("\n");

      const message = msgPayLink({
        title,
        merchant: String(merchant),
        total: String(total),
        paymentUrl,
        quantity: qty,
        locNote,
      });
      await step(message);

      savePendingQuote({
        offerId: String(candidate.id || offer.id),
        title: String(title),
        merchant: String(merchant),
        quantity: qty,
        quoteTotal: String(total),
        paymentUrl: String(paymentUrl),
        orderId: order.id ? String(order.id) : undefined,
        checkoutSessionId: String(checkoutSessionId),
        at: new Date().toISOString(),
      });

      return {
        ok: true,
        title,
        merchant,
        quoteTotal: total,
        paymentUrl,
        orderId: order.id,
        payMode: order.payMode || "sandbox",
        message,
        steps,
      };
    } catch (e: any) {
      quoteErrors.push(
        `${candidate.merchant}: ${(e?.message || String(e)).slice(0, 60)}`,
      );
    }
  }

  const message = msgFail(quoteErrors.slice(0, 2).join(" · ") || "quote failed");
  await step(message);
  return { ok: false, error: "quote_exhausted", message, steps };
}

/** Re-quote the open item at a new quantity (agentic qty change). */
export async function requotePending(
  quantity: number,
  onStep?: (msg: string) => Promise<void>,
): Promise<RestockResult> {
  const pending = loadPendingQuote();
  if (!pending) {
    const message = msgFail(
      "No open quote to change. Pick an option first, then say “qty 2”.",
    );
    await onStep?.(message);
    return { ok: false, error: "no_pending_quote", message, steps: [message] };
  }
  const qty = Math.max(1, Math.min(5, quantity));
  await onStep?.(
    `Got it — re-quoting ${pending.title} at qty ${qty}…`,
  );

  let candidate: any = null;
  try {
    const snap = await part3Fetch("/api/part3/offers");
    candidate = (snap.rows || []).find(
      (r: any) => String(r.id) === String(pending.offerId),
    );
  } catch {
    /* fall through */
  }
  if (!candidate) {
    candidate = {
      id: pending.offerId,
      title: pending.title,
      merchant: pending.merchant,
      variants: [{ variantId: "x" }],
    };
  }

  return quoteAndPayOffers([candidate], onStep, qty);
}

/**
 * Restock path with human-readable progress via onStep.
 * Always (re)discovers milk & eggs — ignores leftover coffee/chocolate catalog searches.
 */
export async function runRestockApprove(
  onStep?: (msg: string) => Promise<void>,
): Promise<RestockResult> {
  const steps: string[] = [];
  const step = async (msg: string) => {
    steps.push(msg);
    if (onStep) await onStep(msg);
  };

  try {
    try {
      await part3Fetch("/health");
    } catch {
      const message = msgFail("Part 3 is offline.");
      await step(message);
      return { ok: false, error: "part3_offline", message, steps };
    }

    const focus = readFridgeFocus();
    const queries =
      focus === "milk"
        ? ["whole milk", "gallon milk"]
        : focus === "eggs"
          ? ["large eggs", "dozen eggs"]
          : ["whole milk", "large eggs", "dozen eggs"];

    await step(
      focus === "milk"
        ? "Searching milk…"
        : focus === "eggs"
          ? "Searching eggs…"
          : "Searching milk & eggs…",
    );

    const rows = await discoverQueries(queries);
    if (!rows.length) {
      const message = msgFail("No options found.");
      await step(message);
      return { ok: false, error: "no_offers", message, steps };
    }

    const ranked = rankOffers(rows, focus);
    if (!ranked.length) {
      const message = msgFail("Nothing shippable right now.");
      await step(message);
      return { ok: false, error: "no_quotable", message, steps };
    }

    const pick = ranked[0];
    const optionLines = ranked.slice(0, 4).map(offerLine);
    const why = pickWhy(pick, ranked);
    await step(
      msgOptionsFound(
        optionLines,
        String(pick.title || "Item"),
        String(pick.merchant || ""),
        why,
      ),
    );

    const paid = await quoteAndPayOffers(ranked, onStep);
    steps.push(...paid.steps.filter((s) => !steps.includes(s)));
    return { ...paid, steps };
  } catch (e: any) {
    console.error("[part3Client] runRestockApprove", e);
    const message = msgFail(e?.message || String(e));
    await step(message);
    return { ok: false, error: e?.message || String(e), message, steps };
  }
}

export async function part3StatusLine(): Promise<string> {
  try {
    const snap = await part3Fetch("/api/part3/offers");
    const n = (snap.rows || []).length;
    if (n > 0) {
      const top = rankOffers(snap.rows).slice(0, 3).map(offerLine);
      return (
        `${n} options ready` +
        (top.length ? `\n${top.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "")
      );
    }
    return "No offers yet — reply APPROVE to discover.";
  } catch {
    return "Part 3 offline.";
  }
}
