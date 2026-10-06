# ah-cart-sync

Add items from a shared Reminders list to your Albert Heijn cart (next delivery) with one
tap on your phone.

**How it works:** an iOS Shortcut reads your shared Reminders list and sends the lines to a
small Cloudflare Worker. Claude parses every line in one go (quantity, name, Dutch search
term). Anything matching an alias is added straight away; everything else is searched on AH
and Claude picks a match, which you tick or untick on a review page on your phone before it's
added. Ticked picks are remembered as aliases, so the review list shrinks week by week.
Items go to your open order if there is one, otherwise to your AH shopping list; anything
unmatched or unticked lands on the AH shopping list as free text, to handle by hand.

This talks to Albert Heijn's private mobile-app API directly (reverse-engineered by the
[appie-go](https://github.com/gwillem/appie-go) project); the LLM is only used for the
parse/match steps, not for driving the automation itself.

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

Redeploy with `npx wrangler deploy` after editing. Aliases in `aliases.ts` always win.

You don't *have* to maintain this file: every pick you tick on the review page is
saved as a **learned alias** (in KV) and is added without review from then on. Use
`aliases.ts` to pin a specific product or override a learned one. Standing preferences for
Claude's picks live in `worker/src/preferences.ts` (plain English).

## 4. Build the iOS Shortcut

The Shortcut only collects the list and opens a web page; everything else (review, results)
lives in the Worker, so it never needs editing again. Four actions:

1. **Find Reminders** — tap *Add Filter*: List is `<your shared list>`; add another filter:
   Is Not Completed.
2. **Get Details of Reminders** — set it to *Title*.
3. **Get Contents of URL**
   - URL: `https://ah-cart-sync.<you>.workers.dev/resolve?format=url`
   - Method: POST
   - Headers: `Authorization` = `Bearer <your SYNC_SECRET>`
   - Request Body: JSON, add field `items` (type *Text*) = the *Title* variable from step 2
4. **Open URLs** — input is *Contents of URL* from step 3.

Long-press the Shortcut → **Add to Home Screen** so it's a one-tap icon.

Tapping it opens a review page in Safari: aliased items are already added, and Claude's
picks are listed ticked — untick anything wrong and press **Add ticked items**. The done page
then tells you which reminders to clear (added as products) and which to leave open (put on
the AH shopping list as free text for you to sort out by hand). The page link expires after
a day.

## Tests

```bash
cd worker && npm test
```
