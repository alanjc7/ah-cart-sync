// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: shopping-cart;

// AH Cart Sync — adds the shared Reminders list to Albert Heijn from your phone.
//
// Runs on the phone (not a server) because AH's bot protection blocks
// requests from cloud servers. Talks to AH's private mobile-app API
// (reverse-engineered by github.com/gwillem/appie-go) and uses Claude to read
// free-form lines and pick products for anything without an alias.

// ---- Pinned aliases: canonical item name -> exact AH product. These always win.
// To find a productId: open the product on ah.nl; the URL has "wi<number>" —
// drop the "wi". Picks you tick in the review list are learned automatically
// (stored in "ah-cart-sync-aliases.json" next to this script).
const ALIASES = {
  hummus: { productId: 486453, title: "Maza Hoemoes XL" },
  milk: { productId: 382907, title: "AH Biologisch Halfvolle melk 1,5L" },
  peppers: { productId: 41194, title: "AH Paprika mix" },
  bananas: { productId: 368480, title: "AH Biologisch Fairtrade bananen" },
  wraps: { productId: 173410, title: "AH Tortilla naturel wraps large 12 stuks" },
  yoghurt: { productId: 60746, title: "AH Biologisch Volle yoghurt" },
  tofu: { productId: 598995, title: "AH Terra Biologische tofu grootverpakking" },
  pastry: { productId: 503093, title: "AH Vers bladerdeeg" },
  garlic: { productId: 185774, title: "AH Biologisch Knoflook" },
  cucumber: { productId: 101130, title: "AH Biologisch Komkommer" },
  carrots: { productId: 561136, title: "AH Biologisch Winterpeen" },
  pesto: { productId: 30037, title: "Bertolli Pesto alla genovese" },
  "tricolour pasta": { productId: 519105, title: "Grand' Italia Fusilli tricolori" },
  "brown onions": { productId: 4083, title: "AH Gele uien" },
  "red onions": { productId: 439146, title: "AH Rode uien" },
  "chopped tomatoes": { productId: 395307, title: "AH Biologisch Tomatenblokjes" },
  "pizza sauce": { productId: 234871, title: "Mutti Pizzasaus aromatica" },
  "grated cheese": { productId: 478232, title: "AH Tex-mex geraspte kaas" },
  "cheese slices": { productId: 185784, title: "AH Biologisch Jong belegen 50+ plakken" },
  "peanut butter": { productId: 479791, title: "AH Terra Plantaardig 100% pindakaas naturel" },
  "sour cream": { productId: 585958, title: "AH Biologisch Sour cream" },
  shoarma: { productId: 563706, title: "AH Terra Plantaardige shoarma" },
  "frozen mango": { productId: 445512, title: "AH Zakje met mangostukjes" },
  "frozen banana": { productId: 582336, title: "AH Zakje met banaan plakjes" },
  "frozen raspberries": { productId: 513739, title: "AH Zakje met frambozen" },
  "toilet roll": { productId: 595095, title: "AH Eco Toiletpapier 3-laags 8=12 rollen" },
  "toilet paper": { productId: 595095, title: "AH Eco Toiletpapier 3-laags 8=12 rollen" },
  "dishwasher tablets": { productId: 232662, title: "AH Power all in 1 vaatwastabletten" },
  "dishwasher tabs": { productId: 232662, title: "AH Power all in 1 vaatwastabletten" },
};

// Standing preferences for Claude's picks — plain English, edit freely.
const PREFERENCES = `Prefer AH own-brand (e.g. "AH", "AH Biologisch") and organic
products where reasonably available. However, if a well-known/premium brand is currently
on bonus (special offer), prefer that instead over a more expensive own-brand option.`;

const AH_API_BASE = "https://api.ah.nl";
const CLIENT_ID = "appie-ios";
const CLIENT_VERSION = "9.28";
const USER_AGENT = "Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const SEARCH_CONCURRENCY = 3;
const REFRESH_BUFFER_MS = 60_000;

