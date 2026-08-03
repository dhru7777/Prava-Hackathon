/**
 * Orchestrates: context → OpenAI (or keyword fallback) → tools → Linq reply.
 */

import { buildAgentContext } from "./context.js";
import { runOpenAIBrain } from "./openaiBrain.js";
import { classifyIntent, decideReply } from "./replyPolicy.js";
import { runRestockApprove, part3StatusLine, requotePending } from "./part3Client.js";
import { appendChat, appendMemory } from "./memory.js";
import { scanInventory } from "../inventory/scanner.js";
import { runTool } from "./tools.js";
import { sendAgentText, getPeer, resolveChatId } from "../linq/messagingService.js";
import type { VisionObject } from "../inventory/mapVision.js";
import {
  formatVisionLines,
  runStatusVisionCheck,
} from "./statusCheck.js";
import { buildStatusUserPrompt } from "./systemPrompt.js";
import {
  msgAlert,
  msgApproveAck,
  msgPaid,
  msgDeliveryAfterPaid,
  msgStatusAck,
  msgStatusWithVision,
  msgVision,
} from "./messages.js";
import {
  msgLocationConfirmed,
  msgLocationRequestSent,
  nextDeliveryWhen,
  readLiveLocSnapshot,
  snapshotFromStored,
  type LocSnapshot,
} from "./locationCopy.js";
import {
  buyPendingPick,
  clearPendingSearch,
  hasPendingCustomSearch,
  lastProductFromChats,
  parseCatalogIntent,
  runCatalogFlow,
  runCatalogSearch,
} from "./customSearch.js";
import {
  cameraRestockSummary,
  saveFridgeFocusFromVision,
  setFridgeFocus,
  readFridgeFocus,
} from "./fridgeFocus.js";
import {
  clearPendingQuote,
  hasPendingQuote,
  loadPendingQuote,
  parseQtyChange,
} from "./pendingQuote.js";
import type { StoredLocation } from "../types/location.js";

export type HandleInboundResult = {
  replies: string[];
  usedOpenAI: boolean;
  intent: string;
  toolTrace: string[];
  dryRun: boolean;
};

export type HandleOpts = {
  /** When true (or AGENT_DRY_RUN=1), do not call Linq — still log chats.csv */
  dryRun?: boolean;
  /** Linq message id (dedupe across webhook + poller) */
  messageId?: string;
};

/** One APPROVE restock at a time per chat — stops triple pay-links. */
const approveInFlight = new Set<string>();
const approveCooldownUntil = new Map<string, number>();
const APPROVE_COOLDOWN_MS = 15_000;

/** After a fresh Needed: alert, allow APPROVE immediately (demo-friendly). */
export function clearApproveCooldown(chatId?: string): void {
  if (chatId) {
    approveCooldownUntil.delete(chatId);
    return;
  }
  approveCooldownUntil.clear();
}

