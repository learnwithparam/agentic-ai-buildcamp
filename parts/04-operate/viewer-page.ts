// The trace viewer at localhost:7703: every run in the replay set,
// and the spans of the one you pick.
export const viewerPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace viewer</title>
<style>
:root {
  --bg:#f4f5f2; --card:#fff; --ink:#1d2321; --muted:#5d6763; --line:#dcdfd9;
  --done:#1f7a4d; --need:#a35b00; --ref:#b42318; --sel:#e8eefb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#131615; --card:#1c201e; --ink:#e7ebe8; --muted:#9aa5a0; --line:#2e3431;
    --done:#4cc38a; --need:#f0a24a; --ref:#ff7b6e; --sel:#22304a;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--bg); color:var(--ink);
  font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { padding:18px 24px 6px; }
h1 { font-size:20px; margin:0; }
header p { margin:2px 0 0; color:var(--muted); }
main {
  display:grid; grid-template-columns:minmax(0, 380px) minmax(0, 1fr);
  gap:14px; padding:12px 24px 24px;
}
@media (max-width: 800px) { main { grid-template-columns:1fr; } }
.list, .detail { background:var(--card); border:1px solid var(--line); border-radius:8px; }
.list { max-height:76vh; overflow:auto; }
.run {
  display:grid; grid-template-columns:96px 1fr auto; gap:8px; padding:7px 12px;
  border-bottom:1px solid var(--line); cursor:pointer; font-variant-numeric:tabular-nums;
}
.run:hover, .run.sel { background:var(--sel); }
.run code { font-size:12px; color:var(--muted); }
.st { font-size:12px; font-weight:600; }
.done { color:var(--done); }
.waiting_for_human { color:var(--need); }
.stopped, .failed { color:var(--ref); }
.detail { padding:14px 16px; }
.detail h2 { margin:0 0 4px; font-size:16px; }
.detail p { margin:0 0 10px; color:var(--muted); }
.span {
  border-left:3px solid var(--line); padding:4px 10px; margin:4px 0;
  font:12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.span.err { border-left-color:var(--ref); }
.span b { font-weight:600; }
.span .a { color:var(--muted); word-break:break-word; }
.ledger {
  margin:10px 0; padding:8px 10px; background:var(--bg); border-radius:6px; font-size:13px;
}
</style></head><body data-audience="staff">
<header><h1>Trace viewer</h1><p>Recorded runs of the invoice clerk, one run per invoice.
Pick a run, read its steps, then label it in labels.csv.</p></header>
<main><div class="list" id="list"></div>
<div class="detail" id="detail"><p>Pick a run from the list to see its steps.</p></div></main>
<script>
const SAFE_CHARACTERS = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>]/g, (character) => SAFE_CHARACTERS[character]);
}

// The span attributes worth reading when you label a run.
const SHOWN_ATTRIBUTES = [
  "gen_ai.tool.name", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
  "x.side_effect", "x.idempotency_key", "x.checker.verdict", "x.policy.rule",
  "x.policy.decision", "x.outcome", "x.model.role", "error.type",
];
let runs = [];

function spanHtml(span) {
  const shown = Object.entries(span.attributes).filter(([name]) => SHOWN_ATTRIBUTES.includes(name));
  const attributes = shown.map(([name, value]) => escapeHtml(name) + "=" + escapeHtml(value));
  let className = "span";
  if (span.status === "error") className = "span err";
  return '<div class="' + className + '"><b>' + escapeHtml(span.name) + "</b> " +
    escapeHtml(span.status) + ' <span class="a">' + attributes.join("  ") + "</span></div>";
}

// One line that says what the ledger holds for this run's invoice.
function ledgerSummary(ledger) {
  if (ledger.payments.length) {
    return ledger.payments.map((payment) => "payment USD " + payment.amount_usd).join(", ");
  }
  if (ledger.disputes.length) {
    const disputes = ledger.disputes.map(
      (dispute) => "dispute " + dispute.reason_code + " USD " + dispute.amount_usd);
    return disputes.join(", ");
  }
  return "No ledger change";
}

function approvalSummary(run) {
  if (!run.approvals.length) return "";
  const approval = run.approvals[0];
  return " &middot; approval " + escapeHtml(approval.status) + " for USD " +
    escapeHtml(approval.amount);
}

function show(index) {
  const run = runs[index];
  const rows = document.querySelectorAll(".run");
  rows.forEach((row, rowIndex) => row.classList.toggle("sel", rowIndex === index));
  const status = '<span class="st ' + escapeHtml(run.status) + '">' + escapeHtml(run.status) +
    "</span>";
  const heading = "<h2>" + escapeHtml(run.run_id) + " &middot; " + escapeHtml(run.invoice_id) +
    " &middot; " + status + "</h2><p>" + escapeHtml(run.reason) + "</p>";
  const ledger = '<div class="ledger">The ledger shows: <b>' +
    escapeHtml(ledgerSummary(run.ledger)) + "</b>" + approvalSummary(run) + "</div>";
  const spans = run.spans.map(spanHtml).join("");
  document.getElementById("detail").innerHTML = heading + ledger + spans;
}

function runRow(run, index) {
  const status = escapeHtml(run.status.replace(/_/g, " "));
  return '<div class="run" data-i="' + index + '"><code>' + escapeHtml(run.run_id) +
    "</code><span>" + escapeHtml(run.invoice_id) + " <small>" + escapeHtml(run.tenant) +
    '</small></span><span class="st ' + escapeHtml(run.status) + '">' + status + "</span></div>";
}

async function load() {
  const response = await fetch("/runs.json");
  runs = await response.json();
  document.getElementById("list").innerHTML = runs.map(runRow).join("");
  for (const row of document.querySelectorAll(".run")) {
    row.onclick = () => show(Number(row.dataset.i));
  }
  // Open the first run that needs a look; if every run is done, open the first one.
  const firstNotDone = runs.findIndex((run) => run.status !== "done");
  if (firstNotDone < 0) show(0);
  else show(firstNotDone);
}

load();
</script></body></html>`;
