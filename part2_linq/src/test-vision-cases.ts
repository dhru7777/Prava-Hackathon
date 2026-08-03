/**
 * Run vision fixtures (full / half / empty) → inventory → agent camera status.
 *
 *   npm run test:vision-cases
 *
 * By default DRY RUN: real OpenAI/agent text is written to data/chats.csv
 * and shown on /chats.html, but Linq iMessage is NOT sent.
 *
 * Live iMessage: AGENT_DRY_RUN=false and omit dryRun, or Part1 camera push
 * with LINQ configured (same vision-snapshot path, dryRun false).
 *
 * Watch: http://127.0.0.1:8787/chats.html
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyVisionUpserts } from "./inventory/csvStore.js";
import { mapVisionObjects } from "./inventory/mapVision.js";
import { scanInventory } from "./inventory/scanner.js";
import { readCurrentInventory } from "./inventory/csvStore.js";
import { notifyVisionRecognition } from "./agent/orchestrator.js";
import { readRecentChats, appendMemory } from "./agent/memory.js";
import { PATHS, DATA_DIR } from "./inventory/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "fixtures", "vision");

const CASES = ["case1_full.json", "case2_half.json", "case3_empty.json"] as const;

/** true unless VISION_CASES_LIVE=1 — keeps demos from spamming iMessage */
function dryRun(): boolean {
  const live = (process.env.VISION_CASES_LIVE || "").toLowerCase();
  if (live === "1" || live === "true") return false;
  return true;
}

function milkQty(): string {
  const row = readCurrentInventory().find((r) => r.sku_id === "MILK-WHOLE-1GAL");
  return row ? `${row.qty_on_hand} gal (runway ${row.runway_days}d)` : "(missing)";
}

async function runCase(file: string, dry: boolean) {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
  console.log("\n==========", raw.case, "==========");
  console.log(raw.description);

  const objects = raw.objects || [];
  const upserts = mapVisionObjects(objects);
  applyVisionUpserts(upserts);
  fs.writeFileSync(
    PATHS.lastVision,
    JSON.stringify(
      { at: new Date().toISOString(), fixture: raw.case, objects, upserts },
      null,
      2,
    ),
  );

  const scan = scanInventory();
  console.log("milk after vision:", milkQty());
  console.log("scan:", scan.summary);

  // Agent announces camera status (not a fake human message)
  const status = await notifyVisionRecognition("local-test", objects, {
    dryRun: dry,
    caseId: raw.case,
  });
  console.log("agent →", status.slice(0, 320));
  appendMemory({ type: "vision_case", case: raw.case, milk: milkQty(), dryRun: dry });
}

async function main() {
  const dry = dryRun();
  console.log("Vision cases → camera status in chats");
  console.log("Model:", process.env.AGENT_OPENAI_MODEL || "gpt-4o");
  console.log(
    dry
      ? "Mode: DRY RUN (AI status → chats.html only; no Linq send)"
      : "Mode: LIVE (will send iMessage via Linq)",
  );
  console.log("Watch chats: http://127.0.0.1:8787/chats.html");
  console.log("Data dir:", DATA_DIR);

  for (const f of CASES) {
    await runCase(f, dry);
  }

  console.log("\n========== recent chats ==========");
  for (const c of readRecentChats(12)) {
    console.log(`[${c.role}] ${c.text.slice(0, 160)}`);
  }
  console.log("\nDone. Open chats.html — look for intent=vision_status");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
