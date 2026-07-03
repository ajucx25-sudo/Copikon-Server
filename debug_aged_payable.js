// Debug: extraer y analizar el HTML crudo del Aged Payable de Odoo
const OdooClient = require('./odoo-client');
require('dotenv').config();

async function main() {
  const client = new OdooClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await client.authenticate();

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

  const html = await client.execute("account.aged.payable", "get_html", [[], options], { context: { allowed_company_ids: [12] } });
  require('fs').writeFileSync('/home/user/workspace/aged_payable_raw.html', html);

  // Extraer TODAS las celdas de valor
  const pattern = /o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)\s*</g;
  const matches = [...html.matchAll(pattern)].map(m => m[1]);
  console.log("Total celdas value:", matches.length);
  console.log("Últimas 20 celdas:", matches.slice(-20));

  // Buscar los rótulos de fila (para entender la estructura)
  // Extraer filas <tr> con partner y sus celdas
  const rowRegex = /<tr[^>]*class="[^"]*o_account_report_line[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [...html.matchAll(rowRegex)];
  console.log("Total rows account_report_line:", rows.length);

  // Buscar el total y las filas de "Total ..."
  const totalMatches = [...html.matchAll(/Total[\s\S]{0,60}?o_account_report_column_value">\s*\$?\s*([\-\d\.,]+)/g)];
  console.log("Total rows found:", totalMatches.length);
  console.log("Total values:", totalMatches.slice(0,5).map(m => m[1]));
}

main().catch(e => { console.error(e); process.exit(1); });
