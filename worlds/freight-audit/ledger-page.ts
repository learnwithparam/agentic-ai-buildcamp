// The small page at localhost:7700/ledger. It reads /api/ledger every two seconds, so you watch writes land.
export const ledgerPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KaaS Freight ledger</title>
<style>
:root { --bg:#f7f7f4; --card:#fff; --ink:#1d2321; --muted:#5d6763; --line:#dcdfd9; --open:#5d6763; --paid:#1f7a4d; --disp:#a35b00; --bad:#b42318; --badbg:#fde7e4; }
@media (prefers-color-scheme: dark) { :root { --bg:#141716; --card:#1c201e; --ink:#e7ebe8; --muted:#9aa5a0; --line:#2e3431; --open:#9aa5a0; --paid:#4cc38a; --disp:#f0a24a; --bad:#ff7b6e; --badbg:#3a1d1a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:20px 24px 8px; } h1 { font-size:20px; margin:0 0 4px; } header p { margin:0; color:var(--muted); }
.stats { display:flex; gap:12px; padding:12px 24px; flex-wrap:wrap; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; min-width:110px; }
.stat b { display:block; font-size:22px; } .stat span { color:var(--muted); font-size:12px; }
.wrap { padding:0 24px 24px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { font-size:12px; color:var(--muted); font-weight:600; } td.num { text-align:right; font-variant-numeric:tabular-nums; }
.s { font-weight:600; } .s.open { color:var(--open); } .s.paid { color:var(--paid); } .s.disputed { color:var(--disp); }
tr.twice td { background:var(--badbg); } tr.twice .s { color:var(--bad); }
</style></head><body>
<header><h1>KaaS Freight ledger</h1><p>The system of record. Rows change only through the world's tools. This page refreshes every two seconds.</p></header>
<div class="stats" id="stats"></div>
<div class="wrap"><table><thead><tr><th>Invoice</th><th>Tenant</th><th>Carrier</th><th>Load</th><th style="text-align:right">Total</th><th>Status</th><th style="text-align:right">Payments</th><th>Paid</th><th>Dispute</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const usd = (n) => "USD " + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function load() {
  const rows = await fetch("/api/ledger").then((r) => r.json()).catch(() => null);
  if (!rows) return;
  const c = { open: 0, paid: 0, disputed: 0 }; let twice = 0;
  for (const r of rows) { c[r.status]++; if (r.payments.length > 1) twice++; }
  document.getElementById("stats").innerHTML = [["Invoices", rows.length], ["Open", c.open], ["Paid", c.paid], ["Disputed", c.disputed], ["Paid twice", twice]]
    .map(([k, v]) => '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>').join("");
  document.getElementById("rows").innerHTML = rows.map((r) => {
    const paid = r.payments.reduce((a, p) => a + p.amount_usd, 0);
    const d = r.disputes[0];
    return '<tr class="' + (r.payments.length > 1 ? "twice" : "") + '"><td>' + r.invoice_id + '</td><td>' + r.tenant + '</td><td>' + r.carrier_id + '</td><td>' + r.load_id +
      '</td><td class="num">' + usd(r.total_usd) + '</td><td class="s ' + r.status + '">' + (r.payments.length > 1 ? "paid twice" : r.status) +
      '</td><td class="num">' + r.payments.length + '</td><td>' + (paid ? usd(paid) : "") + '</td><td>' + (d ? d.reason_code : "") + '</td></tr>';
  }).join("");
}
load(); setInterval(load, 2000);
</script></body></html>`;
