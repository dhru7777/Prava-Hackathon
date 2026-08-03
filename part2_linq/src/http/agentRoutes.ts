/**
 * Chats + local agent simulate + vision fixture runners (for /chats.html).
 */

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRecentChats } from "../agent/memory.js";
import {
  handleInboundMessage,
  notifyVisionRecognition,
  notifyPaymentSuccessful,
} from "../agent/orchestrator.js";
import { applyVisionUpserts, readCurrentInventory } from "../inventory/csvStore.js";
import { mapVisionObjects } from "../inventory/mapVision.js";
import { scanInventory } from "../inventory/scanner.js";
import { PATHS } from "../inventory/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = path.join(ROOT, "fixtures", "vision");

const CASE_FILES: Record<string, string> = {
  "1_full": "case1_full.json",
  full: "case1_full.json",
  "2_half": "case2_half.json",
  half: "case2_half.json",
  "3_empty": "case3_empty.json",
  empty: "case3_empty.json",
};

export function agentRoutes() {
  const r = Router();

  /** Recent agent↔human turns from data/chats.csv */
  r.get("/chats", (_req, res) => {
    const limit = Math.min(200, Math.max(1, Number(_req.query.limit || 50)));
    res.json({ ok: true, chats: readRecentChats(limit) });
  });

  /**
   * Simulate inbound iMessage (web UI compose or local tests).
   * Body: { text, dryRun?, chatId?, fromWeb? }
   * fromWeb / dryRun:false → live Linq replies on the real chat.
   */
  r.post("/agent/simulate", async (req, res) => {
    try {
      const text = String(req.body?.text || "hi");
      const fromWeb = req.body?.fromWeb === true;
      // Web compose defaults to live send; explicit dryRun still honored
      const dryRun =
        req.body?.dryRun === true
          ? true
          : req.body?.dryRun === false || fromWeb
            ? false
            : true;
      let chatId = String(req.body?.chatId || "").trim();
      if (!chatId || chatId === "local-test") {
        try {
          const { getPeer, resolveChatId } = await import(
            "../linq/messagingService.js"
          );
          chatId = (await resolveChatId(getPeer({ quiet: true }))) || "local-test";
        } catch {
          chatId = "local-test";
        }
      }
      const result = await handleInboundMessage(chatId, text, { dryRun });
      let messages: unknown[] = [];
      try {
        const { getPeer, getChatSnapshot } = await import(
          "../linq/messagingService.js"
        );
        const snap = await getChatSnapshot(getPeer({ quiet: true }), {
          quiet: true,
        });
        messages = snap.messages;
        chatId = snap.chatId || chatId;
      } catch {
        /* optional */
      }
      res.json({
        ok: true,
        ...result,
        chatId,
        dryRun,
        // Must come after ...result so it is not overwritten
        messages,
        inventory: readCurrentInventory(),
        scan: scanInventory(),
        chats: readRecentChats(30),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  /**
   * Part3 → Part2 when sandbox collect reports payment success.
   * Body: { title, merchant, total, orderId, dryRun? }
   */
  r.post("/agent/notify-paid", async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true;
      const msg = await notifyPaymentSuccessful(
        {
          title: req.body?.title,
          merchant: req.body?.merchant,
          total: req.body?.total,
          orderId: req.body?.orderId,
          quantity: req.body?.quantity != null ? Number(req.body.quantity) : undefined,
        },
        { dryRun },
      );
      res.json({ ok: true, message: msg });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  /**
   * Apply a vision fixture and post camera status (agent) into chats.
   * Body: { case: "1_full"|"2_half"|"3_empty", dryRun?: true }
   */
  r.post("/agent/run-vision-case", async (req, res) => {
    try {
      const key = String(req.body?.case || "1_full");
      const file = CASE_FILES[key];
      if (!file) {
        res.status(400).json({
          ok: false,
          error: `Unknown case. Use: ${Object.keys(CASE_FILES).join(", ")}`,
        });
        return;
      }
      const dryRun = req.body?.dryRun !== false;
      const raw = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
      const objects = raw.objects || [];
      const upserts = mapVisionObjects(objects);
      applyVisionUpserts(upserts);
      fs.writeFileSync(
        PATHS.lastVision,
        JSON.stringify(
          { at: new Date().toISOString(), fixture: raw.case, objects, upserts },
          null,
          2,
        ),
      );
      const status = await notifyVisionRecognition("local-test", objects, {
        dryRun,
        caseId: raw.case,
      });
      res.json({
        ok: true,
        case: raw.case,
        dryRun,
        status,
        scan: scanInventory(),
        chats: readRecentChats(20),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  return r;
}
