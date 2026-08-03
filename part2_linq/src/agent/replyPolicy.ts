/**
 * Classify inbound iMessage text into intents for the agentic webhook.
 */

import { msgHelp, msgLowStock } from "./messages.js";

export type Intent =
  | { type: "approve" }
  | { type: "skip" }
  | { type: "status" }
  | { type: "help" }
  | { type: "low_stock"; itemHint: string }
  | { type: "other"; text: string };

export function classifyIntent(inboundText: string): Intent {
  const t = inboundText.trim();
  const upper = t.toUpperCase();

  // "APPROVE", "yes", "Okay approve", "please approve", "ok — approve"
  if (/^(APPROVE|YES|BUY)\b/.test(upper)) return { type: "approve" };
  if (
    /\bAPPROVE\b/.test(upper) &&
    !/\b(DON'?T|DO\s+NOT|NEVER|NOT)\b/.test(upper) &&
    upper.length <= 48
  ) {
    return { type: "approve" };
  }
  // bare "Y" / "N" alone only — avoid stealing chat like "are you sure?"
  if (/^(Y)$/.test(upper)) return { type: "approve" };
  if (/^(SKIP|NO|CANCEL)\b/.test(upper)) return { type: "skip" };
  if (/^(N)$/.test(upper)) return { type: "skip" };
  if (/^(STATUS|WHERE|OFFERS)\b/.test(upper)) return { type: "status" };
  if (/^(LOCATION|SHARE|LOC|ADDRESS)\b/.test(upper)) return { type: "status" };
  if (/^(HI|HELLO|HEY|START|HELP)\b/i.test(t) || t.length < 3) {
    return { type: "help" };
  }
  if (/low|empty|out of|need|restock|running out/i.test(t)) {
    const itemHint = /milk|egg|can|dairy/i.test(t) ? t : "groceries";
    return { type: "low_stock", itemHint };
  }
  return { type: "other", text: t };
}

/** Sync one-liner replies (APPROVE is handled async in the webhook). */
export function decideReply(inboundText: string): string {
  console.log("[replyPolicy] inbound =", JSON.stringify(inboundText));
  const intent = classifyIntent(inboundText);

  switch (intent.type) {
    case "approve":
      return "On it — finding options…";
    case "skip":
      return "Skipped. Text anytime.";
    case "status":
      return "Checking fridge…";
    case "help":
      return msgHelp();
    case "low_stock":
      return msgLowStock("Looks like you're running low.");
    default:
      return (
        `Not sure what you meant by "${intent.text.slice(0, 80)}".\n` +
        `Did you want STATUS (fridge), APPROVE (restock), LOCATION, or SKIP?`
      );
  }
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== FILE 2: agent/replyPolicy.ts ===");

  const cases: Array<[string, string]> = [
    ["APPROVE", "approve"],
    ["yes please", "approve"],
    ["Okay approve", "approve"],
    ["please approve", "approve"],
    ["ok approve!", "approve"],
    ["SKIP", "skip"],
    ["STATUS", "status"],
    ["hi", "help"],
    ["milk is low", "low_stock"],
  ];
  let ok = true;
  for (const [text, want] of cases) {
    const got = classifyIntent(text).type;
    const pass = got === want;
    console.log(pass ? "PASS" : "FAIL", text, "→", got);
    if (!pass) ok = false;
  }
  const a = decideReply("hi");
  console.log(a.includes("MilkWatch") || a.includes("STATUS") ? "PASS hi" : "FAIL hi");
  console.log(ok ? "RESULT: replyPolicy OK ✅\n" : "RESULT: replyPolicy FAIL ❌\n");
  if (!ok) process.exit(1);
}

const runningThisFile = process.argv[1]?.includes("agent/replyPolicy.ts");
if (runningThisFile) selfTest();
