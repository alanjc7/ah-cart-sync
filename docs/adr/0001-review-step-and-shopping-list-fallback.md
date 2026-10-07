# 1. Review step, shopping-list fallback, no amending placed orders

Date: 2026-10-06 · Status: superseded by 0002 (hosting); review step and fallbacks still apply

## Context

The single `/sync` request failed most weeks on the real 40–50 line list: three
subrequests per unmapped line blew Cloudflare's 50-per-request cap, wrong LLM picks went
into the order unseen, and the cart write required an open order (with an unverified
reopen/resubmit "amend" fallback).

## Decision

- Split into resolve and commit with a review step in between, on a web page served by
  the Worker (not in Shortcuts, which is painful to edit; the Shortcut is a fixed four
  actions). The page has no bearer secret — the unguessable, day-long run id is the
  credential. Aliased items are
  added immediately; every LLM pick is reviewed; ticked picks become learned aliases.
- Batch Claude to two calls per resolve (normalise, pick) and cap AH searches so a request
  stays under 50 subrequests on the free plan.
- Write to the open order if there is one, else the AH shopping list. Unmatched/unticked
  lines go to the shopping list as free text and keep their reminder open.
- Remove the amend path: the list is always synced before ordering.

## Consequences

- Review effort is front-loaded and shrinks as aliases are learned.
- Reminders are cleared by hand from the done page's list; a web page can't edit them.
- Leftover reminders stay open, so their free-text items can be re-added on the next run
  (AH's list read doesn't return free-text descriptions to de-duplicate against).
- Moving off Cloudflare stays the fallback if the cap or AH's 403s keep biting.
