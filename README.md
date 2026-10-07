# ah-cart-sync

Add items from a shared Reminders list to your Albert Heijn order or shopping list with one
tap on your phone.

**How it works:** a [Scriptable](https://scriptable.app) script on your iPhone reads the
shared Reminders list. Each line is matched against your aliases (the line itself first,
then Claude's reading of messier lines like "2 x big portobellos"). Everything else is
searched on AH and Claude picks a product, which you tick or untick in a review list.
Items go to your open order if there is one, otherwise to your AH shopping list; unmatched
or unticked lines go on the AH shopping list as free text. Reminders for lines added as
products are marked completed; the rest stay open. Ticked picks are remembered as aliases,
so the review list shrinks week by week.

It runs on the phone, not a server, because AH's bot protection (Akamai) blocks requests
from cloud servers. It talks to AH's private mobile-app API directly (reverse-engineered by
[appie-go](https://github.com/gwillem/appie-go)); Claude only reads lines and picks
products.

## 1. AH login (get a refresh token)

On a Mac with Go installed:

```bash
git clone https://github.com/gwillem/appie-go && cd appie-go
go build -o appie ./cmd/appie
./appie login                                         # opens the browser to log in
jq -r .refresh_token ~/.config/appie/config.json | pbcopy
```

With Universal Clipboard the token is now pasteable on your iPhone. Don't run other
`appie` commands afterwards: they can refresh the token on the Mac and invalidate the
phone's copy.

## 2. Install the script

1. Install **Scriptable** from the App Store.
2. In Finder, **⌥ Option-drag** `scriptable/AH Cart Sync.js` into iCloud Drive → Scriptable
   (Option copies; a plain drag into iCloud Drive *moves* the file out of the repo).
3. Run it in Scriptable. The first run asks for the Reminders list name, your Anthropic API
   key and the AH refresh token, and stores them in the iOS Keychain. Allow Reminders access.

For one-tap use add it to the home screen via a Scriptable widget or a one-action
Shortcut ("Run Script"), or ask Siri: "AH Cart Sync".

If AH ever refuses the token ("AH login expired"), the script asks for a new one: repeat
step 1 and paste it.

## 3. Aliases and preferences

Pinned aliases live at the top of the script (`ALIASES`): lowercase item name → exact AH
product. To find a `productId`, open the product on ah.nl; the URL has `wi<number>` — drop
the `wi`. Pinned aliases always win.

Picks you tick in the review list are saved as **learned aliases** in
`ah-cart-sync-aliases.json` next to the script (iCloud Drive → Scriptable), so you only
need to pin the ones you want to force or correct.

Edit the script in one place only — either here (then Option-drag it over again) or in the
Scriptable editor on the phone — or the two copies drift.

`PREFERENCES` (plain English) steers Claude's picks, e.g. own-brand and organic unless a
premium brand is on bonus.
