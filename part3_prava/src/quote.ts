/**
 * Quote a variant with quantity + optional address-id.
 * Retries next variants when merchandise id is stale.
 */

import { formatMoney, parseJsonLoose, prava } from "./prava/cli.js";
import type { QuoteResult, Variant } from "./types.js";

function extractError(stdout: string, stderr: string): string {
  const text = `${stderr}\n${stdout}`.trim();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/server error 502|retrying/i.test(l));
  const meaningful = lines.filter((l) => /request failed|error|cannot|must|does not exist|ship/i.test(l));
  return (meaningful.pop() || lines.pop() || "quote failed").slice(0, 320);
}

function parseShipping(q: Record<string, unknown>): string | null {
  const selected = q.selected_shipping as Record<string, unknown> | undefined;
  if (selected) {
    const title = selected.title ? String(selected.title) : "";
    const eta = selected.delivery_estimate
      ? String(selected.delivery_estimate)
      : "";
    const amt =
      selected.amount != null
        ? formatMoney(selected.amount, String(selected.currency || "USD"))
        : "";
    const parts = [title, eta, amt ? `ship ${amt}` : ""].filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (typeof q.delivery_estimate === "string" && q.delivery_estimate) {
    return q.delivery_estimate;
  }
  const shipping = q.shipping ?? (q.data as any)?.shipping;
  if (typeof shipping === "string") return shipping;
  if (shipping && typeof shipping === "object") {
    const s = shipping as Record<string, unknown>;
    const parts = [
      s.description,
      s.estimate,
      s.title,
      s.name,
      s.delivery_estimate,
      s.deliveryEstimate,
    ]
      .filter(Boolean)
      .map(String);
    if (parts.length) return parts.join(" · ");
  }
  if (Array.isArray(q.shipping_options) && (q.shipping_options as any[])[0]) {
    const o = (q.shipping_options as any[])[0];
    const bits = [o.title, o.delivery_estimate].filter(Boolean).map(String);
    return bits.join(" · ") || "shipping available";
  }
  return null;
}

function parseTotal(q: Record<string, unknown>): { display: string; currency: string } {
  const fp = q.final_price as Record<string, unknown> | undefined;
  if (fp?.amount != null) {
    const currency = String(fp.currency || "USD");
    return { display: formatMoney(fp.amount, currency), currency };
  }
  if (typeof q.final_price_cents === "number") {
    const currency = String(
      (q.price_breakdown as any)?.currency || q.currency || "USD",
    );
    return {
      display: formatMoney(q.final_price_cents, currency, { cents: true }),
      currency,
    };
  }
  const pb = q.price_breakdown as Record<string, unknown> | undefined;
  if (pb?.total_cents != null) {
    const currency = String(pb.currency || "USD");
    return {
      display: formatMoney(pb.total_cents, currency, { cents: true }),
      currency,
    };
  }
  const currency = String(
    q.currency ||
      (q.total as any)?.currency ||
      (q.data as any)?.currency ||
      "USD",
  );
  const candidates = [
    q.total,
    q.total_amount,
    q.amount,
    q.grand_total,
    (q.data as any)?.total,
    (q.totals as any)?.total,
    (q.totals as any)?.grand_total,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "number" || typeof c === "string" || typeof c === "object") {
      const display = formatMoney(c, currency, {
        cents: typeof c === "number" && Number.isInteger(c) && c >= 100,
      });
      if (display !== "?") return { display, currency };
    }
  }
  return { display: "?", currency };
}

function parseCheckoutSessionId(q: Record<string, unknown>): string | null {
  const id =
    q.checkout_session_id ||
    q.checkoutSessionId ||
    q.session_id ||
    (q.data as any)?.checkout_session_id ||
    (q.checkout_session as any)?.id;
  return id ? String(id) : null;
}

