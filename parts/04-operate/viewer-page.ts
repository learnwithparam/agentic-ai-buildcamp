// The trace viewer at localhost:7703: every run in the replay set, and the spans of the one you pick.
export const viewerPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace viewer</title>
<style>
:root { --bg:#f4f5f2; --card:#fff; --ink:#1d2321; --muted:#5d6763; --line:#dcdfd9; --done:#1f7a4d; --need:#a35b00; --ref:#b42318; --sel:#e8eefb; }
@media (prefers-color-scheme: dark) { :root { --bg:#131615; --card:#1c201e; --ink:#e7ebe8; --muted:#9aa5a0; --line:#2e3431; --done:#4cc38a; --need:#f0a24a; --ref:#ff7b6e; --sel:#22304a; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:18px 24px 6px; } h1 { font-size:20px; margin:0; } header p { margin:2px 0 0; color:var(--muted); }
main { display:grid; grid-template-columns:minmax(0, 380px) minmax(0, 1fr); gap:14px; padding:12px 24px 24px; }
@media (max-width: 800px) { main { grid-template-columns:1fr; } }
.list, .detail { background:var(--card); border:1px solid var(--line); border-radius:8px; }
.list { max-height:76vh; overflow:auto; }
.run { display:grid; grid-template-columns:96px 1fr auto; gap:8px; padding:7px 12px; border-bottom:1px solid var(--line); cursor:pointer; font-variant-numeric:tabular-nums; }
.run:hover, .run.sel { background:var(--sel); }
.run code { font-size:12px; color:var(--muted); }
.st { font-size:12px; font-weight:600; } .done { color:var(--done); } .waiting_for_human { color:var(--need); } .stopped, .failed { color:var(--ref); }
.detail { padding:14px 16px; } .detail h2 { margin:0 0 4px; font-size:16px; } .detail p { margin:0 0 10px; color:var(--muted); }
.span { border-left:3px solid var(--line); padding:4px 10px; margin:4px 0; font:12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.span.err { border-left-color:var(--ref); } .span b { font-weight:600; } .span .a { color:var(--muted); word-break:break-word; }
.ledger { margin:10px 0; padding:8px 10px; background:var(--bg); border-radius:6px; font-size:13px; }
</style></head><body>
<header><h1>Trace viewer</h1><p>The replay set: the clerk in production, one run per invoice. Pick a run, read its spans, then label it in labels.csv.</p></header>
<main><div class="list" id="list"></div><div class="detail" id="detail"><p>Pick a run on the left.</p></div></main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
let runs = [];
function show(i) {
  const r = runs[i];
  document.querySelectorAll(".run").forEach((el, n) => el.classList.toggle("sel", n === i));
  const keep = ["gen_ai.tool.name", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "x.side_effect", "x.idempotency_key", "x.checker.verdict", "x.policy.rule", "x.policy.decision", "x.outcome", "x.model.role", "error.type"];
  const spans = r.spans.map((s) => '<div class="span' + (s.status === "error" ? " err" : "") + '"><b>' + esc(s.name) + '</b> ' + esc(s.status) + ' <span class="a">' +
    Object.entries(s.attributes).filter(([k]) => keep.includes(k)).map(([k, v]) => esc(k) + "=" + esc(v)).join("  ") + '</span></div>').join("");
  const l = r.ledger;
  const ledger = l.payments.length ? l.payments.map((p) => "payment USD " + p.amount_usd).join(", ") : l.disputes.length ? l.disputes.map((d) => "dispute " + d.reason_code + " USD " + d.amount_usd).join(", ") : "no row";
  document.getElementById("detail").innerHTML = '<h2>' + esc(r.run_id) + ' &middot; ' + esc(r.invoice_id) + ' &middot; <span class="st ' + esc(r.status) + '">' + esc(r.status) + '</span></h2><p>' + esc(r.reason) + '</p>' +
    '<div class="ledger">The ledger shows: <b>' + esc(ledger) + '</b>' + (r.approvals.length ? " &middot; approval " + esc(r.approvals[0].status) + " for USD " + esc(r.approvals[0].amount) : "") + '</div>' + spans;
}
fetch("/runs.json").then((x) => x.json()).then((data) => {
  runs = data;
  document.getElementById("list").innerHTML = runs.map((r, i) => '<div class="run" data-i="' + i + '"><code>' + esc(r.run_id) + '</code><span>' + esc(r.invoice_id) + ' <small>' + esc(r.tenant) + '</small></span><span class="st ' + esc(r.status) + '">' + esc(r.status.replace(/_/g, " ")) + '</span></div>').join("");
  document.querySelectorAll(".run").forEach((el) => el.onclick = () => show(Number(el.dataset.i)));
  const first = runs.findIndex((r) => r.status !== "done");
  show(first < 0 ? 0 : first);
});
</script></body></html>`;
