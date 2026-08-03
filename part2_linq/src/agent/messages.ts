/**
 * Short, human iMessage copy — minimal, no jargon walls.
 */

export function msgHelp(): string {
  return (
    "MilkWatch.\n" +
    "STATUS / APPROVE — fridge\n" +
    "Ask for anything else — e.g. coffee\n" +
    "LOCATION · SKIP"
  );
}

export function msgLowStock(summary: string): string {
  return `${summary}\n\nReply APPROVE to restock.`;
}

export function msgVision(_objectsLine: string, summary: string): string {
  return summary;
}

export function msgAlert(summary: string): string {
  const s = summary.trim();
  if (/Reply APPROVE/i.test(s)) return s;
  return `${s}\nReply APPROVE to restock.`;
}

export function msgApproveAck(): string {
  return "On it — searching restock options…\nHang tight…";
}

export function msgOptionsFound(
  lines: string[],
  pickTitle: string,
  pickMerchant: string,
  reason?: string,
): string {
  const list = lines.slice(0, 4).map((l, i) => `${i + 1}. ${l}`).join("\n");
  const why = (reason || "Best shippable match for restock.")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 7)
    .join(" ");
  return (
    `I searched Prava for restock options:\n` +
    `${list}\n\n` +
    `Choosing #1: ${pickTitle} · ${pickMerchant} · qty 1\n` +
    `Why: ${why}`
  );
}

export function msgPayLink(input: {
  title: string;
  merchant: string;
  total: string;
  paymentUrl: string;
  quantity?: number;
  locNote?: string;
}): string {
  const qty = input.quantity && input.quantity > 1 ? input.quantity : 1;
  const loc = input.locNote?.trim();
  return (
    `Quoted and ready.\n` +
    `Item: ${input.title}\n` +
    `Merchant: ${input.merchant}\n` +
    `Total: ${input.total}\n` +
    `Qty: ${qty}\n` +
    (loc ? `${loc}\n` : "") +
    `\nTap to pay:\n` +
    `${input.paymentUrl}\n\n` +
    `Sandbox card\n` +
    `4622943123232200\n` +
    `CVV 93 · exp 12/30\n` +
    `OTP 456789`
  );
}

export function msgPaid(input: {
  title: string;
  merchant: string;
  total: string;
  quantity?: number;
  orderId?: string;
  deliverTo?: string;
  address?: string;
  eta?: string | null;
}): string {
  const qty = input.quantity && input.quantity > 0 ? input.quantity : 1;
  const lines = [
    "Receipt",
    `Item: ${input.title}`,
    `Merchant: ${input.merchant}`,
    `Qty: ${qty}`,
    `Total: ${input.total}`,
    `Paid: Visa ····2200`,
  ];
  if (input.orderId?.trim()) {
    const oid = input.orderId.trim();
    lines.push(
      `Order: ${oid.length > 22 ? `${oid.slice(0, 19)}...` : oid}`,
    );
  }
  if (input.deliverTo?.trim()) lines.push(`Deliver to: ${input.deliverTo.trim()}`);
  if (input.address?.trim()) lines.push(`Address: ${input.address.trim()}`);
  if (input.eta?.trim()) lines.push(`ETA: ${input.eta.trim()}`);
  return lines.join("\n");
}

/** Short follow-up after receipt with delivery details (iMessage + web). */
export function msgDeliveryAfterPaid(input: {
  deliverTo?: string;
  address?: string;
  eta?: string | null;
}): string {
  const lines = ["Delivery"];
  if (input.deliverTo?.trim()) lines.push(`Deliver to: ${input.deliverTo.trim()}`);
  if (input.address?.trim()) lines.push(`Address: ${input.address.trim()}`);
  if (input.eta?.trim()) lines.push(`ETA: ${input.eta.trim()}`);
  if (lines.length === 1) {
    lines.push("Address: share LOCATION for ship-to");
  }
  return lines.join("\n");
}

export function msgFail(reason: string): string {
  const short = reason.replace(/\s+/g, " ").trim().slice(0, 140);
  return `Couldn't finish restock.\n${short}\n\nReply APPROVE to try again.`;
}

export function msgStatusAck(): string {
  return "Checking fridge…";
}

export function msgStatus(scan: string, locLabel: string): string {
  return (
    `Fridge\n${scan}\n\n` +
    `${locLabel}\n\n` +
    `Reply APPROVE to restock.`
  );
}

/** Fallback if LLM unavailable after STATUS vision. */
export function msgStatusWithVision(input: {
  source: string;
  visionLines: string;
  scan: string;
  locLabel: string;
}): string {
  const src =
    input.source === "camera" ? "Camera" : "Camera (demo frame)";
  return (
    `${src}\n${input.visionLines || "• no objects"}\n\n` +
    `Fridge\n${input.scan}\n\n` +
    `${input.locLabel}\n\n` +
    `Reply APPROVE to restock, or ask me anything.`
  );
}
