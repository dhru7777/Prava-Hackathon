/**
 * FILE L3 — Linq location REST (SDK has no location helper yet).
 *
 * Docs: https://docs.linqapp.com/guides/location-sharing/index.md
 *   POST /v3/chats/{chatId}/location/request
 *   GET  /v3/chats/{chatId}/location
 *
 * Test: npx tsx src/linq/locationService.ts
 */

import { getApiKey } from "../env.js";
import { getPeer, resolveChatId } from "./messagingService.js";
import { saveLocation, loadLocation } from "../store/locationStore.js";
import type { StoredLocation } from "../types/location.js";

const LINQ_BASE = "https://api.linqapp.com/api/partner/v3";

async function linqFetch(path: string, init?: RequestInit) {
  const url = `${LINQ_BASE}${path}`;
  console.log("[locationService]", init?.method || "GET", url);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(
      body?.error?.message || body?.message || `Linq HTTP ${res.status}`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Prompt the human on iMessage to share location (1:1 iMessage only). */
export async function requestLocationShare(chatId: string) {
  return linqFetch(`/chats/${chatId}/location/request`, { method: "POST" });
}

/** Read current shared locations (GeoJSON FeatureCollection in data). */
export async function retrieveLocationsRaw(chatId: string) {
  return linqFetch(`/chats/${chatId}/location`);
}

/** Parse first feature → StoredLocation and write to disk. */
export async function refreshAndStoreLocation(
  chatId?: string,
): Promise<StoredLocation | null> {
  const peer = getPeer();
  const id = chatId || (await resolveChatId(peer));
  if (!id) {
    const err: any = new Error("No chat yet — text Linq from iPhone first");
    err.status = 404;
    throw err;
  }

  const raw = await retrieveLocationsRaw(id);
  // Envelope may be { success, data } or bare FeatureCollection
  const collection = raw?.data || raw;
  const features = collection?.features || [];
  console.log("[locationService] features count =", features.length);

  if (!features.length) {
    console.log("[locationService] nobody sharing yet (accept prompt on iPhone)");
    // Prefer a previously saved *live* share; ignore demo pin so UI doesn't claim "linq"
    const last = loadLocation();
    if (last && last.chatId && last.chatId !== "demo") return last;
    return null;
  }

  const f = features[0];
  const coords = f?.geometry?.coordinates || [];
  // GeoJSON: [longitude, latitude] or [lng, lat, alt]
  const longitude = Number(coords[0]);
  const latitude = Number(coords[1]);
  const altitude = coords.length > 2 ? Number(coords[2]) : null;
  const props = f?.properties || {};

  const stored: StoredLocation = {
    chatId: id,
    handle: String(props.handle || peer),
    longitude,
    latitude,
    altitude,
    address: props.address ?? null,
    locality: props.locality ?? null,
    updatedAt: String(props.updated_at || new Date().toISOString()),
    savedAt: new Date().toISOString(),
  };

  saveLocation(stored);
  return stored;
}

// ---------- SELF-TEST ----------
async function selfTest() {
  console.log("\n=== FILE L3: linq/locationService.ts ===");
  try {
    const peer = getPeer();
    const chatId = await resolveChatId(peer);
    console.log(chatId ? `PASS chatId ${chatId}` : "FAIL no chatId");
    if (!chatId) process.exit(1);

    // Safe read (does not prompt the phone)
    const raw = await retrieveLocationsRaw(chatId);
    console.log("PASS retrieve raw keys =", Object.keys(raw || {}));
    const stored = await refreshAndStoreLocation(chatId);
    console.log("stored =", stored);
    console.log("RESULT: FILE L3 OK ✅ (empty features is OK until user shares)\n");
  } catch (err: any) {
    console.error("RESULT: FILE L3 FAILED ❌", err.message, err.body || "");
    process.exit(1);
  }
}

const runningThisFile = process.argv[1]?.includes("linq/locationService.ts");
if (runningThisFile) selfTest();