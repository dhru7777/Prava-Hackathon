

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AnyObj) : null;
}

export function parseInbound(payload: unknown): {
  eventType?: string;
  chatId?: string;
  messageId?: string;
  text: string;
} {
  console.log("[parseWebhook] raw keys =", Object.keys(asObj(payload) || {}));

  const root = asObj(payload) || {};
  const eventType =
    (typeof root.type === "string" && root.type) ||
    (typeof root.event_type === "string" && root.event_type) ||
    (typeof asObj(root.event)?.type === "string" &&
      (asObj(root.event)!.type as string)) ||
    undefined;

  const data = asObj(root.data) || asObj(root.event) || root;
  const message =
    asObj(data.message) ||
    asObj(asObj(data.data)?.message) ||
    (Array.isArray((data as AnyObj).parts) ? data : null);

  const chatId =
    (typeof data.chat_id === "string" && data.chat_id) ||
    (typeof asObj(data.chat)?.id === "string" &&
      (asObj(data.chat)!.id as string)) ||
    (typeof root.chat_id === "string" && root.chat_id) ||
    undefined;

  const messageId =
    (message && typeof message.id === "string" && message.id) ||
    (typeof data.message_id === "string" && data.message_id) ||
    undefined;

  let text = "";
  const parts = (message && (message.parts as unknown[])) || [];
  if (Array.isArray(parts)) {
    text = parts
      .filter((p) => asObj(p)?.type === "text")
      .map((p) => String(asObj(p)?.value ?? ""))
      .join(" ")
      .trim();
  }

  const out = { eventType, chatId, messageId, text };
  console.log("[parseWebhook] parsed =", out);
  return out;
}

// ---------- SELF-TEST (fake webhook body — no internet) ----------
function selfTest() {
  console.log("\n=== FILE 3: linq/parseWebhook.ts ===");

  const fake = {
    type: "message.received",
    data: {
      chat_id: "chat_abc",
      message: {
        parts: [{ type: "text", value: "hello from phone" }],
      },
    },
  };

  const parsed = parseInbound(fake);

  console.log(parsed.eventType === "message.received" ? "PASS eventType" : "FAIL eventType");
  console.log(parsed.chatId === "chat_abc" ? "PASS chatId" : "FAIL chatId");
  console.log(parsed.text === "hello from phone" ? "PASS text" : "FAIL text");

  if (
    parsed.eventType === "message.received" &&
    parsed.chatId === "chat_abc" &&
    parsed.text === "hello from phone"
  ) {
    console.log("RESULT: FILE 3 OK ✅\n");
  } else {
    console.log("RESULT: FILE 3 FAILED ❌\n");
    process.exit(1);
  }
}

const runningThisFile = process.argv[1]?.includes("linq/parseWebhook.ts");
if (runningThisFile) selfTest();