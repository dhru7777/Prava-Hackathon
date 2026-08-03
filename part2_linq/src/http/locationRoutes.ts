/**
 * FILE L4 — Location HTTP routes
 *
 *   POST /api/location/request  → ask iPhone to share
 *   GET  /api/location          → pull from Linq + save + return
 *   GET  /api/location/stored   → last saved file only (no Linq call)
 *
 * Test: npx tsx src/http/locationRoutes.ts
 */

import { Router } from "express";
import { getPeer, resolveChatId } from "../linq/messagingService.js";
import {
  requestLocationShare,
  refreshAndStoreLocation,
} from "../linq/locationService.js";
import { loadLocation, loadOrDemoLocation } from "../store/locationStore.js";

export function locationRoutes() {
  const r = Router();

  r.post("/location/request", async (_req, res) => {
    console.log("[route POST /api/location/request]");
    try {
      const peer = getPeer();
      const chatId = await resolveChatId(peer);
      if (!chatId) {
        return res.status(409).json({
          error: "No chat yet. Text the Linq number from your iPhone first.",
        });
      }
      const result = await requestLocationShare(chatId);
      res.json({
        ok: true,
        chatId,
        linq: result,
        hint: "Accept the location share prompt in iMessage (from this chat).",
      });
    } catch (err: any) {
      console.error("[location/request]", err.message);
      // Sandbox often lacks location entitlement (403 / 2011) — still return demo pin
      if (err.status === 403 || err.body?.error?.code === 2011) {
        const peer = getPeer();
        const location = loadOrDemoLocation(peer);
        return res.status(200).json({
          ok: true,
          source: "demo",
          warning: "Linq location not enabled on this account — using demo pin",
          location,
        });
      }
      res.status(err.status || 500).json({ error: err.message, details: err.body });
    }
  });

  r.get("/location", async (_req, res) => {
    console.log("[route GET /api/location]");
    try {
      const stored = await refreshAndStoreLocation();
      if (stored && stored.chatId !== "demo") {
        return res.json({
          ok: true,
          source: stored.chatId ? "linq" : "cached",
          location: stored,
        });
      }
      const peer = getPeer();
      const demo = loadOrDemoLocation(peer);
      return res.json({
        ok: true,
        source: "demo",
        warning:
          "Location API enabled — accept the iMessage share prompt (or POST /api/location/request). Showing demo pin until then.",
        location: demo,
      });
    } catch (err: any) {
      console.error("[location]", err.message);
      // 403 Location features not available → demo for UI
      try {
        const peer = getPeer();
        const location = loadOrDemoLocation(peer);
        return res.json({
          ok: true,
          source: "demo",
          warning: err.message || "Linq location unavailable — using demo pin",
          location,
        });
      } catch (e2: any) {
        res.status(err.status || 500).json({ error: err.message, details: err.body });
      }
    }
  });

  r.get("/location/stored", (_req, res) => {
    console.log("[route GET /api/location/stored]");
    try {
      const peer = getPeer();
      const stored = loadOrDemoLocation(peer);
      res.json({ ok: true, location: stored });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== FILE L4: http/locationRoutes.ts ===");
  const router = locationRoutes();
  console.log(typeof router === "function" ? "PASS router" : "FAIL router");
  console.log("RESULT: FILE L4 OK ✅\n");
}

const runningThisFile = process.argv[1]?.includes("http/locationRoutes.ts");
if (runningThisFile) selfTest();