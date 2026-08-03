/**
 * Optional cold/follow-up send via POST /v3/chats.
 *
 * Sandbox inbound-first: the recipient must text your Linq number BEFORE
 * your agent can message them. If create fails, text the Linq number first,
 * then retry — or just rely on the webhook auto-reply.
 *
 * First message: text only — no links, reply_to, or effects.
 */
import { createLinqClient, getFromNumber, requireEnv } from "./env.js";

async function main() {
  const to = process.env.LINQ_TO_NUMBER?.trim() || requireEnv("LINQ_TO_NUMBER");
  const from = getFromNumber();
  const client = createLinqClient();

  const text =
    process.argv.slice(2).join(" ").trim() || "Hello from my agent!";

  if (/https?:\/\//i.test(text)) {
    throw new Error(
      "First outbound message in a new chat cannot contain URLs. Remove the link.",
    );
  }

  console.log(`Sending from ${from} → ${to}`);
  const res = await client.chats.create({
    from,
    to: [to],
    message: {
      parts: [{ type: "text", value: text }],
    },
  });

  console.log("Chat created:", res.chat.id);
  console.log("Message id:", res.chat.message.id);
  console.log("Delivery:", res.chat.message.delivery_status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
