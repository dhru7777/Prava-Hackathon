/**
 * Part 3 API + standalone UI
 *   API:  http://127.0.0.1:8788/api/part3/...
 *   UI:   http://127.0.0.1:8788/   (or UI_PORT if set)
 */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { corsMiddleware } from "./http/cors.js";
import { part3Routes } from "./http/routes.js";
import { resolvePayMode } from "./pay.js";
import { sandboxConfigured } from "./prava/sandbox.js";
import { loadOffers } from "./store/offers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(corsMiddleware);

app.get("/health", (_req, res) => {
  const offers = loadOffers();
  res.json({
    ok: true,
    service: "part3-prava",
    offers: offers.rows.length,
    status: offers.status,
    ui: "/",
    sandboxConfigured: sandboxConfigured(),
    defaultPayMode: resolvePayMode(),
  });
});

app.use("/api", part3Routes());
app.use(express.static(PUBLIC));
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC, "index.html"));
});

const port = Number(process.env.PORT || 8788);
app.listen(port, () => {
  console.log(`Part 3 API + UI  http://127.0.0.1:${port}/`);
  console.log(`  UI   http://127.0.0.1:${port}/`);
  console.log(`  GET  /api/part3/offers`);
  console.log(`  POST /api/part3/discover  (search only — quote one item in UI)`);
  console.log(`  POST /api/part3/quote`);
  console.log(`  POST /api/part3/pay  (sandbox CARD-03 if sk_test_ set; else live CLI)`);
  console.log(`  GET  /api/part3/pay-config`);
  console.log(
    `  pay mode: ${resolvePayMode()} (sandboxConfigured=${sandboxConfigured()})`,
  );
});

// Optional second port that only serves the UI (same app handlers via redirect hint)
const uiPort = process.env.UI_PORT ? Number(process.env.UI_PORT) : 0;
if (uiPort && uiPort !== port) {
  const uiApp = express();
  uiApp.use(corsMiddleware);
  uiApp.use(express.static(PUBLIC));
  uiApp.get("/", (_req, res) => {
    res.sendFile(path.join(PUBLIC, "index.html"));
  });
  // Proxy API calls from UI port → main API port so fetch("/api/...") works if user
  // opens UI_PORT — inject a tiny bootstrap? Simpler: rewrite page to use absolute API.
  // Instead mount a reverse proxy for /api
  uiApp.use("/api", (req, res) => {
    const target = `http://127.0.0.1:${port}${req.originalUrl}`;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      fetch(target, {
        method: req.method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      })
        .then(async (r) => {
          const text = await r.text();
          res.status(r.status).type("json").send(text);
        })
        .catch((e) => {
          res.status(502).json({ error: String(e), hint: `API on :${port} down?` });
        });
    });
  });
  uiApp.listen(uiPort, () => {
    console.log(`Part 3 UI only  http://127.0.0.1:${uiPort}/  (API proxied → :${port})`);
  });
}