export function listShipToLabel(): string | null {
  const r = prava(["shop", "address", "list"]);
  const text = r.stdout || r.stderr || "";
  const m = text.match(/1\.\s+([^\n]+)/);
  if (m) return m[1].replace(/\s*\[default\]\s*/i, " ").trim();
  if (/No delivery addresses/i.test(text)) return null;
  return "address on file";
}

export function quoteVariant(opts: {
  variantId: string;
  merchant: string;
  quantity?: number;
  addressId?: string;
  retries?: number;
}): QuoteResult {
  const quantity = Math.max(1, Math.min(5, opts.quantity ?? 1));
  const args = [
    "shop",
    "quote",
    "--variant-id",
    opts.variantId,
    "--merchant",
    opts.merchant,
    "--quantity",
    String(quantity),
    "--retries",
    String(opts.retries ?? 2),
    "--yes",
    "--json",
  ];
  if (opts.addressId) {
    args.push("--address-id", opts.addressId);
  }

  const r = prava(args);
  const shipToLabel = listShipToLabel();

  if (!r.ok) {
    return {
      ok: false,
      variantId: opts.variantId,
      merchant: opts.merchant,
      quantity,
      quoteTotal: null,
      currency: "USD",
      deliveryEstimate: null,
      checkoutSessionId: null,
      shipToLabel,
      rawError: extractError(r.stdout, r.stderr),
    };
  }

  try {
    const q = parseJsonLoose(r.stdout) as Record<string, unknown>;
    const { display, currency } = parseTotal(q);
    const delivery = parseShipping(q);
    return {
      ok: true,
      variantId: opts.variantId,
      merchant: opts.merchant,
      quantity,
      quoteTotal: display,
      currency,
      deliveryEstimate: delivery || "shipping quoted",
      checkoutSessionId: parseCheckoutSessionId(q),
      shipToLabel,
    };
  } catch (e: any) {
    return {
      ok: false,
      variantId: opts.variantId,
      merchant: opts.merchant,
      quantity,
      quoteTotal: null,
      currency: "USD",
      deliveryEstimate: null,
      checkoutSessionId: null,
      shipToLabel,
      rawError: `quote parse: ${e.message}`,
    };
  }
}

/** Try variants in preference order until one quotes or all fail. */
export function quoteWithVariantFallback(opts: {
  variants: Variant[];
  merchant: string;
  quantity?: number;
  addressId?: string;
  preferVariantId?: string | null;
}): QuoteResult & { tried: string[] } {
  const tried: string[] = [];
  const ordered = [...opts.variants].filter((v) => v.variantId);
  ordered.sort((a, b) => {
    if (opts.preferVariantId) {
      if (a.variantId === opts.preferVariantId) return -1;
      if (b.variantId === opts.preferVariantId) return 1;
    }
    const ao = a.orderable === false ? 1 : 0;
    const bo = b.orderable === false ? 1 : 0;
    return ao - bo;
  });

  let last: QuoteResult | null = null;
  for (const v of ordered) {
    tried.push(v.variantId);
    const q = quoteVariant({
      variantId: v.variantId,
      merchant: opts.merchant,
      quantity: opts.quantity,
      addressId: opts.addressId,
    });
    last = q;
    if (q.ok) return { ...q, tried };
    // Retry next on stale merchandise / sign-in glitches for other variants
    if (
      /does not exist|merchandise|can't be shipped|cannot be shipped|shipped to your address/i.test(
        q.rawError || "",
      )
    ) {
      continue;
    }
    // For hard auth errors, still try one more variant then stop
    if (/sign in|must sign in/i.test(q.rawError || "") && tried.length >= 2) {
      break;
    }
  }

  return {
    ...(last || {
      ok: false,
      variantId: "",
      merchant: opts.merchant,
      quantity: opts.quantity ?? 1,
      quoteTotal: null,
      currency: "USD",
      deliveryEstimate: null,
      checkoutSessionId: null,
      shipToLabel: listShipToLabel(),
      rawError: "no variants to quote",
    }),
    tried,
  };
}
