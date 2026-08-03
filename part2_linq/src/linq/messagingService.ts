/**
 * FILE 4 — Talk to Linq: find chat + load history.
 *
 * Needs .env: LINQ_API_KEY, LINQ_FROM_NUMBER, LINQ_TO_EMAIL (or LINQ_TO_NUMBER)
 *
 * Test:  npx tsx src/linq/messagingService.ts
 */

import { createLinqClient, getFromNumber } from "../env.js";
import type { ChatMessageDTO, ChatSnapshot } from "../types/chat.js";
import { readRecentChats } from "../agent/memory.js";

const client = createLinqClient();

function textFromParts(parts: unknown[]): string {
  return parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p.value ?? ""))
    .join(" ")
    .trim();
}

function normText(t: string): string {
  return String(t || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Web compose never appears on Linq as a user bubble (only agent replies are sent).
 * Merge recent local chats.csv turns so the demo phone shows both sides.
 */
function mergeLocalMirror(linqMessages: ChatMessageDTO[]): ChatMessageDTO[] {
  const local = readRecentChats(80);
  const seenUser = new Set(
    linqMessages.filter((m) => m.role === "user").map((m) => normText(m.text)),
  );
  const seenAgent = new Set(
    linqMessages.filter((m) => m.role === "agent").map((m) => normText(m.text)),
  );
  const merged: ChatMessageDTO[] = [...linqMessages];

  for (const t of local) {
    if (t.role !== "user" && t.role !== "agent") continue;
    const text = String(t.text || "").trim();
    if (!text) continue;
    const key = normText(text);
    if (t.role === "user") {
      if (seenUser.has(key)) continue;
      seenUser.add(key);
      merged.push({
        id: `local-user-${t.ts}`,
        role: "user",
        text,
        at: t.ts || new Date().toISOString(),
      });
    } else {
      if (seenAgent.has(key)) continue;
      // Only inject very recent agent locals (Linq lag after send)
      const age = Date.now() - new Date(t.ts).getTime();
      if (!Number.isFinite(age) || age > 3 * 60_000) continue;
      seenAgent.add(key);
      merged.push({
        id: `local-agent-${t.ts}`,
        role: "agent",
        text,
        at: t.ts || new Date().toISOString(),
      });
    }
  }

  merged.sort((a, b) => a.at.localeCompare(b.at));
  return merged.slice(-60);
}

export function getPeer(opts?: { quiet?: boolean }): string {
  const peer =
    process.env.LINQ_TO_EMAIL?.trim() ||
    process.env.LINQ_TO_NUMBER?.trim();
  if (!peer) {
    throw new Error("Set LINQ_TO_EMAIL or LINQ_TO_NUMBER in .env");
  }
  if (!opts?.quiet) console.log("[messaging] peer =", peer);
  return peer;
}

export async function getChatSnapshot(
  peer: string,
  opts?: { quiet?: boolean },
): Promise<ChatSnapshot> {
  const quiet = opts?.quiet === true;
  const chatId = await resolveChatId(peer, { quiet });
  if (!chatId) {
    const err: any = new Error(
      "No chat yet. Text the Linq number from your iPhone first.",
    );
    err.status = 404;
    throw err;
  }

  if (!quiet) console.log("[messaging] listing messages for", chatId);
  const page = await client.chats.messages.list(chatId, { limit: 50 });
  const from = getFromNumber();

  const messages: ChatMessageDTO[] = (page.messages || []).map((m: any) => {
    const handle = m.from_handle?.handle || "";
    const isAgent = m.is_from_me === true || handle === from;
    const dto: ChatMessageDTO = {
      id: m.id,
      role: isAgent ? "agent" : "user",
      text: textFromParts(m.parts || []),
      at: m.created_at || m.sent_at || new Date().toISOString(),
    };
    if (!quiet) {
      console.log("[messaging] mapped message", dto.role, dto.text.slice(0, 40));
    }
    return dto;
  });

  messages.sort((a, b) => a.at.localeCompare(b.at));
  const merged = mergeLocalMirror(messages);
  if (!quiet) {
    console.log(
      "[messaging] total messages =",
      messages.length,
      "merged =",
      merged.length,
    );
  }

  return { chatId, peer, messages: merged };
}

export async function resolveChatId(
  peer: string,
  opts?: { quiet?: boolean },
): Promise<string | null> {
  const quiet = opts?.quiet === true;
  const from = getFromNumber();
  if (!quiet) console.log("[messaging] listing chats from =", from);

  const res = await client.chats.list({ from, limit: 50 });
  const chats = res.chats || [];
  if (!quiet) console.log("[messaging] chats found =", chats.length);

  for (const c of chats as any[]) {
    const handles = c.handles || c.participants || [];
    if (!quiet) console.log("[messaging] chat", c.id, "handles =", handles);

    const hit = handles.some(
      (h: any) => String(h.handle || h).toLowerCase() === peer.toLowerCase(),
    );
    if (hit) {
      if (!quiet) console.log("[messaging] MATCH chatId =", c.id);
      return c.id;
    }
  }

  if (!quiet) console.log("[messaging] no matching chat for peer");
  return null;
}

export async function sendAgentText(chatId: string, text: string) {
  console.log("[messaging] sendAgentText chatId =", chatId, "text =", text);
  return client.chats.messages.send(chatId, {
    message: { parts: [{ type: "text", value: text }] },
  });
}

// ---------- SELF-TEST (calls real Linq API) ----------
async function selfTest() {
  console.log("\n=== FILE 4: linq/messagingService.ts ===");

  try {
    const peer = getPeer();
    console.log(peer ? "PASS peer configured" : "FAIL peer");

    const chatId = await resolveChatId(peer);
    console.log(chatId ? `PASS resolveChatId (${chatId})` : "FAIL resolveChatId (text Linq from iPhone first)");

    if (!chatId) {
      console.log("RESULT: FILE 4 PARTIAL — no chat yet (expected if you never texted)\n");
      process.exit(1);
    }

    const snap = await getChatSnapshot(peer);
    console.log("PASS snapshot chatId", snap.chatId);
    console.log("PASS snapshot count", snap.messages.length);
    console.log("First 3 messages:", snap.messages.slice(0, 3));

    console.log("RESULT: FILE 4 OK ✅\n");
  } catch (err) {
    console.error("RESULT: FILE 4 FAILED ❌", err);
    process.exit(1);
  }
}

const runningThisFile = process.argv[1]?.includes("linq/messagingService.ts");
if (runningThisFile) selfTest();