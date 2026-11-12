// The board at localhost:7702/board: Done (the ledger agrees), Needs you, Refused, and cost per invoice settled.
export const boardPage = (employee: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Freight audit board</title>
<style>
:root { --bg:#f4f5f2; --card:#fff; --ink:#1d2321; --muted:#5d6763; --line:#dcdfd9; --done:#1f7a4d; --need:#a35b00; --ref:#b42318; --work:#3557a7; }
@media (prefers-color-scheme: dark) { :root { --bg:#131615; --card:#1c201e; --ink:#e7ebe8; --muted:#9aa5a0; --line:#2e3431; --done:#4cc38a; --need:#f0a24a; --ref:#ff7b6e; --work:#8fb0ff; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:20px 24px 4px; display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end; justify-content:space-between; }
h1 { font-size:20px; margin:0; } header p { margin:2px 0 0; color:var(--muted); }
.kpis { display:flex; gap:10px; flex-wrap:wrap; }
.kpi { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 14px; }
.kpi b { display:block; font-size:20px; font-variant-numeric:tabular-nums; } .kpi span { font-size:12px; color:var(--muted); }
.kpi.main b { color:var(--done); }
.cols { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:14px; padding:16px 24px 24px; }
@media (max-width: 760px) { .cols { grid-template-columns:1fr; } }
.col h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; margin:0 0 8px; display:flex; gap:8px; align-items:center; }
.col h2 i { width:10px; height:10px; border-radius:50%; display:inline-block; }
.card { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--muted); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
.card b { display:block; } .card p { margin:4px 0 0; color:var(--muted); font-size:13px; }
.Done .card { border-left-color:var(--done); } .Needs .card { border-left-color:var(--need); } .Refused .card { border-left-color:var(--ref); }
.empty { color:var(--muted); font-size:13px; }
</style></head><body>
<header><div><h1>Freight audit board</h1><p>Employee: ${employee}. A card is Done only when the ledger agrees.</p></div><div class="kpis" id="kpis"></div></header>
<div class="cols" id="cols"></div>
<script>
const usd = (n, d = 6) => n == null ? "n/a" : "USD " + Number(n).toFixed(d);
async function load() {
  const data = await fetch("/board/data").then((r) => r.json()).catch(() => null);
  if (!data) return;
  const t = data.board.tenants;
  const outcomes = t.reduce((a, x) => a + x.outcomes, 0), spend = t.reduce((a, x) => a + x.spend_usd, 0);
  document.getElementById("kpis").innerHTML = [["main", usd(outcomes ? spend / outcomes : null), "Cost per invoice settled"], ["", outcomes, "Invoices settled"], ["", usd(spend), "Model spend"]]
    .map(([c, v, k]) => '<div class="kpi ' + c + '"><b>' + v + '</b><span>' + k + '</span></div>').join("");
  const cols = { Done: [], "Needs you": [], Refused: [] };
  for (const j of data.jobs) {
    const col = j.column ?? (j.status === "working" ? null : "Needs you");
    if (col && cols[col]) cols[col].push(j);
  }
  const working = data.jobs.filter((j) => j.status === "working").length;
  document.getElementById("cols").innerHTML = Object.entries(cols).map(([name, js]) =>
    '<section class="col ' + name.split(" ")[0] + '"><h2><i style="background:var(--' + (name === "Done" ? "done" : name === "Refused" ? "ref" : "need") + ')"></i>' + name + ' (' + js.length + ')</h2>' +
    (js.length ? js.map((j) => '<div class="card"><b>' + (j.summary ?? j.input.invoice_id) + '</b><p>' + (j.reason ?? "") + '</p></div>').join("") : '<div class="empty">' + (working && name === "Done" ? working + " job(s) working" : "Nothing here") + '</div>') +
    '</section>').join("");
}
load(); setInterval(load, 1500);
</script></body></html>`;
