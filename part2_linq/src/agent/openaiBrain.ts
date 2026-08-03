/**
 * OpenAI chat brain for MilkWatch (uses AGENT_OPENAI_API_KEY).
 */

import { AGENT_SYSTEM_PROMPT, buildUserPrompt } from "./systemPrompt.js";
import { OPENAI_TOOLS, runTool } from "./tools.js";

export type BrainResult = {
  reply: string;
  usedOpenAI: boolean;
  toolTrace: string[];
  raw?: unknown;
};

function agentKey(): string {
  return (
    process.env.AGENT_OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

function model(): string {
  return process.env.AGENT_OPENAI_MODEL?.trim() || "gpt-4o";
}

export async function runOpenAIBrain(
  inbound: string,
  contextPacked: string,
  opts?: { userPrompt?: string },
): Promise<BrainResult> {
  const key = agentKey();
  if (!key) {
    return {
      reply: "",
      usedOpenAI: false,
      toolTrace: [],
    };
  }

  const toolTrace: string[] = [];
  const messages: any[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: opts?.userPrompt || buildUserPrompt(inbound, contextPacked),
    },
  ];

  for (let round = 0; round < 4; round++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model(),
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        temperature: 0.3,
      }),
    });
    const json: any = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message || `OpenAI HTTP ${res.status}`);
    }
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("OpenAI empty message");

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return {
        reply: String(msg.content || "").trim(),
        usedOpenAI: true,
        toolTrace,
        raw: json,
      };
    }

    messages.push(msg);
    for (const tc of toolCalls) {
      const name = tc.function?.name || "";
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        args = {};
      }
      toolTrace.push(name);
      const result = await runTool(name, args);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  return {
    reply: "I hit a tool loop limit — reply STATUS or APPROVE.",
    usedOpenAI: true,
    toolTrace,
  };
}

// ---------- SELF-TEST (no network if no key) ----------
async function selfTest() {
  console.log("\n=== agent/openaiBrain.ts ===");
  if (!agentKey()) {
    console.log("SKIP: no AGENT_OPENAI_API_KEY / OPENAI_API_KEY");
    console.log("RESULT: openaiBrain SKIP ⚠️\n");
    return;
  }
  const r = await runOpenAIBrain("STATUS", "INVENTORY:\nMILK-OAT-1L: 0 liter (runway 0d)");
  console.log("reply:", r.reply.slice(0, 200));
  console.log(r.usedOpenAI ? "PASS openai" : "FAIL");
  console.log("tools:", r.toolTrace);
  console.log("RESULT: openaiBrain OK ✅\n");
}

const running = process.argv[1]?.includes("agent/openaiBrain.ts");
if (running) selfTest().catch((e) => {
  console.error(e);
  process.exit(1);
});
