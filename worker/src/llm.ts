const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";

interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

async function callClaude(
  apiKey: string,
  system: string,
  userText: string,
  tool: ToolSchema
): Promise<Record<string, unknown>> {
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: userText }],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Claude API error: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    content: { type: string; input?: Record<string, unknown> }[];
  };
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse?.input) {
    throw new Error("Claude did not return the expected tool call");
  }
  return toolUse.input;
}

// Generates a Dutch AH search term for an item name that may be in English.
export async function translateToSearchTerm(apiKey: string, itemName: string): Promise<string> {
  const out = await callClaude(
    apiKey,
    `You generate short Dutch search terms for the Albert Heijn (AH) Dutch supermarket app, ` +
      `given a shopping-list item that may be in English. Reply with the single best Dutch ` +
      `search term (1-3 words) matching how AH names this product category, using real Dutch ` +
      `compound words where applicable (e.g. "peanut butter" -> "pindakaas", not "pinda boter").`,
    itemName,
    {
      name: "search_term",
      description: "The Dutch search term to use on AH's product search.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }
  );
  return out.query as string;
}

export interface Candidate {
  productId: number;
  title: string;
  brand: string;
  price: number;
  isBonus: boolean;
  propertyIcons: string[];
}

// Picks the best candidate for itemName given standing preferences, or null
// if none plausibly match (caller should treat that as not_found).
export async function pickBestMatch(
  apiKey: string,
  itemName: string,
  preferences: string,
  candidates: Candidate[]
): Promise<{ productId: number; title: string } | null> {
  if (candidates.length === 0) return null;

  const listText = candidates
    .map((c, i) => {
      const flags = [c.isBonus ? "BONUS" : null, ...c.propertyIcons].filter(Boolean).join(", ");
      return `${i}. ${c.title} — brand: ${c.brand || "AH"} — €${c.price.toFixed(2)}${
        flags ? ` — ${flags}` : ""
      }`;
    })
    .join("\n");

  const out = await callClaude(
    apiKey,
    `You pick the best matching product for a shopping-list item from Albert Heijn (AH) ` +
      `Dutch supermarket search results. Standing preferences: ${preferences} ` +
      `If none of the candidates plausibly match what was actually asked for, set matched to false.`,
    `Item: "${itemName}"\n\nCandidates:\n${listText}`,
    {
      name: "pick_product",
      description: "Choose the best matching candidate index, or none.",
      input_schema: {
        type: "object",
        properties: {
          matched: { type: "boolean" },
          index: {
            type: "integer",
            description: "Index of the chosen candidate; required if matched is true.",
          },
          reason: { type: "string" },
        },
        required: ["matched", "reason"],
      },
    }
  );

  if (!out.matched || typeof out.index !== "number" || !candidates[out.index]) {
    return null;
  }
  const chosen = candidates[out.index];
  return { productId: chosen.productId, title: chosen.title };
}
