import { ALIASES } from "./aliases";

export interface Env {
  AH_TOKENS: KVNamespace;
  SYNC_SECRET: string;
}

const AH_API_BASE = "https://api.ah.nl";
const CLIENT_ID = "appie-ios";
const CLIENT_VERSION = "9.28";
const USER_AGENT = "Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)";
const APPLICATION = "AHWEBSHOP";
const TOKENS_KV_KEY = "tokens";
const REFRESH_BUFFER_MS = 60_000;

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

function ahHeaders(accessToken?: string, orderId?: string): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "x-client-name": CLIENT_ID,
    "x-client-version": CLIENT_VERSION,
    "x-application": APPLICATION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (orderId) headers["appie-current-order-id"] = orderId;
  return headers;
}

async function refreshAccessToken(env: Env, refreshToken: string): Promise<StoredTokens> {
  const resp = await fetch(`${AH_API_BASE}/mobile-auth/v1/auth/token/refresh`, {
    method: "POST",
    headers: ahHeaders(),
    body: JSON.stringify({ clientId: CLIENT_ID, refreshToken }),
  });
  if (!resp.ok) {
    throw new Error(`token refresh failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const tokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await env.AH_TOKENS.put(TOKENS_KV_KEY, JSON.stringify(tokens));
  return tokens;
}

async function getAccessToken(env: Env): Promise<string> {
  const raw = await env.AH_TOKENS.get(TOKENS_KV_KEY);
  if (!raw) {
    throw new Error(
      "No AH tokens in KV. Run the one-time login bootstrap and seed the refresh token first."
    );
  }
  const tokens = JSON.parse(raw) as StoredTokens;
  if (tokens.expires_at - REFRESH_BUFFER_MS > Date.now()) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessToken(env, tokens.refresh_token);
  return refreshed.access_token;
}

async function searchProduct(
  accessToken: string,
  query: string
): Promise<{ productId: number; title: string } | null> {
  const params = new URLSearchParams({ query, page: "0", size: "5", sortOn: "RELEVANCE" });
  const resp = await fetch(`${AH_API_BASE}/mobile-services/product/search/v2?${params}`, {
    headers: ahHeaders(accessToken),
  });
  if (!resp.ok) {
    throw new Error(`search failed for "${query}": ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    products: { webshopId: number; title: string }[];
  };
  const top = data.products?.[0];
  return top ? { productId: top.webshopId, title: top.title } : null;
}

async function getActiveOrderId(accessToken: string): Promise<string> {
  const resp = await fetch(
    `${AH_API_BASE}/mobile-services/order/v1/summaries/active?sortBy=DEFAULT`,
    { headers: ahHeaders(accessToken) }
  );
  if (!resp.ok) {
    throw new Error(`get active order failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { id: number };
  return String(data.id);
}

async function addToCart(
  accessToken: string,
  orderId: string,
  items: { productId: number; quantity: number }[]
): Promise<void> {
  const resp = await fetch(`${AH_API_BASE}/mobile-services/order/v1/items?sortBy=DEFAULT`, {
    method: "PUT",
    headers: ahHeaders(accessToken, orderId),
    body: JSON.stringify({
      items: items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        originCode: "PRD",
        description: "",
        strikethrough: false,
      })),
    }),
  });
  if (!resp.ok) {
    throw new Error(`add to cart failed: ${resp.status} ${await resp.text()}`);
  }
}

interface SyncResult {
  input: string;
  status: "added" | "not_found" | "error";
  title?: string;
  error?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/sync") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Authorization") !== `Bearer ${env.SYNC_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const rawItems = (body as { items?: unknown })?.items;
    // Shortcuts sometimes coerces a List into a single newline-joined string
    // when it lands in a JSON body field — accept that shape too.
    const itemList: unknown =
      typeof rawItems === "string" ? rawItems.split(/\r?\n/) : rawItems;
    if (itemList !== undefined && !Array.isArray(itemList)) {
      return Response.json(
        { error: `"items" must be an array of strings, got: ${JSON.stringify(rawItems)}` },
        { status: 400 }
      );
    }
    if (Array.isArray(itemList) && itemList.some((i) => typeof i !== "string")) {
      return Response.json(
        { error: `"items" must be an array of strings, got: ${JSON.stringify(rawItems)}` },
        { status: 400 }
      );
    }
    const items = ((itemList as string[] | undefined) ?? []).map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) {
      return Response.json({ results: [] satisfies SyncResult[] });
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken(env);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }

    const results: SyncResult[] = [];
    const toAdd: { productId: number; quantity: number; title: string; input: string }[] = [];

    for (const raw of items) {
      const alias = ALIASES[raw.toLowerCase()];
      if (alias) {
        toAdd.push({ productId: alias.productId, quantity: 1, title: alias.title, input: raw });
        continue;
      }
      try {
        const found = await searchProduct(accessToken, raw);
        if (found) {
          toAdd.push({ productId: found.productId, quantity: 1, title: found.title, input: raw });
        } else {
          results.push({ input: raw, status: "not_found" });
        }
      } catch (err) {
        results.push({ input: raw, status: "error", error: String(err) });
      }
    }

    if (toAdd.length > 0) {
      try {
        const orderId = await getActiveOrderId(accessToken);
        await addToCart(
          accessToken,
          orderId,
          toAdd.map((i) => ({ productId: i.productId, quantity: i.quantity }))
        );
        for (const item of toAdd) {
          results.push({ input: item.input, status: "added", title: item.title });
        }
      } catch (err) {
        for (const item of toAdd) {
          results.push({ input: item.input, status: "error", title: item.title, error: String(err) });
        }
      }
    }

    return Response.json({ results });
  },
};
