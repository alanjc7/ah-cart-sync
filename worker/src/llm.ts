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
      max_tokens: 8000,
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

export interface NormalizedItem {
  quantity: number;
  name: string;
  searchTerm: string;
}

// Parses free-form shopping-list lines ("4 x bratwurst", "portobellos big x2")
// into a quantity, a canonical English name and a Dutch AH search term — all
// lines in one call. Lines meaning a known alias get that exact key as name.
export async function normalizeItems(
  apiKey: string,
  lines: string[],
  aliasKeys: string[]
): Promise<NormalizedItem[]> {
  const out = await callClaude(
    apiKey,
    `You parse shopping-list lines written by different people in different formats, for ` +
      `the Albert Heijn (AH) Dutch supermarket app. For each line, in order, return:\n` +
      `- quantity: the number of units asked for (e.g. "4 x bratwurst", "portobellos x2"); 1 if none given.\n` +
      `- name: a short lowercase English name for the item, without the quantity. If the line ` +
      `means one of these known items, use the known name exactly: ${JSON.stringify(aliasKeys)}\n` +
      `- searchTerm: the single best Dutch search term (1-3 words) matching how AH names this ` +
      `product category, using real Dutch compound words (e.g. "peanut butter" -> "pindakaas").`,
    lines.map((l, i) => `${i}. ${l}`).join("\n"),
    {
      name: "parsed_items",
      description: "One entry per input line, in the same order.",
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                quantity: { type: "integer" },
                name: { type: "string" },
                searchTerm: { type: "string" },
              },
              required: ["quantity", "name", "searchTerm"],
            },
          },
        },
        required: ["items"],
      },
    }
  );
  const items = out.items as NormalizedItem[];
  if (!Array.isArray(items) || items.length !== lines.length) {
    throw new Error(`Claude parsed ${items?.length} items for ${lines.length} lines`);
  }
  return items.map((it) => ({ ...it, quantity: Math.max(1, Math.round(it.quantity) || 1) }));
}

export interface Candidate {
  productId: number;
  title: string;
  brand: string;
  price: number;
  isBonus: boolean;
  propertyIcons: string[];
}

// Picks the best candidate for each item given standing preferences, in one
// call. Returns the chosen candidate per item, or null if none plausibly match.
export async function pickBestMatches(
  apiKey: string,
  preferences: string,
  items: { input: string; candidates: Candidate[] }[]
): Promise<(Candidate | null)[]> {
  const withCandidates = items.filter((it) => it.candidates.length > 0);
  if (withCandidates.length === 0) return items.map(() => null);

  const listText = withCandidates
    .map((it, i) => {
      const options = it.candidates
        .map((c, j) => {
          const flags = [c.isBonus ? "BONUS" : null, ...c.propertyIcons].filter(Boolean).join(", ");
          return `  ${j}. ${c.title} — brand: ${c.brand || "AH"} — €${c.price.toFixed(2)}${
            flags ? ` — ${flags}` : ""
          }`;
        })
        .join("\n");
      return `Item ${i}: "${it.input}"\n${options}`;
    })
    .join("\n\n");

  const out = await callClaude(
    apiKey,
    `You pick the best matching product for each shopping-list item from Albert Heijn (AH) ` +
      `Dutch supermarket search results. Standing preferences: ${preferences} ` +
      `If none of an item's candidates plausibly match what was actually asked for, return null for it.`,
    listText,
    {
      name: "pick_products",
      description: "One entry per item, in order: the chosen candidate index, or null for no match.",
      input_schema: {
        type: "object",
        properties: {
          picks: { type: "array", items: { type: ["integer", "null"] } },
        },
        required: ["picks"],
      },
    }
  );

  const picks = out.picks as (number | null)[];
  const chosen = new Map<(typeof items)[number], Candidate | null>();
  withCandidates.forEach((it, i) => {
    const idx = picks?.[i];
    chosen.set(it, typeof idx === "number" ? it.candidates[idx] ?? null : null);
  });
  return items.map((it) => chosen.get(it) ?? null);
}
