/**
 * Subscribe this server's public URL to message.received (and helpful delivery events).
 *
 * Set WEBHOOK_PUBLIC_URL to an HTTPS tunnel pointing at this machine, e.g.:
 *   npx localtunnel --port 8787
 * then:
 *   WEBHOOK_PUBLIC_URL=https://xxxx.loca.lt npm run subscribe
 */
import { createLinqClient, requireEnv } from "./env.js";

async function main() {
  const base = requireEnv("WEBHOOK_PUBLIC_URL").replace(/\/$/, "");
  const targetUrl = `${base}/linq/webhook?version=2026-02-03`;
  const client = createLinqClient();

  const existing = await client.webhookSubscriptions.list();
  console.log("Existing subscriptions:", existing);

  const sub = await client.webhookSubscriptions.create({
    target_url: targetUrl,
    subscribed_events: [
      "message.received",
      "message.sent",
      "message.delivered",
      "message.failed",
    ],
  });

  console.log("Created webhook subscription:");
  console.log(JSON.stringify(sub, null, 2));
  console.log(
    "\nStore signing_secret from the response if present — it may not be retrievable later.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
