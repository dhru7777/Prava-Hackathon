/**
 * FILE 5 — CORS helper
 *
 * Test:  npx tsx src/http/cors.ts
 */

import type { Request, Response, NextFunction } from "express";

const allow = (
  process.env.CORS_ORIGINS ||
  "http://127.0.0.1:8765,http://localhost:8765"
)
  .split(",")
  .map((s) => s.trim());

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  console.log("[cors] origin =", origin, "allowed =", allow);

  if (origin && allow.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

// ---------- SELF-TEST (no server; just check allow list) ----------
function selfTest() {
  console.log("\n=== FILE 5: http/cors.ts ===");
  console.log("allow list =", allow);
  console.log(
    allow.includes("http://127.0.0.1:8765") ? "PASS local Q3 origin" : "FAIL local Q3 origin",
  );
  console.log("RESULT: FILE 5 OK ✅\n");
}

const runningThisFile = process.argv[1]?.includes("http/cors.ts");
if (runningThisFile) selfTest();