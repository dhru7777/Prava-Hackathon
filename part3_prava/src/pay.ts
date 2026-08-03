/**
 * Prava pay:
 *   - sandbox (default when sk_test_ set): REST POST /v1/sessions → sandbox.collect (CARD-03)
 *   - live: CLI sessions create → collect.prava.space (real US/CA/SEA Visa only)
 */

import { createHash } from "node:crypto";
import { moneyAmountOnly, parseJsonLoose, prava } from "./prava/cli.js";
import {
  createSandboxSession,
  pollSandboxCredentials,
  sandboxConfigured,
} from "./prava/sandbox.js";
import { appendOrder, updateOrder } from "./store/offers.js";
import type { OrderRecord, PayMode } from "./types.js";

function orderId(): string {
  return "ord_" + createHash("sha1").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 10);
}

function parseSessionCreate(stdout: string): { sessionId: string; paymentUrl: string } {
  const urlMatch =
    stdout.match(/https:\/\/(?:pay|collect)\.prava\.space[^\s]*/) ||
    stdout.match(/https:\/\/[^\s]*prava\.space[^\s]*/);
  const idMatch =
    stdout.match(/Session ID:\s*(ses_[a-zA-Z0-9]+)/i) ||
    stdout.match(/\b(ses_[a-zA-Z0-9]+)\b/);
  let sessionId = idMatch?.[1] || "";
  let paymentUrl = urlMatch?.[0] || "";
  try {
    const j = parseJsonLoose(stdout) as any;
    sessionId = String(j.session_id || j.sessionId || j.id || sessionId);
    paymentUrl = String(j.payment_url || j.paymentUrl || j.url || paymentUrl);
  } catch {
    /* text mode */
  }
  if (!sessionId) throw new Error("Could not parse payment session id from CLI");
  if (!paymentUrl) {
    paymentUrl = `https://collect.prava.space?session=${sessionId}`;
  }
  return { sessionId, paymentUrl };
}

function parsePollCredentials(stdout: string): {
  token: string;
  cryptogram: string;
  expiryMonth: string;
  expiryYear: string;
} {
  try {
    const j = parseJsonLoose(stdout) as any;
    const token = String(j.token || j.network_token || j.card_number || j.pan || "");
    const cryptogram = String(j.cryptogram || j.dynamic_cvv || j.cvv || "");
    const expiryMonth = String(j.expiry_month || j.expiryMonth || j.exp_month || "");
    const expiryYear = String(j.expiry_year || j.expiryYear || j.exp_year || "");
    if (token && cryptogram && expiryMonth && expiryYear) {
      return { token, cryptogram, expiryMonth, expiryYear };
    }
  } catch {
    /* fall through */
  }
  const token =
    stdout.match(/Token[:\s]+([0-9]{13,19})/i)?.[1] ||
    stdout.match(/\b([0-9]{16})\b/)?.[1] ||
    "";
  const cryptogram =
    stdout.match(/Cryptogram[:\s]+([A-Za-z0-9+/=]+)/i)?.[1] ||
    stdout.match(/CVV[:\s]+([A-Za-z0-9+/=]+)/i)?.[1] ||
    "";
  const expiryMonth =
    stdout.match(/Expiry[^0-9]*([0-9]{2})\s*[\/\-]/i)?.[1] ||
    stdout.match(/Month[:\s]+([0-9]{2})/i)?.[1] ||
    "";
  const expiryYear =
    stdout.match(/Expiry[^0-9]*[0-9]{2}\s*[\/\-]\s*([0-9]{2,4})/i)?.[1] ||
    stdout.match(/Year[:\s]+([0-9]{2,4})/i)?.[1] ||
    "";
  if (!token || !cryptogram) {
    throw new Error("Could not parse tokenized credentials from sessions poll");
  }
  return {
    token,
    cryptogram,
    expiryMonth: expiryMonth.padStart(2, "0"),
    expiryYear: expiryYear.length === 2 ? `20${expiryYear}` : expiryYear,
  };
}

export type PayRequest = {
  checkoutSessionId: string;
  merchant: string;
  total: string;
  currency?: string;
  title: string;
  quantity: number;
  confirm: boolean;
  /** sandbox = CARD-03 / sk_test_; live = real Visa via CLI */
  mode?: PayMode;
};

