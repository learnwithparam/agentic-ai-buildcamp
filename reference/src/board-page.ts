// The board at localhost:7702/board: Done (the ledger agrees), Needs you, Refused, and cost per
// invoice settled. The page asks /board/data every 1.5 seconds and draws the columns again.
export const boardPage = (employee: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Freight audit board</title>
<style>
:root { --bg:#f4f5f2; --card:#fff; --ink:#1d2321; --muted:#5d6763; --line:#dcdfd9;
  --done:#1f7a4d; --need:#a35b00; --ref:#b42318; --work:#3557a7; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#131615; --card:#1c201e; --ink:#e7ebe8; --muted:#9aa5a0; --line:#2e3431;
    --done:#4cc38a; --need:#f0a24a; --ref:#ff7b6e; --work:#8fb0ff; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:20px 24px 4px; display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end;
  justify-content:space-between; }
h1 { font-size:20px; margin:0; } header p { margin:2px 0 0; color:var(--muted); }
.kpis { display:flex; gap:10px; flex-wrap:wrap; }
.kpi { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 14px; }
.kpi b { display:block; font-size:20px; font-variant-numeric:tabular-nums; }
.kpi span { font-size:12px; color:var(--muted); }
.kpi.main b { color:var(--done); }
.cols { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:14px;
  padding:16px 24px 24px; }
@media (max-width: 760px) { .cols { grid-template-columns:1fr; } }
.col h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; margin:0 0 8px;
  display:flex; gap:8px; align-items:center; }
.col h2 i { width:10px; height:10px; border-radius:50%; display:inline-block; }
.card { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--muted);
  border-radius:8px; padding:10px 12px; margin-bottom:10px; }
.card b { display:block; } .card p { margin:4px 0 0; color:var(--muted); font-size:13px; }
.Done .card { border-left-color:var(--done); } .Needs .card { border-left-color:var(--need); }
.Refused .card { border-left-color:var(--ref); }
.empty { color:var(--muted); font-size:13px; }
</style></head><body>
<header><div><h1>Freight audit board</h1>
<p>Signed in as ${employee}. A card is Done only when the ledger agrees.</p></div>
<div class="kpis" id="kpis"></div></header>
<div class="cols" id="cols"></div>
<script>
function usd(amount, digits = 6) {
  return amount == null ? "None settled yet" : "USD " + Number(amount).toFixed(digits);
}
const COLOUR_OF_COLUMN = { Done: "done", Refused: "ref", "Needs you": "need" };

function kpiHtml([kind, value, label]) {
  return '<div class="kpi ' + kind + '"><b>' + value + '</b><span>' + label + '</span></div>';
}

function cardHtml(job) {
  const title = job.summary ?? job.input.invoice_id;
  return '<div class="card"><b>' + title + '</b><p>' + (job.reason ?? "") + '</p></div>';
}

function columnHtml(name, jobs, working) {
  let cards = '<div class="empty" data-empty-state>No invoices in this column yet. ' +
    'Run <code>bun run reference</code> to add some.</div>';
  const noun = working === 1 ? " invoice" : " invoices";
  const progress = working + noun + " in progress";
  if (working && name === "Done") cards = '<div class="empty">' + progress + "</div>";
  if (jobs.length) cards = jobs.map(cardHtml).join("");
  const dot = '<i style="background:var(--' + COLOUR_OF_COLUMN[name] + ')"></i>';
  const heading = '<h2>' + dot + name + ' (' + jobs.length + ')</h2>';
  return '<section class="col ' + name.split(" ")[0] + '">' + heading + cards + '</section>';
}

async function load() {
  const data = await fetch("/board/data").then((response) => response.json()).catch(() => null);
  if (!data) return;
  const tenants = data.board.tenants;
  const outcomes = tenants.reduce((total, tenant) => total + tenant.outcomes, 0);
  const spend = tenants.reduce((total, tenant) => total + tenant.spend_usd, 0);
  const kpis = [
    ["main", usd(outcomes ? spend / outcomes : null), "Cost per invoice settled"],
    ["", outcomes, "Invoices settled"],
    ["", usd(spend), "Model spend"],
  ];
  document.getElementById("kpis").innerHTML = kpis.map(kpiHtml).join("");
  const columns = { Done: [], "Needs you": [], Refused: [] };
  for (const job of data.jobs) {
    const column = job.column ?? (job.status === "working" ? null : "Needs you");
    if (column && columns[column]) columns[column].push(job);
  }
  const working = data.jobs.filter((job) => job.status === "working").length;
  const sections = Object.entries(columns).map(([name, jobs]) => columnHtml(name, jobs, working));
  document.getElementById("cols").innerHTML = sections.join("");
}
load(); setInterval(load, 1500);
</script></body></html>`;
