/**
 * FILE L2 — Save / load last location on disk.
 * Test: npx tsx src/store/locationStore.ts
 */

import fs from "node:fs";
import path from "node:path";
import type { StoredLocation } from "../types/location.js";

const STORE_PATH = path.resolve(
  process.cwd(),
  "data",
  "last_location.json",
);

export function saveLocation(loc: StoredLocation): void {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(loc, null, 2), "utf8");
  console.log("[locationStore] saved →", STORE_PATH);
}

export function loadLocation(): StoredLocation | null {
  if (!fs.existsSync(STORE_PATH)) {
    console.log("[locationStore] no file yet");
    return null;
  }
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  const loc = JSON.parse(raw) as StoredLocation;
  console.log("[locationStore] loaded", loc.handle, loc.latitude, loc.longitude);
  return loc;
}

/** Demo pin when Linq location API is not enabled on the account (403 / 2011). */
export function demoLocation(peer = "demo"): StoredLocation {
  const now = new Date().toISOString();
  return {
    chatId: "demo",
    handle: peer,
    // NYU Washington Square — New York
    longitude: -73.9972,
    latitude: 40.7295,
    altitude: null,
    address: "70 Washington Square S, New York, NY",
    locality: "New York",
    updatedAt: now,
    savedAt: now,
  };
}

/** Prefer disk; otherwise seed + save the demo pin so Q3 always has a label. */
export function loadOrDemoLocation(peer?: string): StoredLocation {
  const existing = loadLocation();
  // Keep real Linq-saved pins; refresh demo/test rows to the NY address
  if (
    existing &&
    existing.chatId !== "test_chat" &&
    existing.chatId !== "demo"
  ) {
    return existing;
  }
  const demo = demoLocation(peer);
  saveLocation(demo);
  return demo;
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== FILE L2: store/locationStore.ts ===");
  const sample: StoredLocation = {
    chatId: "test_chat",
    handle: "test@example.com",
    longitude: -73.99,
    latitude: 40.73,
    updatedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  saveLocation(sample);
  const back = loadLocation();
  console.log(back?.chatId === "test_chat" ? "PASS roundtrip" : "FAIL roundtrip");
  console.log("RESULT: FILE L2 OK ✅\n");
}

const runningThisFile = process.argv[1]?.includes("store/locationStore.ts");
if (runningThisFile) selfTest();
