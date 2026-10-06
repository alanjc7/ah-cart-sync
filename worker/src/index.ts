import { ALIASES } from "./aliases";
import { PREFERENCES } from "./preferences";
import { renderDone, renderError, renderMissing, renderReview, type PendingPick, type Run } from "./review";
import { normalizeItems, pickBestMatches, type Candidate } from "./llm";

export interface Env {
  AH_TOKENS: KVNamespace;
  SYNC_SECRET: string;
  ANTHROPIC_API_KEY: string;
}

const AH_API_BASE = "https://api.ah.nl";
const CLIENT_ID = "appie-ios";
const CLIENT_VERSION = "9.28";
const USER_AGENT = "Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)";
const APPLICATION = "AHWEBSHOP";
const TOKENS_KV_KEY = "tokens";
const REFRESH_BUFFER_MS = 60_000;
const LEARNED_ALIASES_KV_KEY = "learned_aliases";
const RUN_TTL_SECONDS = 24 * 60 * 60;
// Free-plan Workers allow 50 subrequests per invocation; resolve spends ~6 on
// token/Claude/order/cart/list calls, the rest on one AH search per item.
const MAX_SEARCHES = 40;
const SEARCH_CONCURRENCY = 6;

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

async function searchProducts(accessToken: string, query: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ query, page: "0", size: "8", sortOn: "RELEVANCE" });
  const resp = await fetch(`${AH_API_BASE}/mobile-services/product/search/v2?${params}`, {
    headers: ahHeaders(accessToken),
  });
  if (!resp.ok) {
    throw new Error(`search failed for "${query}": ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    products: {
      webshopId: number;
      title: string;
      brand?: string;
      currentPrice?: number;
      priceBeforeBonus?: number;
      isBonus?: boolean;
      propertyIcons?: string[];
      images?: { url: string; width: number }[];
    }[];
  };
  return (data.products ?? []).map((p) => ({
    productId: p.webshopId,
    title: p.title,
    brand: p.brand ?? "",
    price: p.currentPrice || p.priceBeforeBonus || 0,
    isBonus: p.isBonus ?? false,
    propertyIcons: p.propertyIcons ?? [],
    imageUrl: (p.images?.find((img) => img.width >= 150) ?? p.images?.[0])?.url,
  }));
}

interface ActiveOrder {
  id: string;
  quantities: Map<number, number>; // productId -> quantity already in the order
}

// The open (unsubmitted) order, or null when there isn't one — e.g. no
// delivery slot booked yet. Items then go to the AH shopping list instead.
async function getActiveOrder(accessToken: string): Promise<ActiveOrder | null> {
  const resp = await fetch(
    `${AH_API_BASE}/mobile-services/order/v1/summaries/active?sortBy=DEFAULT`,
    { headers: ahHeaders(accessToken) }
  );
  if (!resp.ok) {
    console.log(`no active order: ${resp.status} ${await resp.text()}`);
    return null;
  }
  const data = (await resp.json()) as {
    id: number;
    orderedProducts?: { quantity: number; product: { webshopId: number } }[];
  };
  const quantities = new Map<number, number>();
  for (const p of data.orderedProducts ?? []) {
    quantities.set(p.product.webshopId, p.quantity);
  }
  return { id: String(data.id), quantities };
}

interface ProductToAdd {
  productId: number;
  quantity: number;
}

// The order endpoint sets quantities (it doesn't increment) and rejects
// duplicate product IDs, so merge duplicates and add on top of what's there.
async function addToOrder(accessToken: string, order: ActiveOrder, items: ProductToAdd[]): Promise<void> {
  const merged = new Map<number, number>();
  for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
  const resp = await fetch(`${AH_API_BASE}/mobile-services/order/v1/items?sortBy=DEFAULT`, {
    method: "PUT",
    headers: ahHeaders(accessToken, order.id),
    body: JSON.stringify({
      items: [...merged].map(([productId, quantity]) => ({
        productId,
        quantity: quantity + (order.quantities.get(productId) ?? 0),
        originCode: "PRD",
        description: "",
        strikethrough: false,
      })),
    }),
  });
  if (!resp.ok) {
    throw new Error(`add to order failed: ${resp.status} ${await resp.text()}`);
  }
}

// Adds products and/or free-text items to the AH shopping list ("Mijn lijst").
async function addToShoppingList(
  accessToken: string,
  items: { productId?: number; description: string; quantity: number }[]
): Promise<void> {
  const resp = await fetch(`${AH_API_BASE}/mobile-services/shoppinglist/v2/items`, {
    method: "PATCH",
    headers: ahHeaders(accessToken),
    body: JSON.stringify({
      items: items.map((i) => ({
        description: i.description,
        ...(i.productId ? { productId: i.productId, searchTerm: i.description } : {}),
        quantity: i.quantity,
        type: "SHOPPABLE",
        originCode: "PRD",
        strikeThrough: false,
      })),
    }),
  });
  if (!resp.ok) {
    throw new Error(`add to shopping list failed: ${resp.status} ${await resp.text()}`);
  }
}

type Destination = "order" | "list";

// Writes resolved products to the open order (or the shopping list if none)
// and leftover lines to the shopping list as free text.
async function writeItems(
  accessToken: string,
  products: (ProductToAdd & { title: string })[],
  leftovers: string[]
): Promise<Destination> {
  const order = products.length > 0 ? await getActiveOrder(accessToken) : null;
  const destination: Destination = order ? "order" : "list";
  const listItems: { productId?: number; description: string; quantity: number }[] = leftovers.map(
    (description) => ({ description, quantity: 1 })
  );
  if (order) {
    if (products.length > 0) await addToOrder(accessToken, order, products);
  } else {
    listItems.push(...products.map((p) => ({ productId: p.productId, description: p.title, quantity: p.quantity })));
  }
  if (listItems.length > 0) await addToShoppingList(accessToken, listItems);
  return destination;
}

type Alias = { productId: number; title: string };

// Hand-pinned aliases in code win over ones learned from confirmed picks.
async function loadAliases(env: Env): Promise<Record<string, Alias>> {
  const learned = await env.AH_TOKENS.get<Record<string, Alias>>(LEARNED_ALIASES_KV_KEY, "json");
  return { ...(learned ?? {}), ...ALIASES };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseItems(body: unknown): string[] | Response {
  const rawItems = (body as { items?: unknown })?.items;
  // Shortcuts sometimes coerces a List into a single newline-joined string
  // when it lands in a JSON body field — accept that shape too.
  const itemList: unknown =
    typeof rawItems === "string" ? rawItems.split(/\r?\n/) : rawItems;
  if (
    (itemList !== undefined && !Array.isArray(itemList)) ||
    (Array.isArray(itemList) && itemList.some((i) => typeof i !== "string"))
  ) {
    return Response.json(
      { error: `"items" must be an array of strings, got: ${JSON.stringify(rawItems)}` },
      { status: 400 }
    );
  }
  return ((itemList as string[] | undefined) ?? []).map((s) => s.trim()).filter(Boolean);
}

// Adds aliased items, searches + picks the rest, and stores the run for the
// review page. Returns the stored run's id.
async function resolve(env: Env, items: string[]): Promise<string> {
  const accessToken = await getAccessToken(env);
  const aliases = await loadAliases(env);
  const normalized =
    items.length > 0 ? await normalizeItems(env.ANTHROPIC_API_KEY, items, Object.keys(aliases)) : [];
  console.log("normalized", JSON.stringify(normalized));

  const products: (ProductToAdd & { title: string })[] = [];
  const completed: string[] = [];
  const leftovers: string[] = [];
  const toSearch: { input: string; name: string; quantity: number; searchTerm: string }[] = [];

  items.forEach((input, i) => {
    const n = normalized[i];
    const alias = aliases[n.name.toLowerCase()];
    if (alias) {
      products.push({ productId: alias.productId, quantity: n.quantity, title: alias.title });
      completed.push(input);
    } else if (toSearch.length < MAX_SEARCHES) {
      toSearch.push({ input, name: n.name.toLowerCase(), quantity: n.quantity, searchTerm: n.searchTerm });
    } else {
      leftovers.push(input);
    }
  });

  const searched = await mapLimit(toSearch, SEARCH_CONCURRENCY, async (it) => {
    try {
      const candidates = await searchProducts(accessToken, it.searchTerm);
      console.log(`search "${it.searchTerm}": ${candidates.length} results`);
      return { ...it, candidates };
    } catch (err) {
      console.error(String(err));
      return { ...it, candidates: [] as Candidate[] };
    }
  });
  const chosen = await pickBestMatches(env.ANTHROPIC_API_KEY, PREFERENCES, searched);

  const picks: PendingPick[] = [];
  searched.forEach((it, i) => {
    const pick = chosen[i];
    if (!pick) {
      leftovers.push(it.input);
      return;
    }
    picks.push({
      input: it.input,
      name: it.name,
      quantity: it.quantity,
      productId: pick.productId,
      title: pick.title,
      price: pick.price,
      imageUrl: pick.imageUrl,
    });
  });

  const destination = await writeItems(accessToken, products, leftovers);
  const run: Run = { destination, completed, leftovers, picks };
  const runId = crypto.randomUUID();
  await env.AH_TOKENS.put(`run:${runId}`, JSON.stringify(run), { expirationTtl: RUN_TTL_SECONDS });
  return runId;
}

// Adds the ticked picks, learns them as aliases, and free-texts the rest.
async function commit(env: Env, runId: string, run: Run, chosenIndexes: Set<number>): Promise<void> {
  const confirmed = run.picks.filter((_, i) => chosenIndexes.has(i));
  const leftovers = run.picks.filter((_, i) => !chosenIndexes.has(i)).map((p) => p.input);

  const accessToken = await getAccessToken(env);
  await writeItems(accessToken, confirmed, leftovers);

  if (confirmed.length > 0) {
    const learned =
      (await env.AH_TOKENS.get<Record<string, Alias>>(LEARNED_ALIASES_KV_KEY, "json")) ?? {};
    for (const p of confirmed) learned[p.name] = { productId: p.productId, title: p.title };
    await env.AH_TOKENS.put(LEARNED_ALIASES_KV_KEY, JSON.stringify(learned));
  }

  run.committed = { completed: confirmed.map((p) => p.input), leftovers };
  await env.AH_TOKENS.put(`run:${runId}`, JSON.stringify(run), { expirationTtl: RUN_TTL_SECONDS });
}

// The review page is reached from the Shortcut via Safari, which can't send
// the bearer secret — the unguessable, expiring runId is the credential.
async function handleReview(request: Request, env: Env, runId: string): Promise<Response> {
  const run = await env.AH_TOKENS.get<Run>(`run:${runId}`, "json");
  if (!run) return renderMissing();
  if (run.committed || run.picks.length === 0) return renderDone(run);
  if (request.method !== "POST") return renderReview(run);

  const form = await request.formData();
  const chosen = new Set(form.getAll("chosen").map((v) => Number(v)));
  try {
    await commit(env, runId, run, chosen);
  } catch (err) {
    console.error(String(err));
    return renderReview(run, `Couldn't add items: ${String(err)}`);
  }
  // Post/redirect/get, so a reload doesn't resubmit.
  return Response.redirect(request.url, 303);
}

