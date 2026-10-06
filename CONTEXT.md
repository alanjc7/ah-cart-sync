# ah-cart-sync — glossary

- **Line** — one raw reminder title as someone typed it ("4 x bratwurst", "Brocolli").
- **Normalise** — one Claude call turning every line into a quantity, a canonical English
  *name* and a Dutch AH *search term*.
- **Alias** — canonical name → exact AH product. Either *pinned* (in `aliases.ts`, wins) or
  *learned* (stored in KV when you tick a pick).
- **Pick** — Claude's choice of AH product for a line with no alias. Always reviewed.
- **Run** — one tap of the Shortcut; stored in KV for a day under a random id.
- **Resolve** — the Shortcut's request: normalise, add aliased items, search + pick the
  rest, store the run, return the review page link.
- **Review page** — web page for a run; the run id in its URL is its only credential.
- **Commit** — submitting the review page: add the ticked picks, learn them as aliases,
  free-text the rest.
- **Destination** — where products go: the open *order* if one exists, else the AH
  *shopping list* ("Mijn lijst").
- **Leftover** — a line added to the AH shopping list as free text (unmatched, unticked or
  over the search budget). Its reminder stays open.
- **Search budget** — the cap on AH searches per resolve, keeping each request under
  Cloudflare's 50-subrequest limit.
