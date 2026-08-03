/**
 * Milk/eggs discovery via Prava shop search → product → quote.
 */

import { createHash } from "node:crypto";
import { formatMoney, parseJsonLoose, prava } from "./prava/cli.js";
import { listShipToLabel, quoteWithVariantFallback } from "./quote.js";
import type { OfferRow, Variant } from "./types.js";

type SearchHit = {
  title?: string;
  name?: string;
  price?: string | number;
  currency?: string;
  merchant?: string;
  merchant_domain?: string;
  product_id?: string;
  productId?: string;
  __query?: string;
  [k: string]: unknown;
};

function asHits(raw: unknown): SearchHit[] {
  if (Array.isArray(raw)) return raw as SearchHit[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["results", "products", "items", "data"]) {
      if (Array.isArray(o[key])) return o[key] as SearchHit[];
    }
  }
  return [];
}

function hitTitle(h: SearchHit): string {
  return String(h.title || h.name || h.product_title || "Untitled");
}

function hitMerchant(h: SearchHit): string {
  return String(h.merchant || h.merchant_domain || h.domain || "unknown");
}

function hitProductId(h: SearchHit): string {
  return String(h.product_id || h.productId || h.id || "");
}

function hitPrice(h: SearchHit): string {
  return formatMoney(
    h.price ?? h.price_estimate ?? h.amount ?? h.priceAmount,
    String(h.currency || "USD"),
  );
}

function offerId(query: string, productId: string, merchant: string): string {
  return createHash("sha1")
    .update(`${query}|${productId}|${merchant}`)
    .digest("hex")
    .slice(0, 12);
}

export function searchQuery(query: string, limit = 5): SearchHit[] {
  const r = prava([
    "shop",
    "search",
    "--query",
    query,
    "--intent",
    `Restock ${query} for home inventory; prefer shippable grocery or pantry items`,
    "--ships-to",
    "US",
    "--limit",
    String(limit),
    "--json",
  ]);
  if (!r.ok) {
    console.log("search failed:", r.stderr || r.stdout);
    return [];
  }
  try {
    return asHits(parseJsonLoose(r.stdout));
  } catch (e: any) {
    console.log("search parse error:", e.message);
    return [];
  }
}

function loadVariants(productId: string, merchant: string): Variant[] {
  const args = ["shop", "product", "--product-id", productId, "--json"];
  if (merchant && merchant !== "unknown") args.push("--merchant", merchant);
  const prod = prava(args);
  if (!prod.ok) throw new Error(prod.stderr || prod.stdout || "product failed");

  const raw = parseJsonLoose(prod.stdout) as any;
  const product = raw.product || raw;
  const offers =
    raw.offers || product.variants || raw.variants || raw.data?.offers || [];
  if (!Array.isArray(offers)) return [];
  return offers.slice(0, 8).map((o: any) => ({
    variantId: String(o.variant_id || o.variantId || o.id || ""),
    title: String(o.label || o.title || o.name || o.option || "variant"),
    price: formatMoney(
      o.priceAmount != null ? o.priceAmount : o.price ?? o.amount,
      String(o.currency || "USD"),
      { cents: o.priceAmount != null },
    ),
    orderable: o.orderable ?? o.available ?? undefined,
  }));
}