export default {
  // Keeps the AH session alive: refreshing well before AH invalidates the
  // token means the refresh token itself never gets a chance to expire.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const raw = await env.AH_TOKENS.get(TOKENS_KV_KEY);
    if (!raw) throw new Error("No AH tokens in KV — run the login bootstrap.");
    await refreshAccessToken(env, (JSON.parse(raw) as StoredTokens).refresh_token);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const review = url.pathname.match(/^\/review\/([0-9a-f-]{36})$/);
    if (review && (request.method === "GET" || request.method === "POST")) {
      return handleReview(request, env, review[1]);
    }

    if (request.method === "GET" && url.pathname === "/error") {
      return renderError(url.searchParams.get("message") ?? "Unknown error");
    }

    if (request.method !== "POST" || url.pathname !== "/resolve") {
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
    const items = parseItems(body);
    if (items instanceof Response) return items;

    let runId: string;
    try {
      runId = await resolve(env, items);
    } catch (err) {
      console.error(String(err));
      if (url.searchParams.get("format") === "url") {
        const message = new URLSearchParams({ message: String(err) });
        return new Response(`${url.origin}/error?${message}`, { headers: { "content-type": "text/plain" } });
      }
      return Response.json({ error: String(err) }, { status: 500 });
    }
    const reviewUrl = `${url.origin}/review/${runId}`;
    // The Shortcut asks for a bare URL so it can feed it straight to "Open URLs".
    if (url.searchParams.get("format") === "url") {
      return new Response(reviewUrl, { headers: { "content-type": "text/plain" } });
    }
    return Response.json({ runId, reviewUrl });
  },
};
