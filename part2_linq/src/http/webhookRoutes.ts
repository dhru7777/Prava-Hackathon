/**
 * Linq webhook → MilkWatch orchestrator (OpenAI + tools + Part3).
 */

import { Router } from "express";
import { parseInbound } from "../linq/parseWebhook.js";
import { handleInboundMessage } from "../agent/orchestrator.js";
import { classifyIntent, decideReply } from "../agent/replyPolicy.js";
import { claimInbound, claimTextFallback } from "../linq/inboundPoller.js";

export function webhookRoutes() {
  const r = Router();

  r.post("/webhook", async (req, res) => {
    const parsed = parseInbound(req.body);
    console.log("[route POST /linq/webhook] parsed =", parsed);

    res.status(200).json({ ok: true });

    const isReceived =
      !parsed.eventType ||
      parsed.eventType === "message.received" ||
      parsed.eventType.includes("received");

    if (!isReceived) {
      console.log("[webhook] ignore", parsed.eventType);
      return;
    }
    if (!parsed.chatId) {
      console.error("[webhook] missing chatId");
      return;
    }

    const text = parsed.text || "hi";
    const claimed = parsed.messageId
      ? claimInbound(parsed.messageId)
      : claimTextFallback(parsed.chatId, text);
    if (!claimed) {
      console.log("[webhook] skip duplicate (already claimed by poller/webhook)");
      return;
    }

    try {
      const result = await handleInboundMessage(parsed.chatId, text, {
        messageId: parsed.messageId,
      });
      console.log(
        "[webhook] done intent=",
        result.intent,
        "openai=",
        result.usedOpenAI,
        "tools=",
        result.toolTrace,
      );
    } catch (err) {
      console.error("[webhook] orchestrator failed", err);
    }
  });

  return r;
}

function selfTest() {
  console.log("\n=== http/webhookRoutes.ts ===");
  const parsed = parseInbound({
    type: "message.received",
    data: {
      chat_id: "fake_chat",
      message: { parts: [{ type: "text", value: "APPROVE" }] },
    },
  });
  const intent = classifyIntent(parsed.text || "");
  const reply = decideReply(parsed.text || "");
  console.log(parsed.chatId === "fake_chat" ? "PASS parse" : "FAIL parse");
  console.log(intent.type === "approve" ? "PASS intent" : "FAIL intent");
  console.log(reply.includes("Approved") ? "PASS reply" : "FAIL reply");
  console.log("RESULT: webhookRoutes OK ✅\n");
}

const runningThisFile = process.argv[1]?.includes("http/webhookRoutes.ts");
if (runningThisFile) selfTest();