const KEY_TOKENS = "ah_cart_sync_tokens";
const KEY_ANTHROPIC = "ah_cart_sync_anthropic_key";
const KEY_LIST = "ah_cart_sync_list_name";
const fm = FileManager.iCloud();
const LEARNED_PATH = fm.joinPath(fm.documentsDirectory(), "ah-cart-sync-aliases.json");

// ---------------------------------------------------------------- setup

async function ask(title, message, placeholder) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addTextField(placeholder, "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.presentAlert()) === -1) throw new Error("Setup cancelled");
  const value = a.textFieldValue(0).trim();
  if (!value) throw new Error(`${title} is required`);
  return value;
}

// Asks once for anything missing and keeps it in the iOS Keychain.
async function ensureSetup() {
  if (!Keychain.contains(KEY_LIST)) {
    Keychain.set(KEY_LIST, await ask("Reminders list", "Name of the shared shopping list", "Shopping"));
  }
  if (!Keychain.contains(KEY_ANTHROPIC)) {
    Keychain.set(KEY_ANTHROPIC, await ask("Anthropic API key", "Used to read lines and pick products", "sk-ant-…"));
  }
  if (!Keychain.contains(KEY_TOKENS)) {
    const refresh = await ask("AH refresh token", "Paste the refresh token from the AH login", "");
    Keychain.set(KEY_TOKENS, JSON.stringify({ access_token: "", refresh_token: refresh, expires_at: 0 }));
  }
}

// ---------------------------------------------------------------- HTTP

async function http(url, { method = "GET", headers = {}, body } = {}) {
  const req = new Request(url);
  req.method = method;
  req.headers = headers;
  if (body !== undefined) req.body = JSON.stringify(body);
  req.timeoutInterval = 30;
  const text = await req.loadString();
  const status = req.response.statusCode;
  return { ok: status >= 200 && status < 300, status, text };
}

function ahHeaders(accessToken, orderId) {
  const h = {
    "User-Agent": USER_AGENT,
    "x-client-name": CLIENT_ID,
    "x-client-version": CLIENT_VERSION,
    "x-application": "AHWEBSHOP",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  if (orderId) h["appie-current-order-id"] = orderId;
  return h;
}

// ---------------------------------------------------------------- AH

// On a refused refresh token, asks for a fresh one (from `appie login` on the
// Mac) and retries once.
async function getAccessToken(retried = false) {
  const tokens = JSON.parse(Keychain.get(KEY_TOKENS));
  if (tokens.expires_at - REFRESH_BUFFER_MS > Date.now()) return tokens.access_token;

  const resp = await http(`${AH_API_BASE}/mobile-auth/v1/auth/token/refresh`, {
    method: "POST",
    headers: ahHeaders(),
    body: { clientId: CLIENT_ID, refreshToken: tokens.refresh_token },
  });
  if (!resp.ok) {
    console.error(`token refresh refused: ${resp.status} ${resp.text.slice(0, 300)}`);
    if (retried) throw new Error(`AH refused the new refresh token too (${resp.status}): ${resp.text.slice(0, 200)}`);
    const refresh = await ask(
      `AH login expired (${resp.status})`,
      "Log in on your Mac with `appie login` and paste the new refresh token",
      ""
    );
    Keychain.set(KEY_TOKENS, JSON.stringify({ access_token: "", refresh_token: refresh, expires_at: 0 }));
    return getAccessToken(true);
  }
  const data = JSON.parse(resp.text);
  Keychain.set(
    KEY_TOKENS,
    JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    })
  );
  return data.access_token;
}

async function searchProducts(accessToken, query) {
  const params = `query=${encodeURIComponent(query)}&page=0&size=8&sortOn=RELEVANCE`;
  const resp = await http(`${AH_API_BASE}/mobile-services/product/search/v2?${params}`, {
    headers: ahHeaders(accessToken),
  });
  if (!resp.ok) throw new Error(`search failed for "${query}": ${resp.status}`);
  return (JSON.parse(resp.text).products ?? []).map((p) => ({
    productId: p.webshopId,
    title: p.title,
    brand: p.brand ?? "",
    price: p.currentPrice || p.priceBeforeBonus || 0,
    isBonus: p.isBonus ?? false,
    propertyIcons: p.propertyIcons ?? [],
  }));
}