export function resolvePayMode(requested?: PayMode | string): PayMode {
  const envDefault = (process.env.PRAVA_PAY_MODE || "").toLowerCase();
  const r = String(requested || envDefault || "").toLowerCase();
  if (r === "live" || r === "cli" || r === "production") return "live";
  if (r === "sandbox" || r === "test") return "sandbox";
  // Prefer sandbox when sk_test_ is configured (hackathon CARD-03 path)
  if (sandboxConfigured()) return "sandbox";
  return "live";
}

export function startPay(req: PayRequest): OrderRecord {
  if (!req.confirm) {
    throw new Error("Pay requires confirm: true (explicit user approval of total)");
  }
  if (!req.checkoutSessionId) {
    throw new Error("checkoutSessionId required — run quote first");
  }

  // Sync helper — live CLI only. Prefer startPayAsync for sandbox|live.
  const amount = moneyAmountOnly(req.total);
  const currency = req.currency || "USD";
  const merchantUrl = req.merchant.startsWith("http")
    ? req.merchant
    : `https://${req.merchant}`;
  const merchantName = req.merchant.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const create = prava([
    "sessions",
    "create",
    "--total-amount",
    amount,
    "--currency",
    currency,
    "--merchant-name",
    merchantName,
    "--merchant-url",
    merchantUrl,
    "--merchant-country",
    "US",
    "--product",
    JSON.stringify({
      description: req.title,
      unit_price: amount,
      quantity: 1,
    }),
  ]);

  if (!create.ok) {
    throw new Error(create.stderr || create.stdout || "sessions create failed");
  }

  const { sessionId, paymentUrl } = parseSessionCreate(create.stdout + "\n" + create.stderr);
  const order: OrderRecord = {
    id: orderId(),
    at: new Date().toISOString(),
    title: req.title,
    merchant: merchantName,
    quantity: req.quantity,
    total: `$${amount} ${currency}`,
    currency,
    checkoutSessionId: req.checkoutSessionId,
    paymentSessionId: sessionId,
    paymentUrl,
    status: "awaiting_passkey",
    payMode: "live",
  };
  appendOrder(order);
  void completeLivePayInBackground(order);
  return order;
}

/** Preferred entry: supports sandbox REST + live CLI. */
export async function startPayAsync(req: PayRequest): Promise<OrderRecord> {
  if (!req.confirm) {
    throw new Error("Pay requires confirm: true (explicit user approval of total)");
  }
  if (!req.checkoutSessionId) {
    throw new Error("checkoutSessionId required — run quote first");
  }

  const mode = resolvePayMode(req.mode);
  const amount = moneyAmountOnly(req.total);
  const currency = req.currency || "USD";
  const merchantUrl = req.merchant.startsWith("http")
    ? req.merchant
    : `https://${req.merchant}`;
  const merchantName = req.merchant.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (mode === "sandbox") {
    if (!sandboxConfigured()) {
      throw new Error(
        "Sandbox pay needs PRAVA_SECRET_KEY=sk_test_… in part3_prava/.env (CLI is production-only per Prava).",
      );
    }
    const session = await createSandboxSession({
      totalAmount: amount,
      currency,
      merchantName,
      merchantUrl,
      productDescription: req.title,
      quantity: req.quantity,
      // Unique per pay attempt — reusing checkoutSessionId hits "already exists"
      // and collect links become "Session Already Used" after one open.
      externalOrderRef: `${req.checkoutSessionId}_${Date.now()}`,
    });
    const order: OrderRecord = {
      id: orderId(),
      at: new Date().toISOString(),
      title: req.title,
      merchant: merchantName,
      quantity: req.quantity,
      total: `$${amount} ${currency}`,
      currency,
      checkoutSessionId: req.checkoutSessionId,
      paymentSessionId: session.sessionId,
      paymentUrl: session.iframeUrl,
      status: "awaiting_passkey",
      payMode: "sandbox",
      orderId: session.orderId,
    };
    appendOrder(order);
    void completeSandboxPayInBackground(order);
    return order;
  }

  // live CLI path
  return startPay({ ...req, mode: "live" });
}

