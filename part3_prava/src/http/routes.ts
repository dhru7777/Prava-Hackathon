import { Router } from "express";
import { runDiscovery } from "../discover.js";
import { resolvePayMode, startPayAsync } from "../pay.js";
import { ensureLinked } from "../prava/cli.js";
import { sandboxConfigured } from "../prava/sandbox.js";
import { quoteWithVariantFallback, listShipToLabel } from "../quote.js";
import {
  getOrder,
  listOrders,
  loadOffers,
  saveOffers,
  setDiscovering,
  updateOffer,
} from "../store/offers.js";

let discovering = false;

export function part3Routes(): Router {
  const r = Router();

  r.get("/part3/offers", (_req, res) => {
    res.json(loadOffers());
  });

  r.post("/part3/reset", (_req, res) => {
    const snap = loadOffers();
    const rows = (snap.rows || []).map((r) => ({
      ...r,
      status: "discovered" as const,
      error: undefined,
      deliveryEstimate: null,
      quoteTotal: null,
      checkoutSessionId: null,
    }));
    const next = saveOffers({
      ...snap,
      at: new Date().toISOString(),
      status: "ready",
      rows,
      message: "Cleared quote errors — wait if Prava said too many checkouts, then Quote ONE item",
      shipToLabel: listShipToLabel(),
    });
    res.json(next);
  });

  r.get("/part3/orders", (_req, res) => {
    res.json({ orders: listOrders(30) });
  });

  r.get("/part3/orders/:id", (req, res) => {
    const o = getOrder(req.params.id);
    if (!o) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    res.json(o);
  });

  r.post("/part3/discover", async (req, res) => {
    if (discovering) {
      res.status(409).json({ error: "discovery already running", ...loadOffers() });
      return;
    }
    const linked = ensureLinked();
    if (!linked.ok) {
      res.status(503).json({
        error: "Prava agent not linked",
        status: linked.statusText,
      });
      return;
    }

    const body = req.body || {};
    const rawQueries = body.queries ?? body.query;
    let queries: string[] | undefined;
    if (typeof rawQueries === "string" && rawQueries.trim()) {
      queries = [rawQueries.trim()];
    } else if (Array.isArray(rawQueries)) {
      queries = rawQueries
        .map((q: unknown) => String(q || "").trim())
        .filter(Boolean)
        .slice(0, 5);
    }
    if (queries && !queries.length) queries = undefined;

    discovering = true;
    setDiscovering();
    res.json({
      ok: true,
      started: true,
      queries: queries || ["whole milk", "large eggs", "dozen eggs"],
      ...loadOffers(),
    });

    try {
      // Search/product only — do NOT auto-quote (opens checkout sessions; Prava rate-limits them)
      const rows = await runDiscovery({
        quantity: 1,
        log: true,
        skipQuote: true,
        queries,
        perQuery: queries ? 4 : 2,
      });
      saveOffers({
        at: new Date().toISOString(),
        shipToLabel: listShipToLabel(),
        status: "ready",
        rows,
        message: queries
          ? `${rows.length} offer(s) for: ${queries.join(", ")}`
          : `${rows.length} offer(s) — quote one at a time`,
      });
    } catch (e: any) {
      saveOffers({
        ...loadOffers(),
        at: new Date().toISOString(),
        status: "error",
        message: e?.message || String(e),
      });
    } finally {
      discovering = false;
    }
  });

  r.post("/part3/quote", (req, res) => {
    const {
      offerId,
      variantId,
      merchant,
      quantity = 1,
      addressId,
    } = req.body || {};

    const snap = loadOffers();
    let offer = offerId ? snap.rows.find((o) => o.id === offerId) : undefined;

    const mid = String(merchant || offer?.merchant || "");
    const qty = Math.max(1, Math.min(5, Number(quantity) || 1));

    if (!mid) {
      res.status(400).json({ error: "merchant required" });
      return;
    }

    const variants =
      offer?.variants?.length
        ? offer.variants
        : variantId
          ? [{ variantId: String(variantId), title: "variant", price: "?" }]
          : [];

    if (!variants.length) {
      res.status(400).json({ error: "variantId or offerId with variants required" });
      return;
    }

    const q = quoteWithVariantFallback({
      variants,
      merchant: mid,
      quantity: qty,
      addressId: addressId ? String(addressId) : undefined,
      preferVariantId: variantId ? String(variantId) : offer?.selectedVariantId,
    });

    if (offer) {
      offer = updateOffer(offer.id, {
        quantity: qty,
        selectedVariantId: q.variantId || offer.selectedVariantId,
        quoteTotal: q.quoteTotal,
        deliveryEstimate: q.deliveryEstimate,
        checkoutSessionId: q.checkoutSessionId,
        currency: q.currency,
        shipToLabel: q.shipToLabel,
        status: q.ok
          ? "quoted"
          : /shipped to your address|can't be shipped|cannot be shipped/i.test(
                q.rawError || "",
              )
            ? "unshippable"
            : "error",
        error: q.ok ? undefined : q.rawError,
      }) || offer;
    }

    if (!q.ok) {
      res.status(422).json({ ok: false, error: q.rawError, quote: q, offer });
      return;
    }
    res.json({ ok: true, quote: q, offer });
  });

  r.get("/part3/pay-config", (_req, res) => {
    const sandbox = sandboxConfigured();
    const defaultMode = resolvePayMode();
    res.json({
      sandboxConfigured: sandbox,
      defaultMode,
      hint: sandbox
        ? "Pay defaults to sandbox (CARD-03 on sandbox.collect). Pass mode:\"live\" for real Visa via CLI."
        : "Add PRAVA_SECRET_KEY=sk_test_… to part3_prava/.env for CARD-03 sandbox pay. Without it, pay uses live CLI (real Visa only).",
      card03:
        "4622943123232200 / CVV 93 / exp 12/30 / OTP 456789 (sandbox only)",
    });
  });

  r.post("/part3/pay", async (req, res) => {
    try {
      const body = req.body || {};
      const order = await startPayAsync({
        checkoutSessionId: String(body.checkoutSessionId || ""),
        merchant: String(body.merchant || ""),
        total: String(body.total || body.quoteTotal || ""),
        currency: body.currency ? String(body.currency) : "USD",
        title: String(body.title || "Grocery restock"),
        quantity: Number(body.quantity) || 1,
        confirm: Boolean(body.confirm),
        mode: body.mode,
      });
      res.json({ ok: true, order, payMode: order.payMode });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || String(e) });
    }
  });

  return r;
}
