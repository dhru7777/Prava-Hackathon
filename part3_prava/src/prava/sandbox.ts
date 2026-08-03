/**
 * Prava sandbox REST (CARD-03 / sk_test_).
 * CLI & MCP are production-only — Shubham 2026-08-01.
 */

import "dotenv/config";

export const SANDBOX_API_BASE = (
  process.env.PRAVA_SANDBOX_API_BASE || "https://sandbox.api.prava.space"
).replace(/\/$/, "");

export function sandboxSecretKey(): string {
  return (
    process.env.PRAVA_SECRET_KEY ||
    process.env.MERCHANT_SECRET_KEY ||
    process.env.PRAVA_SK_TEST ||
    ""
  ).trim();
}

export function sandboxConfigured(): boolean {
  const k = sandboxSecretKey();
  if (!k.startsWith("sk_test_")) return false;
  if (/REPLACE|YOUR_|xxx|placeholder/i.test(k)) return false;
  return k.length > 20;
}

export type SandboxSession = {
  sessionId: string;
  sessionToken?: string;
  iframeUrl: string;
  orderId?: string;
  expiresAt?: string;
  raw: unknown;
};

export type SandboxCredentials = {
  token: string;
  cryptogram: string;
  expiryMonth: string;
  expiryYear: string;
  orderId?: string;
  status: string;
};

async function sandboxFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = sandboxSecretKey();
  if (!key.startsWith("sk_test_") || /REPLACE|YOUR_|xxx|placeholder/i.test(key) || key.length <= 20) {
    throw new Error(
      "Sandbox pay needs PRAVA_SECRET_KEY=sk_test_… in part3_prava/.env (CLI is production-only)",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body) headers["Content-Type"] = "application/json";
  return fetch(`${SANDBOX_API_BASE}${path}`, { ...init, headers });
}

export async function createSandboxSession(input: {
  totalAmount: string;
  currency: string;
  merchantName: string;
  merchantUrl: string;
  productDescription: string;
  quantity?: number;
  externalOrderRef?: string;
}): Promise<SandboxSession> {
  const userId =
    process.env.PRAVA_SANDBOX_USER_ID?.trim() || "milkwatch_sevenarc";
  const userEmail =
    process.env.PRAVA_SANDBOX_USER_EMAIL?.trim() || "dheerajmaske2001@gmail.com";

  const body = {
    user_id: userId,
    user_email: userEmail,
    user_country_code_iso2: "US",
    total_amount: input.totalAmount,
    currency: input.currency,
    description: input.productDescription,
    external_order_ref: input.externalOrderRef,
    purchase_context: [
      {
        merchant_details: {
          name: input.merchantName,
          url: input.merchantUrl,
          country_code_iso2: "US",
          category_code: "5411",
          category: "Grocery",
        },
        product_details: [
          {
            description: input.productDescription.slice(0, 200),
            unit_price: input.totalAmount,
            quantity: input.quantity ?? 1,
          },
        ],
        effective_until_minutes: 15,
      },
    ],
  };

  const res = await sandboxFetch("/v1/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      text.slice(0, 400) ||
      `sandbox sessions create HTTP ${res.status}`;
    throw new Error(msg);
  }

  const sessionId = String(json.session_id || json.sessionId || json.id || "");
  let iframeUrl = String(json.iframe_url || json.iframeUrl || json.payment_url || "");
  if (!sessionId) throw new Error("sandbox create: missing session_id");
  if (!iframeUrl) {
    iframeUrl = `https://sandbox.collect.prava.space?session=${sessionId}`;
  }
  return {
    sessionId,
    sessionToken: json.session_token ? String(json.session_token) : undefined,
    iframeUrl,
    orderId: json.order_id ? String(json.order_id) : undefined,
    expiresAt: json.expires_at ? String(json.expires_at) : undefined,
    raw: json,
  };
}

function extractCreds(json: any): SandboxCredentials | null {
  const status = String(json.status || "");
  const txns = Array.isArray(json.transactions) ? json.transactions : [];
  for (const txn of txns) {
    const items = Array.isArray(txn?.line_items) ? txn.line_items : [];
    for (const li of items) {
      const token = String(li?.token || "");
      const cryptogram = String(li?.dynamic_cvv || li?.cryptogram || "");
      const expiryMonth = String(li?.expiry_month || li?.expiryMonth || "");
      let expiryYear = String(li?.expiry_year || li?.expiryYear || "");
      if (token && cryptogram && expiryMonth && expiryYear) {
        if (expiryYear.length === 2) expiryYear = `20${expiryYear}`;
        return {
          token,
          cryptogram,
          expiryMonth: expiryMonth.padStart(2, "0"),
          expiryYear,
          orderId: json.order_id ? String(json.order_id) : undefined,
          status,
        };
      }
    }
  }
  return null;
}

export async function getSandboxPaymentResult(sessionId: string): Promise<{
  status: string;
  creds: SandboxCredentials | null;
  error?: string;
  raw: unknown;
}> {
  const res = await sandboxFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/payment-result`);
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* keep */
  }
  if (!res.ok) {
    return {
      status: "error",
      creds: null,
      error: json?.error?.message || text.slice(0, 400) || `HTTP ${res.status}`,
      raw: json,
    };
  }
  const status = String(json.status || "pending");
  const creds = extractCreds(json);
  let error: string | undefined;
  if (status === "failed") {
    const txnErr = json.transactions?.[0]?.error;
    error =
      (txnErr && `${txnErr.code || ""} ${txnErr.message || ""}`.trim()) ||
      json?.error?.message ||
      "sandbox payment failed";
  }
  return { status, creds, error, raw: json };
}

export async function pollSandboxCredentials(
  sessionId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<SandboxCredentials> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const intervalMs = opts?.intervalMs ?? 4000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await getSandboxPaymentResult(sessionId);
    if (r.creds) return r.creds;
    if (r.status === "failed" || r.status === "error") {
      throw new Error(r.error || "sandbox payment failed");
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(
    "Sandbox session timed out waiting for card/passkey. Open sandbox.collect URL in Chrome/Safari; use CARD-03 (…2200 / CVV 93 / 12/30), OTP 456789.",
  );
}
