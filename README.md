# ah-cart-sync

Add items from a shared Reminders list to your Albert Heijn cart (next delivery) with one
tap on your phone.

**How it works:** an iOS Shortcut reads your shared Reminders list, sends the item names to
a small Cloudflare Worker, which resolves each name to an AH product — a hand-picked alias
map first, falling back to Claude (translating the name and picking the best match against
your standing preferences) — and adds it directly to your active order.

This talks to Albert Heijn's private mobile-app API directly (reverse-engineered by the
[appie-go](https://github.com/gwillem/appie-go) project); the LLM is only used for the
translate/match step on unmapped items, not for driving the automation itself.

## 1. One-time AH login (get a refresh token)

We reuse [ah-mcp](https://github.com/mrserzhan/ah-mcp) purely to do the interactive OAuth
login once — no need to reimplement its browser/redirect-proxy trick.

```bash
git clone https://github.com/mrserzhan/ah-mcp
cd ah-mcp
go build -o ah-mcp .
./ah-mcp --transport sse   # starts a local MCP server on :3000, opens no browser yet
```

In another terminal, connect to it with the official MCP inspector and call `ah_login`:

```bash
npx @modelcontextprotocol/inspector
```

- Open the inspector UI (it prints a URL), connect to `http://localhost:3000/sse` (SSE
  transport).
- Find the `ah_login` tool and run it. Your browser opens — log in with your AH account.
- Tokens are now saved at `~/Library/Application Support/ah-mcp/tokens.json` (macOS).

You can stop the `ah-mcp` server after this — it's not needed again.

## 2. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login                        # if you haven't already
npx wrangler kv namespace create AH_TOKENS
```

Copy the returned `id` into `wrangler.toml` (`AH_TOKENS` binding).

Seed the refresh token into KV from the tokens file saved in step 1:

```bash
REFRESH=$(jq -r .refresh_token ~/Library/Application\ Support/ah-mcp/tokens.json)
npx wrangler kv key put --binding=AH_TOKENS tokens \
  "{\"access_token\":\"\",\"refresh_token\":\"$REFRESH\",\"expires_at\":0}"
```

(`expires_at: 0` forces the Worker to refresh on its very first request.)

Set a secret the Shortcut will send as a bearer token — pick any long random string:

```bash
npx wrangler secret put SYNC_SECRET
```

Set your Anthropic API key (used to translate item names and pick the best product match
for anything not in `aliases.ts` — see step 3):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Deploy:

```bash
npx wrangler deploy
```

Note the deployed URL (e.g. `https://ah-cart-sync.<you>.workers.dev`).

## 3. Add your favourite product mappings

Edit `worker/src/aliases.ts` — for each ambiguous or frequently-used item name, look up the
exact product on ah.nl (the number in the URL, e.g. `ah.nl/producten/product/wi123456/...`,
is the `webshopId`) and add it:

```ts
export const ALIASES: Record<string, { productId: number; title: string }> = {
  hummus: { productId: 123456, title: "Maza Hummus Naturel 350g" },
  melk: { productId: 234567, title: "AH Halfvolle Melk 1L" },
};
```

Redeploy with `npx wrangler deploy` after editing. Anything not in `aliases.ts` is resolved
by Claude instead: it translates the item name into a Dutch AH search term, then picks the
best match from the actual search results using the standing preferences in
`worker/src/preferences.ts` (e.g. "prefer own-brand and organic, unless a premium brand is
on bonus"). Edit that file in plain English — no schema to follow. This costs a small
Anthropic API call per unmapped item; anything you have a strong opinion on is still more
reliable pinned exactly in `aliases.ts`, which skips the LLM (and the cost) entirely.

## 4. Build the iOS Shortcut

Use a shared **Reminders** list instead of a Note — Shortcuts gives structured access to
reminder items and a native "mark complete" action, instead of having to parse and rewrite
free-text note contents.

Create a new Shortcut with these actions, in order:

1. **Get Reminders** from List `<your shared list name>` — set "Include: only if not
   completed".
2. **Get Details of Reminders** → *Title*, to turn the reminders into a plain list of
   item-name strings.
3. **Get Contents of URL**:
   - URL: `https://ah-cart-sync.<you>.workers.dev/sync`
   - Method: POST
   - Headers: `Authorization: Bearer <your SYNC_SECRET>`, `Content-Type: application/json`
   - Request Body (JSON): `{ "items": <the list from step 2> }`
4. **Show Notification** with the response (e.g. `Get Value for "results"` and show it), so
   you see what was added / not found.
5. **Complete Reminders** — pass it the reminders list from step 1, so they're marked done
   and won't resync next run. (Use **Delete Reminders** instead if you'd rather they
   disappear entirely.)

Long-press the Shortcut → **Add to Home Screen** so it's a one-tap icon.

## Amending an already-placed order

If you've already submitted this week's delivery order, there's no unsubmitted cart to add
to — the Worker detects this and automatically reopens the upcoming order for editing (the
same as tapping "Amend" in the app), adds the items, then resubmits it.

**This is riskier than the rest of the tool**: the reopen/resubmit calls are reverse-engineered
from `appie-go` and marked "unconfirmed" by its own author — they're not verified against
the live API by anyone. If resubmitting fails after a successful reopen, the Worker will not
silently hide it: the response includes a top-level `"warning"` field telling you to check
the AH app, and the Shortcut's notification will show it. Check the app after your first few
syncs that hit this path, to make sure the order looks right before trusting it blindly.