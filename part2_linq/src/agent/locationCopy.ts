/**
 * Human ship-to / delivery copy from Linq pin + open-order ETAs.
 * Always surface the full address in iMessage copy when live.
 */

import { loadLocation } from "../store/locationStore.js";
import { readOpenOrders } from "../inventory/csvStore.js";
import type { StoredLocation } from "../types/location.js";

export type LocSnapshot = {
  isDemo: boolean;
  shopName: string;
  address: string;
  when: string | null;
  /** Short one-liner */
  line: string;
  /** Multi-line block for pay / status / paid texts */
  addressBlock: string;
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Earliest planned delivery from open POs, if any. */
export function nextDeliveryWhen(): string | null {
  const envEta = process.env.DELIVERY_ETA?.trim();
  const open = readOpenOrders();
  const times = open
    .map((o) => String(o.delivered_ts || "").trim())
    .filter(Boolean)
    .sort();
  if (times[0]) return formatWhen(times[0]);
  return envEta || null;
}

export function shopNameFromLocation(loc: StoredLocation): string {
  const named = process.env.CAFE_NAME?.trim();
  if (named) return named;
  const addr = (loc.address || loc.locality || "").trim();
  if (addr) {
    const first = addr.split(",")[0]?.trim();
    if (first) return first;
  }
  return "your shop";
}

export function addressFromLocation(loc: StoredLocation): string {
  return (
    loc.address?.trim() ||
    loc.locality?.trim() ||
    `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`
  );
}

function buildAddressBlock(
  isDemo: boolean,
  shopName: string,
  address: string,
  when: string | null,
): string {
  if (isDemo) {
    return (
      "Deliver to: (demo pin — not a real café address)\n" +
      "Share LOCATION so we can use your real shop address."
    );
  }
  const lines = [
    `Deliver to: ${shopName}`,
    `Address: ${address}`,
  ];
  if (when) lines.push(`ETA: ${when}`);
  return lines.join("\n");
}

export function snapshotFromStored(loc: StoredLocation | null): LocSnapshot {
  const when = nextDeliveryWhen();
  if (!loc || loc.chatId === "demo" || loc.chatId === "test_chat") {
    const shopName = process.env.CAFE_NAME?.trim() || "your shop";
    const address = "demo pin (not a real café address)";
    return {
      isDemo: true,
      shopName,
      address,
      when,
      line: "Ship-to is still a demo pin — share LOCATION so we can deliver to the café.",
      addressBlock: buildAddressBlock(true, shopName, address, when),
    };
  }
  const shopName = shopNameFromLocation(loc);
  const address = addressFromLocation(loc);
  const whenBit = when ? ` ETA ${when}.` : "";
  return {
    isDemo: false,
    shopName,
    address,
    when,
    line: `Deliver to ${shopName} — ${address}.${whenBit}`,
    addressBlock: buildAddressBlock(false, shopName, address, when),
  };
}

/** Prefer live file; does not invent demo. */
export function readLiveLocSnapshot(): LocSnapshot {
  return snapshotFromStored(loadLocation());
}

export function msgLocationConfirmed(snap: LocSnapshot): string {
  if (snap.isDemo) {
    return (
      "I still don't have a live café address.\n" +
      "Accept the location share on this iMessage thread, then text LOCATION again.\n" +
      "I'll confirm the full ship-to address once it comes through."
    );
  }
  return (
    `Got it — delivery address locked in.\n` +
    `${snap.addressBlock}\n\n` +
    `Restocks will go here.\n` +
    `Reply APPROVE to restock, or STATUS to re-check the fridge.`
  );
}

export function msgLocationRequestSent(): string {
  return (
    "Please Accept the location share on this iMessage thread.\n" +
    "Once it's shared, text LOCATION again and I'll confirm your full shop address for delivery."
  );
}
