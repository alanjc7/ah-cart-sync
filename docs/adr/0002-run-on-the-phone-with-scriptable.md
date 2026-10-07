# 2. Run on the phone with Scriptable, retire the Cloudflare Worker

Date: 2026-10-07 · Status: accepted

## Context

AH's API sits behind Akamai bot protection, which returned "Access Denied" (403) to the
Cloudflare Worker — first after bursts of calls, then persistently, even a day later with a
short list. The same calls succeed from a residential connection. There is no always-on
device at home to relay through, and the Shortcuts editor was painful to maintain.

## Decision

Move the whole flow into one Scriptable script on the iPhone: read Reminders, normalise
and pick with Claude, review in a native tick-list, write to AH from the phone's own
connection, and mark completed the reminders added as products. Delete the Worker.

## Consequences

- AH requests come from the phone, like the real app's; no server, cron or KV.
- Secrets live in the iOS Keychain; learned aliases in a JSON file in iCloud Drive.
- No cron keeps the AH token fresh. If it expires between weekly runs, the script asks for
  a new one (re-login with `appie login` on a Mac).
- Reminders can be completed directly, which the web review page could not do.
- No automated tests; the script depends on Scriptable's runtime APIs.
