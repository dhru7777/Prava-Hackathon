/**
 * Agent memory: chats.csv + agent_memory.jsonl
 */

import fs from "node:fs";
import { PATHS, DATA_DIR } from "../inventory/paths.js";

export type ChatTurn = {
  ts: string;
  role: "user" | "agent" | "system";
  text: string;
  intent?: string;
  linked_sku?: string;
  outcome?: string;
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PATHS.chats)) {
    fs.writeFileSync(
      PATHS.chats,
      "ts,role,text,intent,linked_sku,outcome\n",
      "utf8",
    );
  }
}

function esc(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function appendChat(turn: ChatTurn): void {
  ensure();
  const line = [
    turn.ts,
    turn.role,
    esc(turn.text.replace(/\n/g, " ")),
    turn.intent || "",
    turn.linked_sku || "",
    turn.outcome || "",
  ].join(",");
  fs.appendFileSync(PATHS.chats, line + "\n");
}

export function appendMemory(event: Record<string, unknown>): void {
  ensure();
  fs.appendFileSync(
    PATHS.agentMemory,
    JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
  );
}

export function readRecentChats(limit = 30): ChatTurn[] {
  ensure();
  const text = fs.readFileSync(PATHS.chats, "utf8").trim().split(/\r?\n/);
  if (text.length <= 1) return [];
  const rows: ChatTurn[] = [];
  for (const line of text.slice(1)) {
    if (!line.trim()) continue;
    // naive split (texts escaped)
    const m = line.match(/^(.*?),(user|agent|system),(.*)$/);
    if (!m) continue;
    // Better: parse CSV simply for our controlled writer
    const parts: string[] = [];
    let cur = "";
    let q = false;
    for (const c of line) {
      if (c === '"') {
        q = !q;
        continue;
      }
      if (c === "," && !q) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    parts.push(cur);
    rows.push({
      ts: parts[0] || "",
      role: (parts[1] as ChatTurn["role"]) || "agent",
      text: parts[2] || "",
      intent: parts[3],
      linked_sku: parts[4],
      outcome: parts[5],
    });
  }
  return rows.slice(-limit);
}

// ---------- SELF-TEST ----------
function selfTest() {
  console.log("\n=== agent/memory.ts ===");
  appendChat({
    ts: new Date().toISOString(),
    role: "system",
    text: "self-test memory ping",
    intent: "test",
  });
  appendMemory({ type: "self_test" });
  const chats = readRecentChats(5);
  console.log(chats.length ? `PASS chats ${chats.length}` : "FAIL chats");
  console.log("RESULT: memory OK ✅\n");
}

const running = process.argv[1]?.includes("agent/memory.ts");
if (running) selfTest();
