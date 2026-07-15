import * as odoo from "./odoo-client.js";
import "dotenv/config";
try {
  console.log("configured:", odoo.isConfigured());
  const orders = await odoo.searchRead(
    "sale.order",
    [["company_id","=",12]],
    ["id","name","partner_id","company_id","state","user_id","team_id","warehouse_id","currency_id","date_order","amount_total"],
    { limit: 2, order: "id desc" }
  );
  console.log("=== ORDERS ===");
  console.log(JSON.stringify(orders, null, 2));
  if (orders[0]) {
    const lines = await odoo.searchRead(
      "sale.order.line",
      [["order_id","=", orders[0].id]],
      ["id","product_id","name","product_uom_qty","price_unit","tax_id","company_id"],
      { limit: 3 }
    );
    console.log("=== LINES ===");
    console.log(JSON.stringify(lines, null, 2));
  }
} catch (e) { console.error("ERR", e.message, e.stack); }
