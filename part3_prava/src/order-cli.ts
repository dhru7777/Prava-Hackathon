/**
 * CLI: quote (and optionally pay) a variant.
 *
 *   npm run order -- --variant gid://... --merchant beprepared.com --qty 1
 *   npm run order -- --variant gid://... --merchant beprepared.com --qty 1 --pay
 *   npm run order -- --variant ... --merchant ... --pay --sandbox   # CARD-03
 *   npm run order -- --variant ... --merchant ... --pay --live      # real Visa
 */

import { quoteVariant } from "./quote.js";
import { startPayAsync } from "./pay.js";
import { getOrder } from "./store/offers.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const variant = arg("--variant");
  const merchant = arg("--merchant");
  const qty = Number(arg("--qty") || "1");
  const doPay = has("--pay");
  const mode = has("--live") ? "live" : has("--sandbox") ? "sandbox" : undefined;

  if (!variant || !merchant) {
    console.log(`Usage:
  npm run order -- --variant <variantId> --merchant <domain> [--qty 1] [--pay] [--sandbox|--live]

  --sandbox  REST sk_test_ → sandbox.collect (CARD-03: …2200 / CVV 93 / 12/30)
  --live     CLI → collect.prava.space (real US/CA/SEA Visa only)
`);
    process.exit(1);
  }

  console.log(`Quoting ${variant} @ ${merchant} qty=${qty}…`);
  const q = quoteVariant({
    variantId: variant,
    merchant,
    quantity: qty,
  });

  console.log(JSON.stringify(q, null, 2));
  if (!q.ok) process.exit(1);

  if (!doPay) {
    console.log("\nQuote only. Re-run with --pay --sandbox (CARD-03) or --pay --live (real Visa).");
    return;
  }

  console.log(
    `\nStarting ${mode || "auto"} pay for ${q.quoteTotal} (approve passkey in browser)…`,
  );
  const order = await startPayAsync({
    checkoutSessionId: q.checkoutSessionId || "",
    merchant,
    total: q.quoteTotal || "",
    currency: q.currency,
    title: `Order qty ${qty} from ${merchant}`,
    quantity: qty,
    confirm: true,
    mode,
  });
  console.log("payMode:", order.payMode);
  console.log("payment URL:", order.paymentUrl);
  console.log("order id:", order.id);
  if (order.payMode === "sandbox") {
    console.log("CARD-03: 4622943123232200 / CVV 93 / exp 12/30 / OTP 456789");
  }

  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const cur = getOrder(order.id);
    console.log("status:", cur?.status, cur?.error || "");
    if (cur?.status === "paid" || cur?.status === "failed") break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
