import { odoo } from "./odoo-client.js";

console.log("=== ODOO PARTNER PERMISSION PROBE ===");

// 1) Info del usuario conectado
try {
  const uid = await odoo.execute("res.users", "search_read",
    [[["login", "=", process.env.ODOO_LOGIN]]],
    { fields: ["id", "name", "login", "company_id", "company_ids", "groups_id"], limit: 1 }
  );
  console.log("User:", JSON.stringify(uid, null, 2));

  if (uid?.[0]?.id) {
    const groups = await odoo.execute("res.groups", "read",
      [uid[0].groups_id],
      { fields: ["id", "name", "category_id", "full_name"] }
    );
    console.log("Groups:", JSON.stringify(groups.map(g => g.full_name || g.name), null, 2));
  }
} catch (e) { console.log("[users] ERROR:", e.message); }

// 2) Probar search_read en res.partner
try {
  const c = await odoo.execute("res.partner", "search_count", [[]]);
  console.log("res.partner count (all):", c);
} catch (e) { console.log("[partner count] ERROR:", e.message); }

try {
  const r = await odoo.execute("res.partner", "search_read",
    [[["is_company", "=", true]]],
    { fields: ["id", "name", "vat"], limit: 2 }
  );
  console.log("res.partner sample:", JSON.stringify(r, null, 2));
} catch (e) { console.log("[partner sample] ERROR:", e.message); }

// 3) Probar create en res.partner (dry — solo con check_access_rights)
try {
  const ok = await odoo.execute("res.partner", "check_access_rights",
    ["create"], { raise_exception: false }
  );
  console.log("res.partner check_access_rights(create):", ok);
} catch (e) { console.log("[partner create check] ERROR:", e.message); }

try {
  const ok = await odoo.execute("res.partner", "check_access_rights",
    ["read"], { raise_exception: false }
  );
  console.log("res.partner check_access_rights(read):", ok);
} catch (e) { console.log("[partner read check] ERROR:", e.message); }

// 4) Probar sale.order
try {
  const ok = await odoo.execute("sale.order", "check_access_rights",
    ["create"], { raise_exception: false }
  );
  console.log("sale.order check_access_rights(create):", ok);
} catch (e) { console.log("[sale create check] ERROR:", e.message); }
