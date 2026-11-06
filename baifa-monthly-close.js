import {all, byIds, fiscalIdentity, isGenerator, POLICY_VERSION} from "./baifa-client-sync.js";
import {loadUnitClose} from "./baifa-unit-close.js";

const norm = v => String(v || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const id = v => Array.isArray(v) ? v[0] : v;
const validId = v => Number.isSafeInteger(v) && v > 0;
const fail = message => { throw new Error(message); };
const assert = (ok, message) => { if (!ok) fail(message); };
const finite = v => typeof v === "number" && Number.isFinite(v);

export function monthRange(month, now = new Date(), {allowCurrent=false} = {}) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone:"America/Caracas", year:"numeric", month:"2-digit", day:"2-digit",
  }).format(now);
  if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) ||
      month < "2022-01" || month > today.slice(0,7) || (!allowCurrent && month===today.slice(0,7)))
    throw Object.assign(new Error(allowCurrent ? "Selecciona un mes desde enero de 2022 hasta el mes actual." :
      "Selecciona un mes completo desde enero de 2022, anterior al mes actual."), {status:400});
  const [y,m] = month.split("-").map(Number);
  const periodClosed = month < today.slice(0,7);
  return {month, from:`${month}-01`, until:periodClosed ? new Date(Date.UTC(y,m,0)).toISOString().slice(0,10) : today, periodClosed};
}

