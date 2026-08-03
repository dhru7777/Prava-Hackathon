/**
 * Part 2 — 10 terminal health checks for Linq messaging readiness.
 *
 *   npm run test:part2
 *   npm run test:part2 -- --live   # also attempts a text-only send (after inbound-first)
 */
import "dotenv/config";
import LinqAPIV3 from "@linqapp/sdk";

type Result = {
  id: number;
  name: string;
  ok: boolean;
  detail: string;
};

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mask(key: string): string {
  if (!key) return "(missing)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function pass(id: number, name: string, detail: string): Result {
  return { id, name, ok: true, detail };
}
function fail(id: number, name: string, detail: string): Result {
  return { id, name, ok: false, detail };
}

function normalizeHandle(h: string): string {
  return h.trim().toLowerCase();
}

async function main() {
  const live = process.argv.includes("--live");
  const results: Result[] = [];

  console.log("\n══════════════════════════════════════════════");
  console.log(" Part 2 Linq — 10-step health checklist");
  console.log("══════════════════════════════════════════════\n");

  const apiKey =
    process.env.LINQ_API_KEY?.trim() ||
    process.env.LINQ_API_V3_API_KEY?.trim() ||
    "";
  const from = process.env.LINQ_FROM_NUMBER?.trim() || "";
  const toPhone = process.env.LINQ_TO_NUMBER?.trim() || "";
  const toEmail = process.env.LINQ_TO_EMAIL?.trim() || "";
  const dryRun =
    (process.env.LINQ_DRY_RUN || "true").trim().toLowerCase() === "true";

  // Prefer email for send if that's how the sandbox chat was opened
  const sendTo = toEmail || toPhone;

  // 1
  results.push(
    apiKey
      ? pass(1, "API key present", `LINQ_API_KEY=${mask(apiKey)}`)
      : fail(1, "API key present", "Set LINQ_API_KEY in part2_linq/.env"),
  );

  // 2
  results.push(
    E164.test(from)
      ? pass(2, "FROM number E.164", from)
      : fail(2, "FROM number E.164", `Invalid or missing LINQ_FROM_NUMBER=${from || "(empty)"}`),
  );

  // 3 — phone and/or email recipient
  if (E164.test(toPhone) || EMAIL.test(toEmail)) {
    const bits = [
      E164.test(toPhone) ? `phone=${toPhone}` : null,
      EMAIL.test(toEmail) ? `email=${toEmail}` : null,
    ].filter(Boolean);
    results.push(pass(3, "TO handle configured", bits.join(" · ")));
  } else {
    results.push(
      fail(
        3,
        "TO handle configured",
        "Set LINQ_TO_NUMBER (+E.164) and/or LINQ_TO_EMAIL",
      ),
    );
  }

  // 4
  let client: LinqAPIV3 | null = null;
  let phoneNumbers: string[] = [];
  if (!apiKey) {
    results.push(fail(4, "API auth health", "Skipped — no API key"));
  } else {
    try {
      client = new LinqAPIV3({ apiKey });
      const phones = await client.phoneNumbers.list();
      phoneNumbers = (phones.phone_numbers || []).map((p) => p.phone_number);
      results.push(
        pass(4, "API auth health", `OK — listed ${phoneNumbers.length} sandbox number(s)`),
      );
    } catch (err) {
      results.push(fail(4, "API auth health", `API error: ${(err as Error).message}`));
    }
  }

  // 5
  if (!client || !from) {
    results.push(fail(5, "FROM assigned to account", "Skipped — auth/from missing"));
  } else if (phoneNumbers.includes(from)) {
    results.push(pass(5, "FROM assigned to account", `${from} is in your pool`));
  } else {
    results.push(
      fail(
        5,
        "FROM assigned to account",
        phoneNumbers.length
          ? `${from} not in pool [${phoneNumbers.join(", ")}]`
          : "No numbers returned from API",
      ),
    );
  }

  // 6 — capability for preferred send target
  if (!client || !sendTo) {
    results.push(fail(6, "TO iMessage capability", "Skipped"));
  } else {
    try {
      const cap = await client.capability.checkImessage({
        address: sendTo,
        from: from || undefined,
      });
      results.push(
        cap.available
          ? pass(6, "TO iMessage capability", `${sendTo} available=${cap.available}`)
          : fail(6, "TO iMessage capability", `${sendTo} available=false`),
      );
    } catch (err) {
      results.push(fail(6, "TO iMessage capability", (err as Error).message));
    }
  }

  // 7
  if (!client || !from) {
    results.push(fail(7, "Chats API health", "Skipped"));
  } else {
    try {
      const chats = await client.chats.list({ from, limit: 5 });
      results.push(
        pass(7, "Chats API health", `OK — ${chats.chats?.length ?? 0} chat(s) visible`),
      );
    } catch (err) {
      results.push(fail(7, "Chats API health", (err as Error).message));
    }
  }

  // 8
  if (!client) {
    results.push(fail(8, "Webhook API health", "Skipped"));
  } else {
    try {
      const subs = await client.webhookSubscriptions.list();
      const list = Array.isArray(subs)
        ? subs
        : ((subs as { data?: unknown[] }).data ??
          (subs as { webhook_subscriptions?: unknown[] }).webhook_subscriptions ??
          []);
      results.push(
        pass(8, "Webhook API health", `OK — ${(Array.isArray(list) ? list.length : 0)} subscription(s)`),
      );
    } catch (err) {
      results.push(fail(8, "Webhook API health", (err as Error).message));
    }
  }

  // 9 — inbound/chat exists with phone OR email
  let matchedHandle: string | null = null;
  if (!client || !from) {
    results.push(fail(9, "Inbound-first chat exists", "Skipped"));
  } else {
    try {
      const chats = await client.chats.list({ from, limit: 50 });
      const candidates = [toPhone, toEmail].filter(Boolean);
      for (const c of chats.chats || []) {
        const blob = normalizeHandle(JSON.stringify(c));
        for (const cand of candidates) {
          const n = normalizeHandle(cand);
          const digits = cand.replace(/\D/g, "");
          if (blob.includes(n) || (digits.length >= 10 && blob.includes(digits))) {
            matchedHandle = cand;
            break;
          }
        }
        if (matchedHandle) break;
      }
      results.push(
        matchedHandle
          ? pass(
              9,
              "Inbound-first chat exists",
              `Chat with ${matchedHandle} found — safe to send follow-ups`,
            )
          : fail(
              9,
              "Inbound-first chat exists",
              `No chat matching phone/email yet — text ${from} from iPhone/iMessage first`,
            ),
      );
    } catch (err) {
      results.push(fail(9, "Inbound-first chat exists", (err as Error).message));
    }
  }

  // 10
  const target = matchedHandle || sendTo;
  if (!client || !from || !target) {
    results.push(fail(10, "Send path ready", "Skipped"));
  } else if (dryRun && !live) {
    results.push(
      fail(
        10,
        "Send path ready",
        "LINQ_DRY_RUN=true — set false or run: npm run test:part2 -- --live",
      ),
    );
  } else if (!live) {
    results.push(
      pass(
        10,
        "Send path ready",
        `Ready to send to ${target} (run with --live to POST /v3/chats)`,
      ),
    );
  } else {
    try {
      const res = await client.chats.create({
        from,
        to: [target],
        message: {
          parts: [{ type: "text", value: "Hello World — Part 2 health check" }],
        },
      });
      results.push(
        pass(
          10,
          "Live send Hello World",
          `to=${target} chat=${res.chat.id} status=${res.chat.message.delivery_status}`,
        ),
      );
    } catch (err) {
      results.push(
        fail(
          10,
          "Live send Hello World",
          `${(err as Error).message} (inbound-first: message the Linq number first)`,
        ),
      );
    }
  }

  let passed = 0;
  for (const r of results) {
    const mark = r.ok ? "OK  " : "FAIL";
    const icon = r.ok ? "✓" : "✗";
    console.log(`${icon} [${mark}] ${String(r.id).padStart(2)}. ${r.name}`);
    console.log(`         ${r.detail}`);
    if (r.ok) passed += 1;
  }

  console.log("\n──────────────────────────────────────────────");
  console.log(` Result: ${passed}/${results.length} checks OK`);
  if (passed === results.length) {
    console.log(" Part 2 messaging foundation: COMPLETE ✅");
  } else {
    console.log(" Part 2 messaging foundation: INCOMPLETE — fix FAIL rows above");
  }
  console.log("──────────────────────────────────────────────\n");

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
