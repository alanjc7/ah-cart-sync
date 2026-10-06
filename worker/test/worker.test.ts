import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

// In-memory stand-in for the AH_TOKENS KV namespace.
function memoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key) ?? null;
      return v !== null && type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

interface FakeAH {
  // Products already in the open order, or null for "no open order".
  order: { webshopId: number; quantity: number }[] | null;
}

// Stubs global fetch: answers AH and Claude calls by URL and records them.
function fakeUpstreams(ah: FakeAH) {
  const calls: { method: string; url: string; body: any }[] = [];
  const productIds = new Map<string, number>();

  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    if (url.startsWith("https://api.anthropic.com")) {
      const text: string = body.messages[0].content;
      if (body.tool_choice.name === "parsed_items") {
        const items = text.split("\n").map((line) => {
          const raw = line.replace(/^\d+\. /, "");
          const m = raw.match(/^(\d+) x (.*)$/);
          const name = (m ? m[2] : raw).toLowerCase();
          return { quantity: m ? Number(m[1]) : 1, name, searchTerm: name };
        });
        return Response.json({ content: [{ type: "tool_use", input: { items } }] });
      }
      const itemCount = text.split("\n").filter((l) => l.startsWith("Item ")).length;
      return Response.json({
        content: [{ type: "tool_use", input: { picks: Array(itemCount).fill(0) } }],
      });
    }

    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/product/search/v2")) {
      const query = searchParams.get("query")!;
      if (!productIds.has(query)) productIds.set(query, 1000 + productIds.size);
      return Response.json({
        products: [{ webshopId: productIds.get(query), title: `AH ${query}`, currentPrice: 1.5 }],
      });
    }
    if (pathname.endsWith("/summaries/active")) {
      if (!ah.order) return new Response("no active order", { status: 404 });
      return Response.json({
        id: 42,
        orderedProducts: ah.order.map((p) => ({ quantity: p.quantity, product: { webshopId: p.webshopId } })),
      });
    }
    if (pathname.endsWith("/order/v1/items") || pathname.endsWith("/shoppinglist/v2/items")) {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return {
    calls,
    orderPut: () => calls.find((c) => c.url.includes("/order/v1/items"))?.body.items,
    listPatch: () => calls.find((c) => c.url.includes("/shoppinglist/v2/items"))?.body.items,
  };
}

function makeEnv(): Env {
  const kv = memoryKV();
  kv.put("tokens", JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600_000 }));
  return { AH_TOKENS: kv, SYNC_SECRET: "s", ANTHROPIC_API_KEY: "k" };
}

async function post(env: Env, path: string, body: unknown) {
  const resp = await worker.fetch(
    new Request(`https://w.test${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer s" },
      body: JSON.stringify(body),
    }),
    env
  );
  return { status: resp.status, json: (await resp.json()) as any };
}

afterEach(() => vi.unstubAllGlobals());

describe("weekly list", () => {
  it("stays under the 50-subrequest cap and leaves over-budget items as free text", async () => {
    const env = makeEnv();
    const ah = fakeUpstreams({ order: [] });
    const items = Array.from({ length: 45 }, (_, i) => `thing ${i}`);

    const { status, json } = await post(env, "/resolve", { items });

    expect(status).toBe(200);
    expect(ah.calls.length).toBeLessThan(50);
    expect(json.review).toHaveLength(40);
    expect(json.leftovers).toEqual(items.slice(40));
    expect(ah.listPatch()).toEqual(
      items.slice(40).map((description) => expect.objectContaining({ description, quantity: 1 }))
    );
  });

  it("merges duplicate products and adds on top of what's already in the order", async () => {
    const env = makeEnv();
    // 382907 is the "milk" alias.
    const ah = fakeUpstreams({ order: [{ webshopId: 382907, quantity: 1 }] });

    const { json } = await post(env, "/resolve", { items: ["milk", "2 x milk"] });

    expect(json.destination).toBe("order");
    expect(json.completed).toEqual(["milk", "2 x milk"]);
    expect(ah.orderPut()).toEqual([expect.objectContaining({ productId: 382907, quantity: 4 })]);
  });

  it("adds to the AH shopping list when no order is open", async () => {
    const env = makeEnv();
    const ah = fakeUpstreams({ order: null });

    const { json } = await post(env, "/resolve", { items: ["3 x bananas"] });

    expect(json.destination).toBe("list");
    expect(ah.orderPut()).toBeUndefined();
    expect(ah.listPatch()).toEqual([expect.objectContaining({ productId: 368480, quantity: 3 })]);
  });

  it("commits ticked picks, frees the rest as text, and learns the ticked ones", async () => {
    const env = makeEnv();
    let ah = fakeUpstreams({ order: [] });

    const resolved = await post(env, "/resolve", { items: ["oat milk", "feta"] });
    expect(resolved.json.completed).toEqual([]);
    expect(resolved.json.review).toHaveLength(2);
    const oatMilkLabel = resolved.json.review.find((l: string) => l.startsWith("oat milk"));

    ah = fakeUpstreams({ order: [] });
    const committed = await post(env, "/commit", { runId: resolved.json.runId, chosen: [oatMilkLabel] });
    expect(committed.json).toEqual({ destination: "order", completed: ["oat milk"], leftovers: ["feta"] });
    expect(ah.orderPut()).toEqual([expect.objectContaining({ quantity: 1 })]);
    expect(ah.listPatch()).toEqual([expect.objectContaining({ description: "feta" })]);

    // Next week, oat milk is a learned alias: added straight away, no review.
    ah = fakeUpstreams({ order: [] });
    const nextWeek = await post(env, "/resolve", { items: ["Oat milk"] });
    expect(nextWeek.json.completed).toEqual(["Oat milk"]);
    expect(nextWeek.json.review).toEqual([]);
    expect(ah.calls.some((c) => c.url.includes("/search/"))).toBe(false);
  });
});
