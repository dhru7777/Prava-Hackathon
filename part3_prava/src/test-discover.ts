/**
 * Part 3 — Discovery smoke test for milk & eggs via Prava CLI.
 *
 * Run: npm run test:discover
 */

import { runDiscovery, printOfferTable } from "./discover.js";
import { ensureLinked } from "./prava/cli.js";
import { listShipToLabel } from "./quote.js";
import { saveOffers } from "./store/offers.js";

async function main() {
  console.log("Part 3 discoverability test (Prava CLI — MCP not required)");

  const linked = ensureLinked();
  console.log("\n=== Prava agent status ===");
  console.log(linked.statusText);
  if (!linked.ok) {
    console.log(`
❌ Prava agent is NOT linked yet.

  cd part3_prava
  npx prava setup --name "MilkWatch Part3"
  npx prava setup poll
`);
    process.exit(2);
  }

  console.log("ship-to:", listShipToLabel() || "(none)");

  const rows = await runDiscovery({ quantity: 1, log: true, skipQuote: false });
  printOfferTable(rows);

  const snap = saveOffers({
    at: new Date().toISOString(),
    shipToLabel: listShipToLabel(),
    status: "ready",
    rows,
    message: `${rows.length} offer(s)`,
  });
  console.log(`saved → data/offers.json (${snap.rows.length} rows)`);

  const live = rows.filter((r) => r.source === "prava" && r.productId);
  if (!live.length) {
    console.log("RESULT: Discovery returned 0 usable products.");
    process.exit(1);
  }
  const quoted = rows.filter((r) => r.status === "quoted").length;
  console.log(`RESULT: OK — ${live.length} product(s), ${quoted} quoted ✅`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
