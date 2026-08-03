/**
 * Real-time inbound without relying on flaky tunnels:
 * poll Linq chat for new user texts and run the orchestrator.
 *
 * Webhook + poller share claimInbound() so each Linq message is handled once.
 */

import fs from "node:fs";
import path from "node:path";
import { getChatSnapshot, getPeer } from "./messagingService.js";
import { handleInboundMessage } from "../agent/orchestrator.js";
import { readRecentChats } from "../agent/memory.js";
import { DATA_DIR } from "../inventory/paths.js";

const STATE_PATH = path.join(DATA_DIR, "inbound_poll_state.json");

type PollState = { seenIds: string[]; startedAt: string };

const seen = new Set<string>();
let busy = false;
let timer: ReturnType<typeof setInterval> | null = null;

function loadState(): void {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as PollState;
    for (const id of s.seenIds || []) seen.add(id);
  } catch {
    /* ignore */
  }
}

function saveState(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const ids = [...seen].slice(-500);
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ seenIds: ids, startedAt: new Date().toISOString() }, null, 2),
  );
}

/**
 * First caller wins. Webhook and poller both use this so Approve isn't run 2–3×.
 * Returns true if this process should handle the message.
 */
export function claimInbound(messageId: string | undefined | null): boolean {
  if (!messageId) return true; // no id → caller should use claimTextFallback
  if (seen.has(messageId)) return false;
  seen.add(messageId);
  saveState();
  return true;
}

/** Mark without claiming (e.g. seed agent messages). */
export function markInboundSeen(messageId: string | undefined | null): void {
  if (!messageId) return;
  seen.add(messageId);
  saveState();
}

/** Soft dedupe when webhook has no message id (rare). */
export function claimTextFallback(chatId: string, text: string): boolean {
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `text:${chatId}:${text.trim().toLowerCase()}:${bucket}`;
  return claimInbound(key);
}

/**
 * True only if we already handled this same text near this message's time.
 * Do NOT treat a later "Approve" as a duplicate of an earlier one — that
 * silently dropped restocks after Needed: eggs alerts.
 */
function alreadyLoggedUserText(
  text: string,
  sinceIso: string,
  messageAt?: string,
): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  const nearMs = messageAt ? new Date(messageAt).getTime() : NaN;
  const windowMs = 90_000;
  return readRecentChats(40).some((c) => {
    if (c.role !== "user") return false;
    if (c.ts < sinceIso) return false;
    if (c.text.trim().toLowerCase() !== t) return false;
    if (!Number.isFinite(nearMs)) return true;
    const dt = Math.abs(new Date(c.ts).getTime() - nearMs);
    return dt <= windowMs;
  });
}

async function tick(): Promise<void> {
  if (busy) return;
  if ((process.env.INBOUND_POLL || "true").toLowerCase() === "false") return;
  busy = true;
  try {
    const peer = getPeer({ quiet: true });
    const snap = await getChatSnapshot(peer, { quiet: true });
    const chats = readRecentChats(30);
    const lastCsvUser = [...chats].reverse().find((c) => c.role === "user");
    const floor = lastCsvUser?.ts || new Date(Date.now() - 15 * 60_000).toISOString();

    for (const m of snap.messages) {
      if (m.role !== "user") {
        markInboundSeen(m.id);
        continue;
      }
      if (seen.has(m.id)) continue;
      if (m.at < floor && alreadyLoggedUserText(m.text, "1970", m.at)) {
        markInboundSeen(m.id);
        continue;
      }
      if (alreadyLoggedUserText(m.text, floor, m.at)) {
        markInboundSeen(m.id);
        continue;
      }

      if (!claimInbound(m.id)) continue;
      console.log(
        "[inboundPoll] new user message",
        m.id.slice(0, 8),
        m.text.slice(0, 80),
      );
      await handleInboundMessage(snap.chatId, m.text || "hi", {
        messageId: m.id,
      });
    }
  } catch (e: any) {
    console.warn("[inboundPoll]", e?.message || e);
  } finally {
    busy = false;
  }
}

/**
 * Start polling. Interval ms via INBOUND_POLL_MS (default 2500).
 */
export function startInboundPoller(): void {
  loadState();
  const ms = Math.max(1500, Number(process.env.INBOUND_POLL_MS || 2500));
  console.log(`[inboundPoll] real-time Linq poll every ${ms}ms`);
  void (async () => {
    try {
      const peer = getPeer({ quiet: true });
      const snap = await getChatSnapshot(peer, { quiet: true });
      const chats = readRecentChats(40);
      const lastHandled = [...chats]
        .reverse()
        .find((c) => c.role === "user" || c.role === "agent");
      const floor =
        lastHandled?.ts || new Date(Date.now() - 20 * 60_000).toISOString();

      for (const m of snap.messages) {
        if (m.role !== "user") {
          markInboundSeen(m.id);
          continue;
        }
        const missed =
          m.at >= floor &&
          !alreadyLoggedUserText(m.text, floor, m.at) &&
          !seen.has(m.id);
        if (missed && claimInbound(m.id)) {
          console.log("[inboundPoll] catch-up", m.text.slice(0, 80));
          await handleInboundMessage(snap.chatId, m.text || "hi", {
            messageId: m.id,
          });
        } else {
          markInboundSeen(m.id);
        }
      }
      saveState();
    } catch (e: any) {
      console.warn("[inboundPoll] seed failed", e?.message || e);
    }
    timer = setInterval(() => {
      void tick();
    }, ms);
  })();
}

export function stopInboundPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
