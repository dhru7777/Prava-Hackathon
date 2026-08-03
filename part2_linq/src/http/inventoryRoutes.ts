/**
 * Inventory HTTP API — vision ingest + scan (no OpenAI required).
 */

import { Router } from "express";
import fs from "node:fs";
import {
  applyVisionUpserts,
  readCurrentInventory,
} from "../inventory/csvStore.js";
import { mapVisionObjects, type VisionObject } from "../inventory/mapVision.js";
import { scanInventory } from "../inventory/scanner.js";
import { PATHS } from "../inventory/paths.js";
import {
  maybeProactiveAlert,
  notifyVisionRecognition,
} from "../agent/orchestrator.js";
import { getPeer, resolveChatId } from "../linq/messagingService.js";

export function inventoryRoutes() {
  const r = Router();

  r.get("/inventory/current", (_req, res) => {
    res.json({ ok: true, rows: readCurrentInventory() });
  });

  r.get("/inventory/scan", (_req, res) => {
    res.json({ ok: true, ...scanInventory() });
  });

  /**
   * Body: { objects: VisionObject[], alert?: boolean, dryRun?: boolean, visitors_day?: number }
   * Updates inventory; agent posts camera status into chats (+ Linq unless dryRun).
   */
  r.post("/inventory/vision-snapshot", async (req, res) => {
    try {
      const objects = (req.body?.objects || []) as VisionObject[];
      const dryRun = req.body?.dryRun === true;
      const upserts = mapVisionObjects(objects);
      const rows = applyVisionUpserts(upserts, {
        visitors_day: req.body?.visitors_day,
      });

      fs.writeFileSync(
        PATHS.lastVision,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            objects,
            upserts,
          },
          null,
          2,
        ),
      );

      const scan = scanInventory();
      let visionStatus: string | null = null;
      let alertSent: string | null = null;

      // Always tell manager what the camera saw (chats.html + optional iMessage)
      if (req.body?.notify !== false) {
        try {
          const peer = getPeer();
          const chatId =
            (await resolveChatId(peer)) || "local-vision";
          visionStatus = await notifyVisionRecognition(chatId, objects, {
            dryRun,
            caseId: req.body?.caseId,
          });
          if (
            req.body?.alert !== false &&
            process.env.AUTO_ALERT !== "false"
          ) {
            // Don't double-text CSV egg alerts after a camera milk message
            alertSent = await maybeProactiveAlert(chatId, {
              dryRun,
              skipAfterVision: true,
            } as any);
          }
        } catch (e: any) {
          console.warn("[vision-snapshot] notify skip", e?.message || e);
        }
      }

      res.json({
        ok: true,
        upserts,
        rows: rows.length,
        scan,
        visionStatus: Boolean(visionStatus),
        alertSent: Boolean(alertSent),
        dryRun,
      });
    } catch (e: any) {
      console.error("[vision-snapshot]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  return r;
}