function isDry(opts?: HandleOpts): boolean {
  if (opts?.dryRun === true) return true;
  const v = (process.env.AGENT_DRY_RUN || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function deliver(
  chatId: string,
  text: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log("[orchestrator:dryRun] would send →", text.slice(0, 160));
    return;
  }
  try {
    await sendAgentText(chatId, text);
  } catch (e: any) {
    console.error(
      "[orchestrator] Linq send failed (chat still logged):",
      e?.message || e,
    );
  }
}

function logAgent(text: string, intent: string, outcome?: string): void {
  appendChat({
    ts: new Date().toISOString(),
    role: "agent",
    text,
    intent,
    outcome,
  });
}

/** Human-readable line for what the camera / fixture recognized. */
export function formatVisionStatus(
  objects: VisionObject[],
  _scanSummary?: string,
): string {
  const lines = (objects || []).map((o) => {
    const label = String(o.label || "item").trim() || "item";
    const fill =
      o.fill_percent != null && !Number.isNaN(Number(o.fill_percent))
        ? `${Number(o.fill_percent)}%`
        : "?";
    return `• ${label} ${fill}`;
  });
  // Camera fill drives the restock line — not CSV "eggs below par" when milk is 10%
  return msgVision(
    lines.length ? lines.join("\n") : "• nothing detected",
    cameraRestockSummary(objects || []),
  );
}

export async function notifyVisionRecognition(
  chatId: string,
  objects: VisionObject[],
  opts?: HandleOpts & { caseId?: string },
): Promise<string> {
  // Camera path = fridge milk/eggs only — drop leftover coffee/catalog pending
  clearPendingSearch();
  clearApproveCooldown(chatId);
  const focus = saveFridgeFocusFromVision(objects || []);
  const msg = formatVisionStatus(objects);
  appendMemory({
    type: "vision_recognition",
    case: opts?.caseId,
    objects,
    focus,
    summary: msg,
  });
  logAgent(msg, "vision_status", isDry(opts) ? "dry_run" : "sent");
  await deliver(chatId, msg, isDry(opts));
  return msg;
}

export async function maybeProactiveAlert(
  chatId: string,
  opts?: HandleOpts,
): Promise<string | null> {
  // Vision notify already sent the right camera restock line — skip CSV egg spam
  if (opts && (opts as any).skipAfterVision) return null;
  if (process.env.AUTO_ALERT === "false") return null;
  const focus = readFridgeFocus();
  const scan = scanInventory();
  if (!scan.critical.length && focus === "both") return null;
  // Prefer camera-style summary with Why/Urgency when we have vision/inventory context
  const msg = cameraRestockSummary([]);
  if (/Looks fine/i.test(msg) && !scan.critical.length) return null;
  appendMemory({ type: "proactive_alert", focus, summary: msg });
  logAgent(msg, "proactive_alert", isDry(opts) ? "dry_run" : "sent");
  await deliver(chatId, msg, isDry(opts));
  return msg;
}

/** Called by Part3 when sandbox collect marks payment successful. */
export async function notifyPaymentSuccessful(
  input: {
    title?: string;
    merchant?: string;
    total?: string;
    orderId?: string;
    quantity?: number;
  },
  opts?: HandleOpts,
): Promise<string> {
  const pending = loadPendingQuote();
  const snap = readLiveLocSnapshot();
  const msg = msgPaid({
    title: input.title || "Restock",
    merchant: input.merchant || "",
    total: input.total || "",
    quantity: input.quantity ?? pending?.quantity ?? 1,
    orderId: input.orderId,
    deliverTo: snap.isDemo ? undefined : snap.shopName,
    address: snap.isDemo ? undefined : snap.address,
    eta: snap.when,
  });
  const delivery = msgDeliveryAfterPaid({
    deliverTo: snap.isDemo ? undefined : snap.shopName,
    address: snap.isDemo ? undefined : snap.address,
    eta: snap.when,
  });
  clearPendingQuote();
  appendMemory({ type: "payment_successful", ...input, receipt: msg, delivery });
  logAgent(msg, "payment_successful", "paid");

  let chatId = "local-test";
  try {
    const peer = getPeer();
    chatId = (await resolveChatId(peer)) || chatId;
  } catch {
    /* local */
  }
  await deliver(chatId, msg, isDry(opts));
  await deliver(chatId, delivery, isDry(opts));
  return msg;
}

async function resolveLocSnapshot(): Promise<LocSnapshot> {
  const loc = await runTool("get_location");
  try {
    const j = JSON.parse(loc);
    if (j?.source === "linq" && j?.location) {
      return snapshotFromStored(j.location as StoredLocation);
    }
    if (j?.location) {
      return snapshotFromStored(j.location as StoredLocation);
    }
  } catch {
    /* fall through */
  }
  return readLiveLocSnapshot();
}

/**
 * STATUS: vision (dummy or camera) → inventory → LLM reply on iMessage.
 */
async function handleStatusMessage(
  chatId: string,
  inbound: string,
  send: (msg: string, outcome?: string) => Promise<void>,
  toolTrace: string[],
  dryRun: boolean,
): Promise<HandleInboundResult> {
  await send(msgStatusAck(), "ack");

  // STATUS = fridge lane — don't let a prior coffee search steal the next APPROVE
  clearPendingSearch();
  const check = await runStatusVisionCheck();
  saveFridgeFocusFromVision(check.objects || []);
  toolTrace.push(`status_vision:${check.source}:${check.caseId}`);

  const visionLines = formatVisionLines(check.objects);
  const locSnap = await resolveLocSnapshot();
  toolTrace.push("get_location");
  const locLabel = locSnap.addressBlock;

  // Fresh context after inventory upsert
  const ctx = buildAgentContext();
  const offers = await part3StatusLine().catch(() => "");
  const packed =
    ctx.packed +
    `\nSTATUS_VISION_SOURCE: ${check.source} (${check.caseId})\n` +
    `STATUS_VISION_SEEN:\n${visionLines}\n` +
    (offers ? `OFFERS:\n${offers}\n` : "");

  let usedOpenAI = false;
  try {
    const brain = await runOpenAIBrain(inbound, packed, {
      userPrompt: buildStatusUserPrompt({
        inbound,
        contextPacked: packed,
        source: check.source,
        caseId: check.caseId,
        visionLines,
        scanSummary: check.scan.summary,
        locLabel,
        locIsDemo: locSnap.isDemo,
        deliveryWhen: locSnap.when || nextDeliveryWhen(),
        fridgeFocus: readFridgeFocus(),
      }),
    });
    if (brain.usedOpenAI && brain.reply) {
      usedOpenAI = true;
      toolTrace.push(...brain.toolTrace);
      await send(brain.reply, "openai_status");
      return {
        replies: [], // filled by send via closure — fix below
        usedOpenAI,
        intent: "status",
        toolTrace,
        dryRun,
      };
    }
  } catch (e: any) {
    console.error("[orchestrator] STATUS LLM failed", e?.message || e);
    appendMemory({ type: "openai_error", error: e?.message || String(e) });
  }

  await send(
    msgStatusWithVision({
      source: check.source,
      visionLines,
      scan: check.scan.summary,
      locLabel,
    }),
    "status_fallback",
  );
  return {
    replies: [],
    usedOpenAI,
    intent: "status",
    toolTrace,
    dryRun,
  };
}

/**
 * Main inbound path used by Linq webhook (and local simulate).
 */
export async function handleInboundMessage(
  chatId: string,
  text: string,
  opts?: HandleOpts,
): Promise<HandleInboundResult> {
  const dryRun = isDry(opts);
  const inbound = (text || "hi").trim();
  const intent = classifyIntent(inbound);
  const ctx = buildAgentContext();
  const toolTrace: string[] = [];
  const replies: string[] = [];

  // Block parallel APPROVE before logging a duplicate user turn
  if (intent.type === "approve") {
    const coolUntil = approveCooldownUntil.get(chatId) || 0;
    if (approveInFlight.has(chatId) || Date.now() < coolUntil) {
      console.log("[orchestrator] skip duplicate APPROVE (in-flight or cooldown)");
      const pending = loadPendingQuote();
      const waitMsg = approveInFlight.has(chatId)
        ? "Still searching — hang tight for options + pay link…"
        : pending?.paymentUrl
          ? `Pay link is ready above.\nOpen it to finish, or wait a few seconds to APPROVE again.`
          : "Restock just ran — wait a few seconds, then APPROVE again.";
      appendChat({
        ts: new Date().toISOString(),
        role: "user",
        text: inbound,
        intent: "approve_deduped",
      });
      logAgent(waitMsg, "approve_deduped", "skipped");
      await deliver(chatId, waitMsg, dryRun);
      return {
        replies: [waitMsg],
        usedOpenAI: false,
        intent: "approve_deduped",
        toolTrace,
        dryRun,
      };
    }
  }

  appendChat({
    ts: new Date().toISOString(),
    role: "user",
    text: inbound,
    intent: intent.type,
  });

  const send = async (msg: string, outcome?: string) => {
    logAgent(msg, intent.type, outcome);
    await deliver(chatId, msg, dryRun);
    replies.push(msg);
  };

  // NL catalog: look for / search / order X / place order / pick # / "are you looking?"
  const catalog = parseCatalogIntent(inbound);

  if (catalog.kind === "clarify") {
    await send(catalog.message, "catalog_clarify");
    return {
      replies,
      usedOpenAI: false,
      intent: "catalog_clarify",
      toolTrace,
      dryRun,
    };
  }

  if (catalog.kind === "buy_pending" && hasPendingCustomSearch()) {
    toolTrace.push(`custom_buy:${catalog.pick}`);
    const result = await buyPendingPick(catalog.pick, async (stepMsg) => {
      if (replies.includes(stepMsg)) return;
      await send(stepMsg, resultOutcomeHint(stepMsg));
    });
    if (!replies.includes(result.message)) {
      await send(result.message, result.ok ? "paid_link" : "failed");
    }
    return {
      replies,
      usedOpenAI: false,
      intent: "custom_buy",
      toolTrace,
      dryRun,
    };
  }

  if (catalog.kind === "requote") {
    toolTrace.push(`requote_qty:${catalog.quantity}`);
    const result = await requotePending(catalog.quantity, async (stepMsg) => {
      if (replies.includes(stepMsg)) return;
      await send(stepMsg, resultOutcomeHint(stepMsg));
    });
    if (!replies.includes(result.message)) {
      await send(result.message, result.ok ? "paid_link" : "failed");
    }
    return {
      replies,
      usedOpenAI: false,
      intent: "requote",
      toolTrace,
      dryRun,
    };
  }

  if (catalog.kind === "status_nudge") {
    const q = lastProductFromChats();
    if (q) {
      toolTrace.push(`search_catalog_resume:${q}`);
      await send(
        `I hadn’t finished that search yet — running Prava for "${q}" now…`,
        "catalog_resume",
      );
      const result = await runCatalogSearch(q, async (stepMsg) => {
        if (replies.includes(stepMsg)) return;
        await send(stepMsg, "catalog_search");
      });
      if (!replies.includes(result.message)) {
        await send(result.message, result.ok ? "catalog_options" : "failed");
      }
      return {
        replies,
        usedOpenAI: false,
        intent: "catalog_search",
        toolTrace,
        dryRun,
      };
    }
    await send(
      "I don’t have an active product search. Tell me what to find — e.g. coffee packs or dark chocolate — and I’ll discover options, then quote/pay when you confirm.",
      "catalog_clarify",
    );
    return {
      replies,
      usedOpenAI: false,
      intent: "catalog_clarify",
      toolTrace,
      dryRun,
    };
  }

  // "order milk" / "please proceed" → fridge milk/eggs (camera focus), not coffee catalog
  if (catalog.kind === "fridge_restock") {
    const focus =
      catalog.focus === "camera" ? readFridgeFocus() : catalog.focus;
    const resolved: "milk" | "eggs" =
      focus === "eggs" ? "eggs" : focus === "milk" ? "milk" : "milk";
    setFridgeFocus(resolved);
    clearPendingSearch();
    toolTrace.push(`fridge_restock:${resolved}`);
    approveInFlight.add(chatId);
    try {
      await send(
        resolved === "milk" ? "Ordering milk…" : "Ordering eggs…",
        "ack",
      );
      const result = await runRestockApprove(async (stepMsg) => {
        if (replies.includes(stepMsg)) return;
        await send(stepMsg, resultOutcomeHint(stepMsg));
      });
      toolTrace.push("run_restock_approve");
      if (!replies.includes(result.message)) {
        await send(result.message, result.ok ? "paid_link" : "failed");
      }
      return {
        replies,
        usedOpenAI: false,
        intent: "fridge_restock",
        toolTrace,
        dryRun,
      };
    } finally {
      approveInFlight.delete(chatId);
      approveCooldownUntil.set(chatId, Date.now() + APPROVE_COOLDOWN_MS);
    }
  }

  if (intent.type === "approve") {
    approveInFlight.add(chatId);
    try {
      // APPROVE = fridge milk/eggs ONLY (never leftover coffee catalog)
      clearPendingSearch();
      await send(msgApproveAck(), "ack");
      const result = await runRestockApprove(async (stepMsg) => {
        if (replies.includes(stepMsg)) return;
        if (stepMsg === msgApproveAck()) return;
        await send(stepMsg, resultOutcomeHint(stepMsg));
      });
      toolTrace.push("run_restock_approve");
      if (!replies.includes(result.message)) {
        await send(result.message, result.ok ? "paid_link" : "failed");
      }
      return { replies, usedOpenAI: false, intent: intent.type, toolTrace, dryRun };
    } finally {
      approveInFlight.delete(chatId);
      approveCooldownUntil.set(chatId, Date.now() + APPROVE_COOLDOWN_MS);
    }
  }

  // Any product NL → discover (and quote/pay if they said place order)
  if (catalog.kind === "search") {
    toolTrace.push(
      `search_catalog:${catalog.query}${catalog.autoBuy ? ":autoBuy" : ""}`,
    );
    const result = await runCatalogFlow(
      catalog.query,
      catalog.autoBuy,
      async (stepMsg) => {
        if (replies.includes(stepMsg)) return;
        await send(stepMsg, resultOutcomeHint(stepMsg));
      },
    );
    if (!replies.includes(result.message)) {
      await send(
        result.message,
        result.ok
          ? result.intent === "catalog_buy"
            ? "paid_link"
            : "catalog_options"
          : "failed",
      );
    }
    return {
      replies,
      usedOpenAI: false,
      intent: result.intent,
      toolTrace,
      dryRun,
    };
  }

  // LOCATION — refresh pin; confirm detected shop (no JSON dump)
  if (/^(LOCATION|SHARE|LOC|ADDRESS)\b/i.test(inbound)) {
    const before = readLiveLocSnapshot();
    if (before.isDemo) {
      await runTool("request_location");
      toolTrace.push("request_location");
      await send(msgLocationRequestSent(), "location_request");
    }
    const after = await resolveLocSnapshot();
    toolTrace.push("get_location");
    await send(msgLocationConfirmed(after), "location_confirm");
    return { replies, usedOpenAI: false, intent: "location", toolTrace, dryRun };
  }

  if (intent.type === "status") {
    const out = await handleStatusMessage(
      chatId,
      inbound,
      send,
      toolTrace,
      dryRun,
    );
    return { ...out, replies };
  }

  // Ignore contact-card / name noise (e.g. "Dheeraj Maske") — don't LLM spam the thread
  if (isNoiseInbound(inbound)) {
    console.log("[orchestrator] ignore noise inbound:", inbound.slice(0, 40));
    appendMemory({ type: "ignored_noise", text: inbound.slice(0, 80) });
    return {
      replies: [],
      usedOpenAI: false,
      intent: "ignored_noise",
      toolTrace,
      dryRun,
    };
  }

  // Chat / clarify / "are you sure?" → always LLM with recent chats in context
  try {
    const brain = await runOpenAIBrain(inbound, ctx.packed);
    if (brain.usedOpenAI && brain.reply) {
      toolTrace.push(...brain.toolTrace);
      await send(brain.reply, "openai");
      return { replies, usedOpenAI: true, intent: intent.type, toolTrace, dryRun };
    }
  } catch (e: any) {
    console.error("[orchestrator] OpenAI failed, falling back", e?.message || e);
    appendMemory({ type: "openai_error", error: e?.message || String(e) });
  }

  const fallback = decideReply(inbound);
  await send(fallback, "fallback");
  return { replies, usedOpenAI: false, intent: intent.type, toolTrace, dryRun };
}

/** Contact names / accidental share text — not café commands. */
function isNoiseInbound(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 60) return false;
  // "Dheeraj Maske", "John Smith"
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3}$/.test(t)) return true;
  if (/maske|dheeraj\s+maske/i.test(t) && t.split(/\s+/).length <= 4) return true;
  // Pure emoji / punctuation
  if (/^[\p{Emoji}\s.!?,-]+$/u.test(t) && !/[a-zA-Z0-9]/.test(t)) return true;
  return false;
}

function resultOutcomeHint(msg: string): string {
  if (/Ready to pay/i.test(msg)) return "paid_link";
  if (/Found \d+ option/i.test(msg)) return "options";
  if (/Couldn't/i.test(msg)) return "failed";
  return "step";
}

async function selfTest() {
  console.log("\n=== agent/orchestrator.ts ===");
  const ctx = buildAgentContext();
  console.log(ctx.scanSummary ? "PASS context" : "FAIL context");
  const intent = classifyIntent("STATUS");
  console.log(intent.type === "status" ? "PASS status intent" : "FAIL status");
  const check = await runStatusVisionCheck();
  console.log(
    check.objects.length ? "PASS status vision" : "FAIL status vision",
    check.source,
    check.caseId,
  );
  console.log("NOTE: skipping live Linq send in self-test");
  console.log("RESULT: orchestrator OK ✅\n");
}

const running = process.argv[1]?.includes("agent/orchestrator.ts");
if (running) {
  selfTest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
