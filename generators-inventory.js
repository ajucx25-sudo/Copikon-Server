import {all, byIds, isGenerator} from "./baifa-client-sync.js";

export const INVENTORY_PATH = "/api/generators/inventory/odoo-stock";
export const isInventoryPath = path => /^\/api\/generators\/inventory(?:\/|$)/i.test(path);
const id = v => Array.isArray(v) ? v[0] : v;
const validId = v => Number.isSafeInteger(v) && v > 0;
const assert = (ok, message) => { if (!ok) throw Error(message); };
const norm = v => String(v || "").normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const quantity = v => {
  assert(typeof v === "number" && Number.isFinite(v) && v >= 0, "Cantidad no verificable.");
  return v;
};
function unique(rows) {
  const seen = new Map();
  for (const row of rows) {
    assert(validId(row.id), "ID inválido.");
    if (seen.has(row.id)) {
      assert(JSON.stringify(seen.get(row.id)) === JSON.stringify(row), "Duplicado contradictorio.");
    } else seen.set(row.id,row);
  }
  return [...seen.values()];
}

// Commercial availability, NOT stock.quant and NOT physical returns.
// Rebuilt from source on each read; never decrement a previously decremented cache.
export function reconcileInventory({products, orders, purchaseLines, invoices, invoiceLines, companyIds, until}) {
  const productMap = new Map(), groups = new Map();
  for (const p of unique(products)) {
    assert(validId(id(p.uom_id)), "Producto sin unidad de medida.");
    const code = typeof p.default_code === "string" ? p.default_code.trim() : "";
    assert(code, "Producto sin código verificable.");
    if (!groups.has(code)) groups.set(code, {
      code, productIds:[], received:0, invoiced:0, creditUnits:0, pending:0, orders:[],
    });
    const group = groups.get(code);
    assert(!group.uomId || group.uomId === id(p.uom_id), "SKU repetido con unidades distintas.");
    group.uomId = id(p.uom_id);
    group.productIds.push(p.id);
    productMap.set(p.id,group);
  }
  const orderMap = new Map(unique(orders).map(o=>[o.id,o]));
  const invoiceMap = new Map(unique(invoices).map(m=>[m.id,m]));
  for (const l of unique(purchaseLines)) {
    const o = orderMap.get(id(l.order_id)), g = productMap.get(id(l.product_id));
    assert(o && g, "Compra incompleta.");
    assert(companyIds.includes(id(o.company_id)) && ["purchase","done"].includes(o.state),
      "PO no confirmada o fuera de compañía.");
    assert(id(l.product_uom) === g.uomId, "Unidad de compra no verificable.");
    const ordered = quantity(l.product_qty), received = quantity(l.qty_received);
    const pending = o.state === "purchase" ? Math.max(0, ordered - received) : 0;
    g.received += received;
    g.pending += pending;
    g.orders.push({orderId:o.id, lineId:l.id, orderName:o.name, state:o.state,
      qtyOrdered:ordered, qtyReceived:received, qtyPending:pending, datePlanned:l.date_planned || null});
  }
  for (const l of unique(invoiceLines)) {
    const m = invoiceMap.get(id(l.move_id)), g = productMap.get(id(l.product_id));
    assert(m && g, "Factura incompleta.");
    assert(companyIds.includes(id(m.company_id)) && m.state === "posted" &&
      ["out_invoice","out_refund"].includes(m.move_type) && typeof m.invoice_date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(m.invoice_date) && m.invoice_date <= until, "Factura fuera del alcance.");
    assert(id(l.product_uom_id) === g.uomId, "Unidad facturada no verificable.");
    const qty = quantity(l.quantity);
    g[m.move_type === "out_refund" ? "creditUnits" : "invoiced"] += qty;
  }
  const rows = [...groups.values()].map(g => {
    for (const field of ["received","pending","invoiced","creditUnits"])
      assert(Number.isFinite(g[field]) && g[field] <= Number.MAX_SAFE_INTEGER, "Cantidad fuera de precisión.");
    const balance = g.received - g.invoiced;
    return {...g, balance, available:Math.max(0,balance), review:balance < 0 || g.creditUnits > 0};
  }).sort((a,b)=>a.code.localeCompare(b.code,"es",{numeric:true}));
  return {rows, reviewCount:rows.filter(r=>r.review).length};
}

