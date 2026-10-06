// HTML for the review page the Shortcut opens after /resolve.

export interface PendingPick {
  input: string;
  name: string;
  quantity: number;
  productId: number;
  title: string;
  price: number;
  imageUrl?: string;
}

export interface Run {
  destination: "order" | "list";
  completed: string[]; // lines added as products during resolve
  leftovers: string[]; // lines added as free text during resolve
  picks: PendingPick[];
  committed?: { completed: string[]; leftovers: string[] };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AH cart sync</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e5e5e5; --accent: #00a0e2; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --fg: #eee; --muted: #9a9a9a; --line: #2c2c2c; } }
body { margin: 0; padding: 16px 16px 96px; background: var(--bg); color: var(--fg);
  font: 16px/1.4 -apple-system, system-ui, sans-serif; }
h1 { font-size: 22px; margin: 4px 0 4px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 28px 0 8px; }
p.sub { color: var(--muted); margin: 0 0 8px; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 10px 0; border-bottom: 1px solid var(--line); }
label.pick { display: flex; gap: 12px; align-items: center; }
label.pick input { width: 24px; height: 24px; flex: none; accent-color: var(--accent); }
label.pick img { width: 48px; height: 48px; object-fit: contain; flex: none; background: #fff; border-radius: 6px; }
.line { font-weight: 600; }
.prod { color: var(--muted); font-size: 14px; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  background: var(--bg); border-top: 1px solid var(--line); }
button { width: 100%; padding: 14px; font-size: 17px; font-weight: 600; border: 0; border-radius: 12px;
  background: var(--accent); color: #fff; }
.err { color: #c62828; }
</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function list(title: string, lines: string[], note = ""): string {
  if (lines.length === 0) return "";
  return `<h2>${esc(title)}</h2>${note ? `<p class="sub">${esc(note)}</p>` : ""}<ul>${lines
    .map((l) => `<li>${esc(l)}</li>`)
    .join("")}</ul>`;
}

function where(run: Run): string {
  return run.destination === "order" ? "your open order" : "your AH shopping list";
}

export function renderReview(run: Run, error?: string): Response {
  const picks = run.picks
    .map(
      (p, i) => `<li><label class="pick">
  <input type="checkbox" name="chosen" value="${i}" checked>
  ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="">` : ""}
  <span><span class="line">${esc(p.input)}</span><br>
  <span class="prod">${esc(p.title)} · ×${p.quantity} · €${p.price.toFixed(2)}</span></span>
</label></li>`
    )
    .join("");
  return page(`<h1>Review picks</h1>
<p class="sub">Untick anything wrong — it goes to the AH shopping list as text instead.
Ticked picks are remembered for next time.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post">
<ul>${picks}</ul>
${list(`Already added to ${where(run)}`, run.completed)}
${list("Left on AH shopping list as text", run.leftovers)}
<div class="bar"><button type="submit">Add ticked items</button></div>
</form>`);
}

export function renderDone(run: Run): Response {
  const completed = [...run.completed, ...(run.committed?.completed ?? [])];
  const leftovers = [...run.leftovers, ...(run.committed?.leftovers ?? [])];
  return page(`<h1>Done</h1>
<p class="sub">Products went to ${where(run)}.</p>
${list("Clear these reminders", completed, "Added as products.")}
${list("Keep these reminders open", leftovers, "On the AH shopping list as text — add by hand.")}
${completed.length + leftovers.length === 0 ? `<p>Nothing to add.</p>` : ""}`);
}

export function renderMissing(): Response {
  return page(`<h1>Link expired</h1><p class="sub">Run the shortcut again.</p>`);
}

export function renderError(message: string): Response {
  return page(`<h1>Something went wrong</h1><p class="err">${esc(message)}</p>
<p class="sub">Nothing was reviewed. Check the Worker logs, then run the shortcut again.</p>`);
}
