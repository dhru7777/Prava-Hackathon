/**
 * FILE 6 — HTTP routes for the live mirror
 *
 * This file alone does not listen on a port.
 * We test the handler logic by importing messagingService.
 *
 * Full HTTP test comes in FILE 8 (server).
 * Quick check:  npx tsx src/http/chatRoutes.ts
 */

import { Router } from "express";
import { getChatSnapshot, getPeer } from "../linq/messagingService.js";

export function chatRoutes() {
  const r = Router();

  r.get("/chat", async (_req, res) => {
    console.log("[route GET /api/chat] hit");
    try {
      const peer = getPeer();
      const snapshot = await getChatSnapshot(peer);
      console.log("[route GET /api/chat] returning", snapshot.messages.length, "messages");
      res.json(snapshot);
    } catch (err: any) {
      console.error("[route GET /api/chat] error", err.message);
      res.status(err.status || 500).json({ error: err.message || "failed" });
    }
  });

  return r;
}

// ---------- SELF-TEST ----------
async function selfTest() {
  console.log("\n=== FILE 6: http/chatRoutes.ts ===");
  const router = chatRoutes();
  console.log(typeof router === "function" ? "PASS router created" : "FAIL router");

  // Also prove history still works through the same service the route uses
  try {
    const snap = await getChatSnapshot(getPeer());
    console.log("PASS can load snapshot via service, count =", snap.messages.length);
    console.log("RESULT: FILE 6 OK ✅\n");
  } catch (err: any) {
    console.error("FAIL snapshot", err.message);
    console.log("RESULT: FILE 6 FAILED ❌ (text Linq from iPhone if no chat)\n");
    process.exit(1);
  }
}

const runningThisFile = process.argv[1]?.includes("http/chatRoutes.ts");
if (runningThisFile) selfTest();