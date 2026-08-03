/**
 * Tool executors for the MilkWatch agent (deterministic, testable).
 */

import { scanInventory } from "../inventory/scanner.js";
import { requestLocationShare, refreshAndStoreLocation } from "../linq/locationService.js";
import { getPeer, resolveChatId } from "../linq/messagingService.js";
import { loadOrDemoLocation } from "../store/locationStore.js";
import { runRestockApprove } from "./part3Client.js";
import { appendMemory } from "./memory.js";

export type ToolName =
  | "scan_inventory"
  | "request_location"
  | "get_location"
  | "run_restock_approve"
  | "search_catalog";

export const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "scan_inventory",
      description: "Scan current inventory CSV for low runway / stockouts / open POs",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "request_location",
      description: "Prompt the human on iMessage to share live location for delivery address",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_location",
      description: "Read last stored or live Linq location (may be demo pin)",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Search Prava shop for ANY product the manager names (chocolates, coffee, snacks, etc.). Lists options only — does NOT create a pay link. Use when they ask to search/find/order something other than the default milk/eggs restock.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Product search query, e.g. "chocolates" or "coffee beans"',
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_restock_approve",
      description:
        "ONLY after explicit APPROVE for fridge milk/eggs restock: discover → quote → sandbox pay. Do NOT use for chocolates or other ad-hoc products — use search_catalog instead.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
] as const;

export async function runTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  appendMemory({ type: "tool", name, args });
  switch (name as ToolName) {
    case "scan_inventory": {
      const s = scanInventory();
      return JSON.stringify(s);
    }
    case "request_location": {
      const peer = getPeer();
      const chatId = await resolveChatId(peer);
      if (!chatId) return JSON.stringify({ ok: false, error: "no_chat" });
      try {
        const linq = await requestLocationShare(chatId);
        return JSON.stringify({ ok: true, chatId, linq });
      } catch (e: any) {
        const loc = loadOrDemoLocation(peer);
        return JSON.stringify({
          ok: false,
          warning: e?.message || String(e),
          demo: loc,
        });
      }
    }
    case "get_location": {
      try {
        const stored = await refreshAndStoreLocation();
        if (stored && stored.chatId !== "demo") {
          return JSON.stringify({ ok: true, source: "linq", location: stored });
        }
      } catch {
        /* fall through */
      }
      const peer = getPeer();
      const loc = loadOrDemoLocation(peer);
      return JSON.stringify({ ok: true, source: "demo", location: loc });
    }
    case "search_catalog": {
      const { runCatalogSearch } = await import("./customSearch.js");
      const query = String(args.query || "").trim();
      const r = await runCatalogSearch(query);
      return JSON.stringify({
        ok: r.ok,
        query,
        message: r.message,
        pending: r.pending,
        note: "Tell the manager the options. Do NOT claim payment was sent unless they pick a number or APPROVE.",
      });
    }
    case "run_restock_approve": {
      const r = await runRestockApprove();
      return JSON.stringify(r);
    }
    default:
      return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
  }
}
