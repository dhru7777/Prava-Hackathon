/**
 * Thin wrapper around `npx prava …`
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA = path.join(ROOT, "data");

export type CliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

export function prava(args: string[], opts?: { timeoutMs?: number }): CliResult {
  const r = spawnSync("npx", ["prava", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: opts?.timeoutMs ?? 120_000,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    code: r.status,
  };
}

export function parseJsonLoose(text: string): unknown {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  if (startObj === -1) start = startArr;
  else if (startArr === -1) start = startObj;
  else start = Math.min(startObj, startArr);
  if (start === -1) throw new Error("No JSON in CLI output");
  return JSON.parse(text.slice(start));
}

export function formatMoney(
  p: unknown,
  currency = "USD",
  opts?: { cents?: boolean },
): string {
  if (p == null) return "?";
  if (typeof p === "number") {
    const dollars =
      opts?.cents || (Number.isInteger(p) && p >= 100) ? p / 100 : p;
    return `$${dollars.toFixed(2)} ${currency}`;
  }
  if (typeof p === "string") {
    if (p.startsWith("$")) return `${p} ${currency}`.trim();
    const cleaned = p.replace(/[$,]/g, "").trim();
    const n = Number(cleaned);
    if (!Number.isNaN(n)) return `$${n.toFixed(2)} ${currency}`;
    return `${p} ${currency}`.trim();
  }
  if (typeof p === "object") {
    const o = p as Record<string, unknown>;
    const cur = String(o.currency || currency);
    if (o.priceAmount != null) {
      return formatMoney(o.priceAmount, cur, { cents: true });
    }
    const amount = o.amount ?? o.value ?? o.price;
    if (typeof amount === "number") {
      const asCents = o.amount_cents != null || o.currency_minor === true;
      return formatMoney(amount, cur, { cents: asCents || amount >= 100 });
    }
    if (typeof amount === "string") return formatMoney(amount, cur);
  }
  return "?";
}

/** Normalize a money string to "12.34" for sessions create. */
export function moneyAmountOnly(display: string): string {
  const m = String(display).replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]).toFixed(2) : "0.00";
}

export function ensureLinked(): { ok: boolean; statusText: string } {
  const st = prava(["status"]);
  const text = st.stdout || st.stderr || "(empty)";
  if (/No agent configured|not linked|not configured/i.test(text)) {
    return { ok: false, statusText: text };
  }
  if (/Status:\s*pending/i.test(text)) {
    return { ok: false, statusText: text };
  }
  return { ok: true, statusText: text };
}
