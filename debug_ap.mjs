import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import 'dotenv/config';

const ODOO_URL = process.env.ODOO_URL || 'https://www.copikon.com';
const ODOO_DB = process.env.ODOO_DB || 'copikon';
const ODOO_LOGIN = process.env.ODOO_LOGIN;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

async function rpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error).slice(0,300));
  return data.result;
}

const uid = await rpc('common', 'authenticate', [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY, {}]);
console.log("uid:", uid);

const options = {
  date: { date_to: "2026-07-02", filter: "custom", mode: "single", string: "2026-07-02" },
  all_entries: false,
  unfold_all: false,
  unposted_in_period: false,
  partner_ids: null, partner_categories: null,
  analytic_accounts: null, analytic_tags: null,
  journals: [],
  filter_account_type: "payable",
  multi_company: [{ id: 12, name: "COPIKON C.A." }],
};

const html = await rpc('object', 'execute_kw', [
  ODOO_DB, uid, ODOO_API_KEY,
  'account.aged.payable', 'get_html', [[], options],
  { context: { allowed_company_ids: [12] } }
]);

writeFileSync('/home/user/workspace/aged_payable_raw.html', html);
console.log("HTML len:", html.length);

// Extraer las celdas de valor
const pattern = /o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g;
const matches = [...html.matchAll(pattern)].map(m => m[1]);
console.log("Total celdas value:", matches.length);
console.log("Últimas 15 celdas:", matches.slice(-15));

// Buscar filas de "Total"
const totalPattern = /Total[\s\S]{0,200}?<\/tr>/g;
const totalRows = [...html.matchAll(totalPattern)];
console.log("Filas con Total:", totalRows.length);

// Buscar patrón de fila con nombre
const rowPattern = /<tr[^>]*data-id="[^"]*"[^>]*>[\s\S]*?<\/tr>/g;
const rows = [...html.matchAll(rowPattern)];
console.log("Filas data-id:", rows.length);

// Analizar la fila total (última con clase o_account_report_total)
const totalRowMatch = html.match(/<tr[^>]*class="[^"]*o_account_report_total[^"]*"[^>]*>[\s\S]*?<\/tr>/);
if (totalRowMatch) {
  console.log("\n=== FILA TOTAL ===");
  const cellVals = [...totalRowMatch[0].matchAll(/o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g)].map(m => m[1]);
  console.log("Celdas de fila total:", cellVals);
}