// The open (unsubmitted) order with its current quantities, or null when
// there isn't one — products then go to the AH shopping list instead.
async function getActiveOrder(accessToken) {
  const resp = await http(`${AH_API_BASE}/mobile-services/order/v1/summaries/active?sortBy=DEFAULT`, {
    headers: ahHeaders(accessToken),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`checking for an open order failed: ${resp.status}`);
  const data = JSON.parse(resp.text);
  const quantities = new Map();
  for (const p of data.orderedProducts ?? []) quantities.set(p.product.webshopId, p.quantity);
  return { id: String(data.id), quantities };
}

// AH rejects duplicate items in one write, so merge by product (or text).
function merge(items) {
  const merged = new Map();
  for (const i of items) {
    const key = i.productId ? `p:${i.productId}` : `t:${i.description.toLowerCase()}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, quantity: prev.quantity + i.quantity } : { ...i });
  }
  return [...merged.values()];
}

// The order endpoint sets quantities rather than adding, so add on top.
async function addToOrder(accessToken, order, products) {
  const resp = await http(`${AH_API_BASE}/mobile-services/order/v1/items?sortBy=DEFAULT`, {
    method: "PUT",
    headers: ahHeaders(accessToken, order.id),
    body: {
      items: merge(products).map((p) => ({
        productId: p.productId,
        quantity: p.quantity + (order.quantities.get(p.productId) ?? 0),
        originCode: "PRD",
        description: "",
        strikethrough: false,
      })),
    },
  });
  if (!resp.ok) throw new Error(`add to order failed: ${resp.status} ${resp.text.slice(0, 200)}`);
}

async function addToShoppingList(accessToken, items) {
  const resp = await http(`${AH_API_BASE}/mobile-services/shoppinglist/v2/items`, {
    method: "PATCH",
    headers: ahHeaders(accessToken),
    body: {
      items: merge(items).map((i) => ({
        description: i.description,
        ...(i.productId ? { productId: i.productId, searchTerm: i.description } : {}),
        quantity: i.quantity,
        type: "SHOPPABLE",
        originCode: "PRD",
        strikeThrough: false,
      })),
    },
  });
  if (!resp.ok) throw new Error(`add to shopping list failed: ${resp.status} ${resp.text.slice(0, 200)}`);
}

// ---------------------------------------------------------------- Claude

async function callClaude(system, userText, tool) {
  const resp = await http("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Keychain.get(KEY_ANTHROPIC),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: {
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      temperature: 0,
      system,
      messages: [{ role: "user", content: userText }],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    },
  });
  if (!resp.ok) throw new Error(`Claude API error: ${resp.status} ${resp.text.slice(0, 200)}`);
  const toolUse = JSON.parse(resp.text).content.find((b) => b.type === "tool_use");
  if (!toolUse?.input) throw new Error("Claude did not return the expected tool call");
  return toolUse.input;
}

// Parses free-form lines ("4 x bratwurst", "portobellos big x2") into
// quantity, canonical English name, Dutch AH search term and — constrained
// to the known alias keys so it can't paraphrase — the matching alias, in one call.
async function normalizeItems(lines, aliasKeys) {
  const out = await callClaude(
    `You parse shopping-list lines written by different people in different formats, for ` +
      `the Albert Heijn (AH) Dutch supermarket app. For each line, in order, return:\n` +
      `- quantity: the number of units asked for (e.g. "4 x bratwurst", "portobellos x2"); 1 if none given.\n` +
      `- name: a short lowercase English name for the item, without the quantity.\n` +
      `- alias: if the line means one of the known items listed in the schema (allowing for ` +
      `plurals, spelling, extra detail like "eg cheddar" or "big"), that known item; otherwise null.\n` +
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
                alias: { type: ["string", "null"], enum: [...aliasKeys, null] },
              },
              required: ["quantity", "name", "searchTerm", "alias"],
            },
          },
        },
        required: ["items"],
      },
    }
  );
  if (!Array.isArray(out.items) || out.items.length !== lines.length) {
    throw new Error(`Claude parsed ${out.items?.length} items for ${lines.length} lines`);
  }
  return out.items.map((it) => ({
    ...it,
    name: it.name.toLowerCase(),
    quantity: Math.max(1, Math.round(it.quantity) || 1),
  }));
}

// Picks the best candidate per item given the preferences, in one call.
// Returns the chosen candidate per item, or null for no plausible match.
async function pickBestMatches(items) {
  const withCandidates = items.filter((it) => it.candidates.length > 0);
  if (withCandidates.length === 0) return items.map(() => null);

  const listText = withCandidates
    .map((it, i) => {
      const options = it.candidates
        .map((c, j) => {
          const flags = [c.isBonus ? "BONUS" : null, ...c.propertyIcons].filter(Boolean).join(", ");
          return `  ${j}. ${c.title} — brand: ${c.brand || "AH"} — €${c.price.toFixed(2)}${flags ? ` — ${flags}` : ""}`;
        })
        .join("\n");
      return `Item ${i}: "${it.line}"\n${options}`;
    })
    .join("\n\n");

  const out = await callClaude(
    `You pick the best matching product for each shopping-list item from Albert Heijn (AH) ` +
      `Dutch supermarket search results. Standing preferences: ${PREFERENCES} ` +
      `If none of an item's candidates plausibly match what was actually asked for, return null for it.`,
    listText,
    {
      name: "pick_products",
      description: "One entry per item, in order: the chosen candidate index, or null for no match.",
      input_schema: {
        type: "object",
        properties: { picks: { type: "array", items: { type: ["integer", "null"] } } },
        required: ["picks"],
      },
    }
  );
  const chosen = new Map();
  withCandidates.forEach((it, i) => {
    const idx = out.picks?.[i];
    chosen.set(it, typeof idx === "number" ? it.candidates[idx] ?? null : null);
  });
  return items.map((it) => chosen.get(it) ?? null);
}

// ---------------------------------------------------------------- aliases

async function loadLearnedAliases() {
  if (!fm.fileExists(LEARNED_PATH)) return {};
  await fm.downloadFileFromiCloud(LEARNED_PATH);
  return JSON.parse(fm.readString(LEARNED_PATH));
}

// ---------------------------------------------------------------- review UI

// Shows the picks as a tick-list (all ticked). Resolves to the ticked picks,
// or null if the user backs out.
async function review(picks) {
  const ticked = picks.map(() => true);
  let confirmed = false;
  const table = new UITable();
  table.showSeparators = true;

  const render = () => {
    table.removeAllRows();
    const header = new UITableRow();
    header.isHeader = true;
    header.addText("Review picks", "Tap to untick wrong ones — they go to the AH list as text");
    header.height = 70;
    table.addRow(header);

    picks.forEach((p, i) => {
      const row = new UITableRow();
      row.height = 64;
      const mark = row.addText(ticked[i] ? "✅" : "⬜️");
      mark.widthWeight = 10;
      const text = row.addText(p.line, `${p.title} · ×${p.quantity} · €${p.price.toFixed(2)}`);
      text.widthWeight = 90;
      row.dismissOnSelect = false;
      row.onSelect = () => {
        ticked[i] = !ticked[i];
        render();
      };
      table.addRow(row);
    });

    const go = new UITableRow();
    go.height = 60;
    const n = ticked.filter(Boolean).length;
    const cell = go.addText(`Add ${n} ticked item${n === 1 ? "" : "s"}`);
    cell.centerAligned();
    go.dismissOnSelect = true;
    go.onSelect = () => {
      confirmed = true;
    };
    table.addRow(go);
    table.reload();
  };

  render();
  await table.present(true);
  if (!confirmed) return null;
  return picks.filter((_, i) => ticked[i]);
}

async function showSummary(title, lines) {
  const a = new Alert();
  a.title = title;
  a.message = lines.filter(Boolean).join("\n\n");
  a.addAction("OK");
  await a.presentAlert();
}

// ---------------------------------------------------------------- main

async function main() {
  await ensureSetup();

  const listName = Keychain.get(KEY_LIST);
  const calendar = await Calendar.forRemindersByTitle(listName);
  const reminders = (await Reminder.allIncomplete([calendar])).filter((r) => r.title.trim());
  if (reminders.length === 0) {
    await showSummary("Nothing to add", [`"${listName}" has no open reminders.`]);
    return;
  }
  const lines = reminders.map((r) => r.title.trim());

  const accessToken = await getAccessToken();
  const learned = await loadLearnedAliases();
  const aliases = { ...learned, ...ALIASES };
  const normalized = await normalizeItems(lines, Object.keys(aliases));

  // Line index -> what happens to it.
  const products = []; // { index, productId, quantity, title }
  const toSearch = []; // { index, line, name, quantity, searchTerm }
  normalized.forEach((n, index) => {
    const alias = aliases[n.alias] ?? aliases[n.name];
    if (alias) products.push({ index, productId: alias.productId, quantity: n.quantity, title: alias.title });
    else toSearch.push({ index, line: lines[index], name: n.name, quantity: n.quantity, searchTerm: n.searchTerm });
  });

  // Search a few at a time; a failed search just means "no match".
  const searched = new Array(toSearch.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, toSearch.length) }, async () => {
      while (next < toSearch.length) {
        const i = next++;
        let candidates = [];
        try {
          candidates = await searchProducts(accessToken, toSearch[i].searchTerm);
        } catch (err) {
          console.error(String(err));
        }
        searched[i] = { ...toSearch[i], candidates };
      }
    })
  );
  const choices = await pickBestMatches(searched);

  const picks = [];
  const leftovers = []; // line indexes added as free text
  searched.forEach((it, i) => {
    const c = choices[i];
    if (c) picks.push({ ...it, productId: c.productId, title: c.title, price: c.price });
    else leftovers.push(it.index);
  });

  const confirmed = picks.length > 0 ? await review(picks) : [];
  if (confirmed === null) {
    await showSummary("Cancelled", ["Nothing was added."]);
    return;
  }
  const confirmedSet = new Set(confirmed);
  for (const p of picks) if (!confirmedSet.has(p)) leftovers.push(p.index);
  for (const p of confirmed) products.push(p);

  // One write for products (order or list), one for free-text leftovers.
  const order = products.length > 0 ? await getActiveOrder(accessToken) : null;
  const listItems = leftovers.map((index) => ({ description: lines[index], quantity: 1 }));
  if (order) {
    await addToOrder(accessToken, order, products);
  } else {
    listItems.push(...products.map((p) => ({ productId: p.productId, description: p.title, quantity: p.quantity })));
  }
  if (listItems.length > 0) await addToShoppingList(accessToken, listItems);

  // Learn the ticked picks, then complete reminders for lines added as products.
  if (confirmed.length > 0) {
    const updated = await loadLearnedAliases();
    for (const p of confirmed) updated[p.name] = { productId: p.productId, title: p.title };
    fm.writeString(LEARNED_PATH, JSON.stringify(updated, null, 2));
  }
  for (const p of products) {
    reminders[p.index].isCompleted = true;
    reminders[p.index].save();
  }

  await showSummary("Done", [
    `${products.length} item${products.length === 1 ? "" : "s"} added to ${order ? "your open order" : "your AH shopping list"} — reminders completed.`,
    leftovers.length > 0
      ? `Left on the AH shopping list as text (reminders kept open):\n${leftovers.map((i) => `• ${lines[i]}`).join("\n")}`
      : "",
  ]);
}

try {
  await main();
} catch (err) {
  console.error(String(err));
  await showSummary("Something went wrong", [String(err)]);
}
Script.complete();