export function enrichProduct(
  hit: SearchHit,
  opts?: { quantity?: number; skipQuote?: boolean },
): OfferRow {
  const query = String(hit.__query || "");
  const productId = hitProductId(hit);
  const merchant = hitMerchant(hit);
  const quantity = opts?.quantity ?? 1;

  const base: OfferRow = {
    id: offerId(query, productId, merchant),
    query,
    title: hitTitle(hit),
    merchant,
    productId,
    priceEstimate: hitPrice(hit),
    variants: [],
    selectedVariantId: null,
    quantity,
    deliveryEstimate: null,
    quoteTotal: null,
    currency: "USD",
    checkoutSessionId: null,
    shipToLabel: listShipToLabel(),
    status: "discovered",
    source: "prava",
  };

  if (!productId) {
    base.source = "error";
    base.status = "error";
    base.error = "missing product_id";
    return base;
  }

  try {
    base.variants = loadVariants(productId, merchant);
    if (base.variants[0]?.price) {
      base.priceEstimate = base.variants[0].price;
    }
  } catch (e: any) {
    base.source = "error";
    base.status = "error";
    base.error = e.message;
    return base;
  }

  if (opts?.skipQuote || !base.variants.length) return base;

  const q = quoteWithVariantFallback({
    variants: base.variants,
    merchant,
    quantity,
  });

  base.selectedVariantId = q.variantId || base.variants[0]?.variantId || null;
  base.shipToLabel = q.shipToLabel;
  base.currency = q.currency;

  if (q.ok) {
    base.quoteTotal = q.quoteTotal;
    base.deliveryEstimate = q.deliveryEstimate;
    base.checkoutSessionId = q.checkoutSessionId;
    base.status = "quoted";
  } else {
    base.error = q.rawError;
    base.deliveryEstimate = null;
    base.quoteTotal = null;
    if (/can't be shipped|cannot be shipped|shipped to your address/i.test(q.rawError || "")) {
      base.status = "unshippable";
    } else {
      base.status = "error";
    }
  }

  return base;
}

export async function runDiscovery(opts?: {
  quantity?: number;
  queries?: string[];
  perQuery?: number;
  log?: boolean;
  skipQuote?: boolean;
}): Promise<OfferRow[]> {
  const queries = opts?.queries ?? ["whole milk", "large eggs", "dozen eggs"];
  const perQuery = opts?.perQuery ?? 2;
  const quantity = opts?.quantity ?? 1;
  const log = opts?.log ?? true;
  const skipQuote = opts?.skipQuote ?? true;
  const rows: OfferRow[] = [];

  for (const q of queries) {
    if (log) console.log(`\n--- search: "${q}" ---`);
    const hits = searchQuery(q, Math.max(3, perQuery + 1));
    if (log) console.log(`hits: ${hits.length}`);
    for (const h of hits.slice(0, perQuery)) {
      h.__query = q;
      if (log) console.log(`enrich: ${hitTitle(h)} @ ${hitMerchant(h)}`);
      rows.push(enrichProduct(h, { quantity, skipQuote }));
    }
  }
  return rows;
}

export function printOfferTable(rows: OfferRow[]) {
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(" Discovery results — milk & eggs");
  console.log("════════════════════════════════════════════════════════════");
  if (!rows.length) {
    console.log("(no offers)");
    return;
  }
  for (const r of rows) {
    console.log(`\n[${r.query}] ${r.title}`);
    console.log(`  status:     ${r.status}`);
    console.log(`  merchant:   ${r.merchant}`);
    console.log(`  productId:  ${r.productId || "—"}`);
    console.log(`  estimate:   ${r.priceEstimate}`);
    console.log(`  qty:        ${r.quantity}`);
    if (r.variants.length) {
      console.log("  variants:");
      for (const v of r.variants) {
        console.log(
          `    - ${v.title} · ${v.price}` +
            (v.orderable === false ? " (not orderable)" : "") +
            (v.variantId ? ` · ${v.variantId}` : ""),
        );
      }
    }
    console.log(`  ship-to:    ${r.shipToLabel ?? "n/a"}`);
    console.log(`  delivery:   ${r.deliveryEstimate ?? "n/a"}`);
    console.log(`  quoteTotal: ${r.quoteTotal ?? "n/a"}`);
    if (r.checkoutSessionId) {
      console.log(`  checkout:   ${r.checkoutSessionId}`);
    }
    if (r.error) console.log(`  note:      ${r.error.slice(0, 200)}`);
  }
  console.log("\n════════════════════════════════════════════════════════════\n");
}