// A source line can appear more than once due to paging or partner aliases.
// Identical repeats are harmless; contradictory repeats must never be summed.
export function summarizeClose({month, from, until, observedAt, rows, excluded}) {
  const unique = new Map(), currencies = new Map(), invoices = new Set(), credits = new Set(), clients = new Set();
  for (const row of rows) {
    assert(validId(row.companyId) && validId(row.invoiceId) && validId(row.lineId), "Identidad contable inválida.");
    assert(row.date >= from && row.date <= until && ["out_invoice","out_refund"].includes(row.type), "Documento fuera del mes.");
    assert(/^[A-Z]{3}$/.test(row.currency) && Number.isInteger(row.digits) && row.digits >= 0 && row.digits <= 6, "Moneda no verificable.");
    assert(finite(row.quantity) && finite(row.subtotal), "Importe o cantidad ausente.");
    const key = `${row.companyId}:${row.lineId}`;
    const prior = unique.get(key);
    if (prior) { assert(JSON.stringify(prior) === JSON.stringify(row), "Línea duplicada con datos contradictorios."); continue; }
    unique.set(key,row);
    const invoiceKey = `${row.companyId}:${row.invoiceId}`;
    (row.type === "out_invoice" ? invoices : credits).add(invoiceKey);
    clients.add(row.rif);
    const currencyKey = `${row.currencyId}`;
    if (!currencies.has(currencyKey)) currencies.set(currencyKey, {
      currency:row.currency, currencyId:row.currencyId, digits:row.digits,
      invoicedMinor:0, creditedMinor:0, invoicedUnits:0, creditedUnits:0,
    });
    const bucket = currencies.get(currencyKey);
    assert(bucket.currency === row.currency && bucket.digits === row.digits, "Moneda inconsistente.");
    const minor = Math.round(row.subtotal * 10 ** row.digits);
    assert(Number.isSafeInteger(minor), "Importe fuera de precisión segura.");
    assert(Math.abs(row.subtotal * 10 ** row.digits - minor) < 0.000001, "Importe con precisión incompatible con su moneda.");
    const field = row.type === "out_invoice" ? "invoicedMinor" : "creditedMinor";
    bucket[field] += minor;
    assert(Number.isSafeInteger(bucket[field]), "Total fuera de precisión segura.");
    bucket[row.type === "out_invoice" ? "invoicedUnits" : "creditedUnits"] += row.quantity;
  }
  const totals = [...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(b=>{
    const netMinor = b.invoicedMinor - b.creditedMinor;
    assert(Number.isSafeInteger(netMinor), "Neto fuera de precisión segura.");
    return {...b, invoiced:b.invoicedMinor/10**b.digits, credited:b.creditedMinor/10**b.digits,
      net:netMinor/10**b.digits, netUnits:b.invoicedUnits-b.creditedUnits};
  });
  return {
    ok:true, schemaVersion:1, policyVersion:POLICY_VERSION, month, from, until, observedAt,
    complete:!excluded.some(e=>e.reason !== "Uso interno"),
    scope:"Generadores BAIFA completos; documentos contabilizados; subtotal sin IVA; NC por fecha de emisión.",
    invoiceCount:invoices.size, creditNoteCount:credits.size, clientCount:clients.size,
    totals, rows:[...unique.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.invoiceId-b.invoiceId||a.lineId-b.lineId),
    excluded,
  };
}

export async function loadMonthlyClose(odoo, month, now = new Date()) {
  const range = monthRange(month, now, {allowCurrent:true});
  assert(odoo.isConfigured(), "Odoo no configurado.");
  const companies = (await all(odoo,"res.company",[],["id","name","vat"],100)).filter(c=>
    norm(c.vat)==="J294654568" && /^(?:COPIKONCA|COPIKONVENEZUELACA)(?:J294654568)?$/.test(norm(c.name)));
  assert(companies.length > 0 && companies.every(c=>validId(c.id)), "Compañía no verificable.");
  const context = {allowed_company_ids:companies.map(c=>c.id)};
  const fields = await odoo.execute("product.product","fields_get",[],{attributes:["type"]});
  const brand = ["x_studio_marca","x_studio_marca_1"].filter(f=>fields[f]);
  const clauses = [["name","ilike","BAIFA"],...brand.map(f=>[f,"ilike","BAIFA"])];
  const products = (await all(odoo,"product.product",[...Array(clauses.length-1).fill("|"),...clauses],
    ["id","name","default_code","type","categ_id","uom_id",...brand],50000,context)).filter(isGenerator);
  assert(products.length > 0, "No se identificaron generadores BAIFA.");
  const productMap = new Map(products.map(p=>[p.id,p]));
  const lines = await all(odoo,"account.move.line",[
    ["company_id","in",context.allowed_company_ids],["move_id.state","=","posted"],
    ["move_id.move_type","in",["out_invoice","out_refund"]],
    ["move_id.invoice_date",">=",range.from],["move_id.invoice_date","<=",range.until],
    ["product_id","in",products.map(p=>p.id)],
  ],["id","move_id","product_id","product_uom_id","quantity","price_subtotal"],50000,context);
  assert(lines.every(l=>validId(l.id)&&validId(id(l.move_id))), "Identificador de línea inválido.");
  const moves = await byIds(odoo,"account.move",lines.map(l=>id(l.move_id)),
    ["id","name","invoice_date","move_type","state","partner_id","commercial_partner_id","company_id","currency_id"],context);
  const moveMap = new Map(moves.map(m=>[m.id,m]));
  const partnerId = m=>id(m.commercial_partner_id)||id(m.partner_id);
  assert(moves.every(m=>validId(partnerId(m))&&validId(id(m.currency_id))), "Documento sin cliente o moneda.");
  const partners = await byIds(odoo,"res.partner",moves.map(partnerId),["id","name","vat"],context);
  const partnerMap = new Map(partners.map(p=>[p.id,p]));
  const currencies = await byIds(odoo,"res.currency",moves.map(m=>id(m.currency_id)),["id","name","decimal_places"],context);
  const currencyMap = new Map(currencies.map(c=>[c.id,c]));
  const rows = [], exclusions = new Map();
  for (const line of lines) {
    const m = moveMap.get(id(line.move_id)), p = m && partnerMap.get(partnerId(m));
    const product = productMap.get(id(line.product_id)), currency = m && currencyMap.get(id(m.currency_id));
    assert(m?.state==="posted" && context.allowed_company_ids.includes(id(m.company_id)) &&
      ["out_invoice","out_refund"].includes(m.move_type) && typeof m.invoice_date==="string" &&
      m.invoice_date>=range.from && m.invoice_date<=range.until, "Documento fuera del alcance.");
    assert(product && p && typeof p.name==="string" && p.name.trim() && currency, "Documento incompleto.");
    assert(validId(id(product.uom_id)) && id(line.product_uom_id)===id(product.uom_id), "Unidad de medida no verificable.");
    const identity = fiscalIdentity(p);
    const internal = /^USOINTERNOCOPIKON(?:VENEZUELA)?CA(?:J294654568)?$/.test(norm(p.name));
    if (internal || !identity.rif) {
      exclusions.set(p.id,{odooId:p.id,name:p.name,reason:internal?"Uso interno":identity.reason}); continue;
    }
    rows.push({
      companyId:id(m.company_id), invoiceId:m.id, lineId:line.id, invoice:m.name,
      date:m.invoice_date, type:m.move_type, partnerId:p.id, client:p.name, rif:identity.rif,
      productId:product.id, product:line.product_id?.[1]||product.name,
      quantity:line.quantity, subtotal:line.price_subtotal,
      currencyId:currency.id, currency:currency.name, digits:currency.decimal_places,
    });
  }
  return {...summarizeClose({...range,observedAt:new Date().toISOString(),rows,excluded:[...exclusions.values()]}),
    companies:companies.map(c=>({id:c.id,name:c.name})), source:"odoo-live", periodClosed:range.periodClosed};
}

export function registerMonthlyClose(app, {odoo, wrap}) {
  let busy = false;
  app.get("/api/generators/clients/odoo-baifa/monthly-close",wrap(async(req,res)=>{
    // Defense in depth; existing session/role middleware protects the entire prefix.
    res.setHeader("Cache-Control","no-store");
    if (!req.verifiedUser) return res.status(401).json({message:"Se requiere iniciar sesión."});
    if (Object.keys(req.query).some(k=>!["month","scope"].includes(k)) ||
      (req.query.scope!==undefined && req.query.scope!=="unit"))
      return res.status(400).json({message:"Parámetros inválidos."});
    const now = new Date();
    const range = monthRange(req.query.month, now, {allowCurrent:true});
    if (busy) return res.status(409).json({message:"Hay una consulta de cierre en curso. Intenta nuevamente al terminar."});
    busy = true;
    try {
      const result=await loadMonthlyClose(odoo,range.month,now);
      if (req.query.scope==="unit") result.unit=await loadUnitClose(odoo,range,result.companies);
      res.json(result);
    }
    catch { res.status(502).json({message:"No se pudo verificar el cierre completo en Odoo. No se guardó ni modificó ningún dato."}); }
    finally { busy = false; }
  }));
}
