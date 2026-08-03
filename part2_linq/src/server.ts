/**
 * App entry — chat mirror + location + inventory + agent webhook
 */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { corsMiddleware } from "./http/cors.js";
import { chatRoutes } from "./http/chatRoutes.js";
import { locationRoutes } from "./http/locationRoutes.js";
import { inventoryRoutes } from "./http/inventoryRoutes.js";
import { agentRoutes } from "./http/agentRoutes.js";
import { webhookRoutes } from "./http/webhookRoutes.js";
import { startInboundPoller } from "./linq/inboundPoller.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(corsMiddleware);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "part2-linq-messaging",
    agentOpenAI: Boolean(
      process.env.AGENT_OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
    ),
    model: process.env.AGENT_OPENAI_MODEL || "gpt-4o",
    inboundPoll: (process.env.INBOUND_POLL || "true").toLowerCase() !== "false",
  });
});

app.use("/api", chatRoutes());
app.use("/api", locationRoutes());
app.use("/api", inventoryRoutes());
app.use("/api", agentRoutes());
app.use("/linq", webhookRoutes());
app.use(express.static(PUBLIC));
app.get("/chats", (_req, res) => {
  res.sendFile(path.join(PUBLIC, "chats.html"));
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Part 2 listening on http://127.0.0.1:${port}`);
  console.log(`  GET  /api/chat`);
  console.log(`  GET  /api/chats          ← agent memory turns`);
  console.log(`  GET  /chats.html         ← live chat viewer`);
  console.log(`  POST /api/agent/simulate`);
  console.log(`  POST /api/inventory/vision-snapshot`);
  console.log(`  POST /linq/webhook`);
  console.log(`  model: ${process.env.AGENT_OPENAI_MODEL || "gpt-4o"}`);
  startInboundPoller();
});
