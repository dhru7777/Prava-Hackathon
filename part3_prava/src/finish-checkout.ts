/**
 * Finish E2E after user completes collect.prava.space passkey/card.
 * Usage: npx tsx src/finish-checkout.ts <sessionId> <checkoutSessionId>
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonLoose, ROOT } from "./prava/cli.js";

const sessionId = process.argv[2];
const checkoutId = process.argv[3];
if (!sessionId || !checkoutId) {
  console.error("Usage: finish-checkout <sessionId> <checkoutSessionId>");
  process.exit(1);
}

function prava(args: string[]) {
  return spawnSync("npx", ["prava", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 600_000,
  });
}

console.log("Polling session", sessionId, "…");
const poll = prava(["sessions", "poll", "--session-id", sessionId]);
const out = (poll.stdout || "") + "\n" + (poll.stderr || "");
fs.writeFileSync(path.join(ROOT, "data", "last_poll.txt"), out);
if (poll.status !== 0) {
  console.error("poll failed:\n", out);
  process.exit(1);
}
console.log(out);

let token = "";
let cryptogram = "";
let expiryMonth = "";
let expiryYear = "";
try {
  const j = parseJsonLoose(out) as any;
  token = String(j.token || j.network_token || j.card_number || "");
  cryptogram = String(j.cryptogram || j.dynamic_cvv || j.cvv || "");
  expiryMonth = String(j.expiry_month || j.expiryMonth || j.exp_month || "");
  expiryYear = String(j.expiry_year || j.expiryYear || j.exp_year || "");
} catch {
  /* text */
}
token = token || out.match(/Token[:\s]+([0-9]{13,19})/i)?.[1] || "";
cryptogram =
  cryptogram ||
  out.match(/Cryptogram[:\s]+([A-Za-z0-9+/=]+)/i)?.[1] ||
  "";
expiryMonth =
  expiryMonth ||
  out.match(/Expiry[^0-9]*([0-9]{2})\s*[\/\-]/i)?.[1] ||
  "";
expiryYear =
  expiryYear ||
  out.match(/Expiry[^0-9]*[0-9]{2}\s*[\/\-]\s*([0-9]{2,4})/i)?.[1] ||
  "";
if (expiryYear.length === 2) expiryYear = "20" + expiryYear;

if (!token || !cryptogram) {
  console.error("Could not parse token/cryptogram from poll output");
  process.exit(1);
}

console.log("Checking out…");
const checkout = prava([
  "shop",
  "checkout",
  "--checkout-session-id",
  checkoutId,
  "--token",
  token,
  "--cryptogram",
  cryptogram,
  "--expiry-month",
  expiryMonth.padStart(2, "0"),
  "--expiry-year",
  expiryYear,
  "--yes",
]);
const cout = (checkout.stdout || "") + "\n" + (checkout.stderr || "");
console.log(cout);
fs.appendFileSync(
  path.join(ROOT, "data", "orders.jsonl"),
  JSON.stringify({
    id: "ord_e2e_finish",
    at: new Date().toISOString(),
    checkoutSessionId: checkoutId,
    paymentSessionId: sessionId,
    status: checkout.status === 0 ? "paid" : "failed",
    raw: cout.slice(0, 500),
  }) + "\n",
);
process.exit(checkout.status === 0 ? 0 : 1);