export async function loadInventory(odoo, now = new Date()) {
  assert(odoo.isConfigured(),"Odoo no configurado.");
  const until = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  const companies = unique(await all(odoo,"res.company",[],["id","name","vat"],100)).filter(c=>
    norm(c.vat)==="J294654568" && /^(?:COPIKONCA|COPIKONVENEZUELACA)(?:J294654568)?$/.test(norm(c.name)));
  assert(companies.length > 0,"Compañía no verificable.");
  const companyIds = companies.map(c=>c.id), context = {allowed_company_ids:companyIds};
  const fields = await odoo.execute("product.product","fields_get",[],{attributes:["type"]});
  const brands = ["x_studio_marca","x_studio_marca_1"].filter(f=>fields[f]);
  const clauses = [["name","ilike","BAIFA"], ...brands.map(f=>[f,"ilike","BAIFA"]),
    ["default_code","=ilike","TRPE%"], ["default_code","=ilike","VTM%"]];
  const products = unique(await all(odoo,"product.product",[...Array(clauses.length-1).fill("|"),...clauses],
    ["id","name","default_code","type","categ_id","uom_id",...brands],50000,context))
    .filter(p=>isGenerator(p) || (p.type !== "service" && /^(TRPE|VTM)/i.test(p.default_code || "")));
  assert(products.length > 0,"No hay productos verificables.");
  const productIds = products.map(p=>p.id);
  const purchaseLines = await all(odoo,"purchase.order.line",[
    ["company_id","in",companyIds],["order_id.state","in",["purchase","done"]],
    ["product_id","in",productIds],
  ],["id","order_id","product_id","product_qty","qty_received","product_uom","date_planned"],50000,context);
  const orders = await byIds(odoo,"purchase.order",purchaseLines.map(l=>id(l.order_id)),
    ["id","name","state","company_id"],context);
  const invoiceLines = await all(odoo,"account.move.line",[
    ["company_id","in",companyIds],["move_id.state","=","posted"],
    ["move_id.move_type","in",["out_invoice","out_refund"]],["move_id.invoice_date","<=",until],
    ["product_id","in",productIds],
  ],["id","move_id","product_id","product_uom_id","quantity"],50000,context);
  const invoices = await byIds(odoo,"account.move",invoiceLines.map(l=>id(l.move_id)),
    ["id","state","move_type","invoice_date","company_id"],context);
  return {ok:true,schemaVersion:1,source:"odoo-po-invoices",complete:true,until,
    observedAt:new Date().toISOString(),companies:companies.map(c=>({id:c.id,name:c.name})),
    history:"Todo el histórico disponible en Odoo; sin saldo inicial manual.",
    ...reconcileInventory({products,orders,purchaseLines,invoices,invoiceLines,companyIds,until})};
}

export function registerInventory(app,{odoo,wrap}) {
  let running;
  app.get(INVENTORY_PATH,wrap(async(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    if (!req.verifiedUser) return res.status(401).json({message:"Se requiere iniciar sesión."});
    if (Object.keys(req.query).length) return res.status(400).json({message:"Parámetros no permitidos."});
    // Share one in-flight read only, never persist a stale or cross-scope snapshot.
    running ||= loadInventory(odoo).finally(()=>{running = undefined;});
    try { return res.json(await running); }
    catch { return res.status(502).json({message:"No se pudo verificar el histórico completo de PO y facturas en Odoo. No se modificaron datos."}); }
  }));
}
