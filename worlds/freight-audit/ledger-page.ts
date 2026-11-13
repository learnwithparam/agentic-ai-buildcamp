// The small page at localhost:7700/ledger. It reads /api/ledger every two seconds,
// so you watch writes land.
export const ledgerPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KaaS Freight ledger</title>
<style>
:root {
  --bg:#f7f7f4; --card:#fff; --ink:#1d2321; --muted:#5d6763; --line:#dcdfd9;
  --open:#5d6763; --paid:#1f7a4d; --disp:#a35b00; --bad:#b42318; --badbg:#fde7e4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#141716; --card:#1c201e; --ink:#e7ebe8; --muted:#9aa5a0; --line:#2e3431;
    --open:#9aa5a0; --paid:#4cc38a; --disp:#f0a24a; --bad:#ff7b6e; --badbg:#3a1d1a;
  }
}
* { box-sizing: border-box; }
body {
  margin:0; background:var(--bg); color:var(--ink);
  font:14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { padding:20px 24px 8px; }
h1 { font-size:20px; margin:0 0 4px; }
header p { margin:0; color:var(--muted); }
.stats { display:flex; gap:12px; padding:12px 24px; flex-wrap:wrap; }
.stat {
  background:var(--card); border:1px solid var(--line); border-radius:8px;
  padding:10px 14px; min-width:110px;
}
.stat b { display:block; font-size:22px; }
.stat span { color:var(--muted); font-size:12px; }
.wrap { padding:0 24px 24px; overflow-x:auto; }
table {
  width:100%; border-collapse:collapse; background:var(--card);
  border:1px solid var(--line); border-radius:8px;
}
th, td {
  text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap;
}
th { font-size:12px; color:var(--muted); font-weight:600; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.s { font-weight:600; }
.s.open { color:var(--open); }
.s.paid { color:var(--paid); }
.s.disputed { color:var(--disp); }
tr.twice td { background:var(--badbg); }
tr.twice .s { color:var(--bad); }
</style></head><body>
<header><h1>KaaS Freight ledger</h1><p>Every invoice, payment and dispute,
as the finance team sees it. This page updates every two seconds.</p></header>
<p role="alert" id="problem" hidden style="margin:0 24px;color:var(--bad)">
The ledger did not load. Start the world with <code>bun run world</code>,
then reload this page.</p>
<div class="stats" id="stats"></div>
<div class="wrap"><table><thead><tr>
<th>Invoice</th><th>Tenant</th><th>Carrier</th><th>Load</th><th style="text-align:right">Total</th>
<th>Status</th><th style="text-align:right">Payments</th><th>Paid</th><th>Dispute</th>
</tr></thead><tbody id="rows"></tbody></table></div>
<script>
const money = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const usd = (amount) => "USD " + Number(amount).toLocaleString("en-US", money);

const STATUS_LABEL = { open: "Open", paid: "Paid", disputed: "Disputed" };
const REASON_LABEL = {
  DUPLICATE: "Duplicate invoice",
  ABOVE_RATE: "Rate above the contract",
  DETENTION_UNSIGNED: "Detention not signed for",
  FUEL_ABOVE_CONTRACT: "Fuel charge above the contract",
  OTHER: "Other reason",
};

function cell(text, className) {
  const classAttribute = className ? ' class="' + className + '"' : "";
  return "<td" + classAttribute + ">" + text + "</td>";
}

function statCards(invoices) {
  const counts = { open: 0, paid: 0, disputed: 0 };
  let paidTwice = 0;
  for (const invoice of invoices) {
    counts[invoice.status]++;
    if (invoice.payments.length > 1) paidTwice++;
  }
  const stats = [
    ["Invoices", invoices.length],
    ["Open", counts.open],
    ["Paid", counts.paid],
    ["Disputed", counts.disputed],
    ["Paid twice", paidTwice],
  ];
  const cards = stats.map(([label, value]) =>
    '<div class="stat"><b>' + value + "</b><span>" + label + "</span></div>");
  return cards.join("");
}

function invoiceRow(invoice) {
  const paidTwice = invoice.payments.length > 1;
  const paid = invoice.payments.reduce((total, payment) => total + payment.amount_usd, 0);
  const dispute = invoice.disputes[0];
  const cells = [
    cell(invoice.invoice_id),
    cell(invoice.tenant),
    cell(invoice.carrier_id),
    cell(invoice.load_id),
    cell(usd(invoice.total_usd), "num"),
    cell(paidTwice ? "Paid twice" : STATUS_LABEL[invoice.status], "s " + invoice.status),
    cell(invoice.payments.length, "num"),
    cell(paid ? usd(paid) : ""),
    cell(dispute ? REASON_LABEL[dispute.reason_code] ?? "Other reason" : ""),
  ];
  return '<tr class="' + (paidTwice ? "twice" : "") + '">' + cells.join("") + "</tr>";
}

async function load() {
  const response = await fetch("/api/ledger").catch(() => null);
  const invoices = response ? await response.json().catch(() => null) : null;
  const alertBox = document.getElementById("problem");
  if (!Array.isArray(invoices)) {
    alertBox.hidden = false;
    return;
  }
  alertBox.hidden = true;
  document.getElementById("stats").innerHTML = statCards(invoices);
  document.getElementById("rows").innerHTML = invoices.length
    ? invoices.map(invoiceRow).join("")
    : '<tr data-empty-state><td colspan="9">No invoices yet. ' +
      "Load them with <code>bun run world reset</code>.</td></tr>";
}

load();
setInterval(load, 2000);
</script></body></html>`;
