# ah-cart-sync — glossary

- **Line** — one raw reminder title as someone typed it ("4 x bratwurst", "Brocolli").
- **Normalise** — one Claude call turning every line into a quantity, a canonical English
  *name* and a Dutch AH *search term*.
- **Alias** — lowercase item name → exact AH product. Either *pinned* (`ALIASES` in the
  script, wins) or *learned* (stored in `ah-cart-sync-aliases.json` when you tick a pick).
- **Pick** — Claude's choice of AH product for a line with no alias. Always reviewed.
- **Review list** — the tick-list of Claude's picks shown by the script; ticked picks are
  added and learned as aliases, unticked ones become leftovers.
- **Destination** — where products go: the open *order* if one exists, else the AH
  *shopping list* ("Mijn lijst").
- **Leftover** — a line added to the AH shopping list as free text (unmatched or unticked).
  Its reminder stays open.
