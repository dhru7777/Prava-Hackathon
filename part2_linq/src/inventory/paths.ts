/**
 * Paths into part2_linq/data — shared by inventory + agent modules.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const PART2_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DATA_DIR = path.join(PART2_ROOT, "data");

export const PATHS = {
  inventoryHistory: path.join(DATA_DIR, "inventory_history.csv"),
  inventoryCurrent: path.join(DATA_DIR, "inventory_current.csv"),
  runwayDaily: path.join(DATA_DIR, "runway_daily.csv"),
  orders: path.join(DATA_DIR, "orders.csv"),
  ordersOpen: path.join(DATA_DIR, "orders_open.csv"),
  chats: path.join(DATA_DIR, "chats.csv"),
  agentMemory: path.join(DATA_DIR, "agent_memory.jsonl"),
  lastVision: path.join(DATA_DIR, "last_vision.json"),
  datasetsMd: path.join(DATA_DIR, "DATASETS.md"),
};