async function completeSandboxPayInBackground(order: OrderRecord): Promise<void> {
  try {
    await Promise.resolve();
    updateOrder(order.id, { status: "polling" });
    const creds = await pollSandboxCredentials(order.paymentSessionId!, {
      timeoutMs: 600_000,
      intervalMs: 4000,
    });
    updateOrder(order.id, {
      status: "checking_out",
      orderId: creds.orderId || order.orderId,
    });

    // Sandbox token ≠ production CLI shop checkout (Shubham). Only try if explicitly enabled.
    const tryCli = process.env.SANDBOX_TRY_CLI_CHECKOUT === "1";
    if (!tryCli) {
      updateOrder(order.id, {
        status: "paid",
        orderId: creds.orderId || order.orderId || `sandbox_ok_${order.paymentSessionId}`,
      });
      await notifyPart2Paid(order);
      return;
    }

    const checkout = prava([
      "shop",
      "checkout",
      "--checkout-session-id",
      order.checkoutSessionId,
      "--token",
      creds.token,
      "--cryptogram",
      creds.cryptogram,
      "--expiry-month",
      creds.expiryMonth,
      "--expiry-year",
      creds.expiryYear,
      "--yes",
    ]);
    if (!checkout.ok) {
      updateOrder(order.id, {
        status: "failed",
        error:
          "Sandbox tokenize OK, but CLI shop checkout failed (expected — CLI is production). Set SANDBOX_TRY_CLI_CHECKOUT=0 to treat tokenize as success. " +
          (checkout.stderr || checkout.stdout || "").slice(0, 300),
      });
      return;
    }
    const orderMatch =
      (checkout.stdout + checkout.stderr).match(/order[_-]?id[:\s]+([A-Za-z0-9_-]+)/i) ||
      (checkout.stdout + checkout.stderr).match(/\b(ord_[A-Za-z0-9]+)\b/);
    updateOrder(order.id, {
      status: "paid",
      orderId: orderMatch?.[1] || creds.orderId,
    });
    await notifyPart2Paid(order);
  } catch (e: any) {
    updateOrder(order.id, {
      status: "failed",
      error: e?.message || String(e),
    });
  }
}

async function notifyPart2Paid(order: OrderRecord): Promise<void> {
  const base = (process.env.PART2_API || "http://127.0.0.1:8787").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/agent/notify-paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        title: order.title,
        merchant: order.merchant,
        total: order.total,
        orderId: order.orderId || order.id,
        quantity: order.quantity,
      }),
    });
    const text = await res.text();
    console.log("[pay] notify Part2 paid →", res.status, text.slice(0, 120));
  } catch (e: any) {
    console.warn("[pay] notify Part2 failed", e?.message || e);
  }
}

async function completeLivePayInBackground(order: OrderRecord): Promise<void> {
  try {
    await Promise.resolve(); // let startPay return URL to caller first
    updateOrder(order.id, { status: "polling" });
    const poll = prava(
      ["sessions", "poll", "--session-id", order.paymentSessionId!],
      { timeoutMs: 600_000 },
    );
    if (!poll.ok) {
      const raw = poll.stderr || poll.stdout || "sessions poll failed";
      let error = raw;
      if (/Tokenization failed/i.test(raw)) {
        error =
          "Tokenization failed — live collect needs a real US/CA/SEA Visa (not CARD-03). For CARD-03 use mode:\"sandbox\" with sk_test_.";
      } else if (/Session expired|Waiting for card entry/i.test(raw)) {
        error =
          "Session timed out waiting for card entry. Open the Payment URL in Chrome/Safari and complete Pay Now within 10 minutes.";
      }
      updateOrder(order.id, { status: "failed", error: error.slice(0, 500) });
      return;
    }
    const creds = parsePollCredentials(poll.stdout + "\n" + poll.stderr);
    updateOrder(order.id, { status: "checking_out" });

    const checkout = prava([
      "shop",
      "checkout",
      "--checkout-session-id",
      order.checkoutSessionId,
      "--token",
      creds.token,
      "--cryptogram",
      creds.cryptogram,
      "--expiry-month",
      creds.expiryMonth,
      "--expiry-year",
      creds.expiryYear,
      "--yes",
    ]);

    if (!checkout.ok) {
      updateOrder(order.id, {
        status: "failed",
        error: checkout.stderr || checkout.stdout || "checkout failed",
      });
      return;
    }

    const orderMatch =
      (checkout.stdout + checkout.stderr).match(/order[_-]?id[:\s]+([A-Za-z0-9_-]+)/i) ||
      (checkout.stdout + checkout.stderr).match(/\b(ord_[A-Za-z0-9]+)\b/);
    updateOrder(order.id, {
      status: "paid",
      orderId: orderMatch?.[1],
    });
    await notifyPart2Paid(order);
  } catch (e: any) {
    updateOrder(order.id, {
      status: "failed",
      error: e?.message || String(e),
    });
  }
}
