# ah-cart-sync — glossary

- **Line** — one raw reminder title as someone typed it ("4 x bratwurst", "Brocolli").
- **Normalise** — one Claude call turning every line into a quantity, a canonical English
  *name* and a Dutch AH *search term*.
- **Alias** — canonical name → exact AH product. Either *pinned* (in `aliases.ts`, wins) or
  *learned* (stored in KV when you tick a pick).
- **Pick** — Claude's choice of AH product for a line with no alias. Always reviewed.
- **Resolve** — first request: normalise, add aliased items, search + pick the rest, park
  the picks for review.
- **Commit** — second request: add the ticked picks, learn them as aliases, free-text the rest.
- **Destination** — where products go: the open *order* if one exists, else the AH
  *shopping list* ("Mijn lijst").
- **Leftover** — a line added to the AH shopping list as free text (unmatched, unticked or
  over the search budget). Its reminder stays open.
- **Search budget** — the cap on AH searches per resolve, keeping each request under
  Cloudflare's 50-subrequest limit.
