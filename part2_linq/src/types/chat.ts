/**
 * FILE 1 — Our simple chat shapes (not Linq's raw API shapes).
 *
 * Test:  npx tsx src/types/chat.ts
 */

export type ChatRole = "user" | "agent";

export type ChatMessageDTO = {
  id: string;
  role: ChatRole;
  text: string;
  at: string; // ISO time string
};

export type ChatSnapshot = {
  chatId: string;
  peer: string;
  messages: ChatMessageDTO[];
};

// ---------- SELF-TEST (runs only when you execute this file) ----------
function selfTest() {
  console.log("\n=== FILE 1: types/chat.ts ===");

  const sample: ChatMessageDTO = {
    id: "msg_1",
    role: "user",
    text: "hi",
    at: new Date().toISOString(),
  };

  console.log("TEST line: sample.message =", sample);

  const okId = typeof sample.id === "string";
  const okRole = sample.role === "user" || sample.role === "agent";
  const okText = sample.text.length > 0;
  const okAt = sample.at.includes("T");

  console.log(okId ? "PASS id" : "FAIL id");
  console.log(okRole ? "PASS role" : "FAIL role");
  console.log(okText ? "PASS text" : "FAIL text");
  console.log(okAt ? "PASS at" : "FAIL at");

  if (okId && okRole && okText && okAt) {
    console.log("RESULT: FILE 1 OK ✅\n");
  } else {
    console.log("RESULT: FILE 1 FAILED ❌\n");
    process.exit(1);
  }
}

const runningThisFile = process.argv[1]?.includes("types/chat.ts");
if (runningThisFile) selfTest();