import {all, byIds} from "./baifa-client-sync.js";

const id = v => Array.isArray(v) ? v[0] : v;
const validId = n => Number.isSafeInteger(n) && n > 0;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const states = new Set(["not_paid","in_payment","paid","partial","reversed","invoicing_legacy"]);
const amounts = ["subtotal","tax","total"];

// Whole posted documents, unlike the separate equipment-line/fiscal subset.
// The scope is fixed to the same company/branch as Generators Finance.
export function summarizeUnitClose(moves, currencies, range) {
  const currencyMap = new Map();
  for (const c of currencies) {
    check(validId(c.id) && /^[A-Z]{3}$/.test(c.name) && Number.isInteger(c.decimal_places) &&
      c.decimal_places >= 0 && c.decimal_places <= 6 && !currencyMap.has(c.id), "Moneda de unidad inválida.");
    currencyMap.set(c.id,c);
  }
  const unique = new Map(), buckets = new Map(), clients = new Set();
  let invoiceCount=0, postedInvoiceCount=0, reversedInvoiceCount=0, creditNoteCount=0;
  for (const m of moves) {
    const currency = currencyMap.get(id(m.currency_id));
    check(validId(m.id) && id(m.company_id)===12 && id(m.branch_id)===41 && m.state==="posted" &&
      ["out_invoice","out_refund"].includes(m.move_type) && typeof m.invoice_date==="string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(m.invoice_date) && m.invoice_date>=range.from && m.invoice_date<=range.until,
      "Documento fuera del alcance de la unidad.");
    check(currency && typeof m.name==="string" && m.name.trim() && validId(id(m.partner_id)) &&
      Array.isArray(m.partner_id) && typeof m.partner_id[1]==="string" && states.has(m.payment_state),
      "Documento de unidad incompleto.");
    const row = {invoiceId:m.id,companyId:12,branchId:41,invoice:m.name,date:m.invoice_date,type:m.move_type,
      partnerId:id(m.partner_id),client:m.partner_id[1],paymentState:m.payment_state,
      currencyId:currency.id,currency:currency.name,digits:currency.decimal_places,
      subtotal:m.amount_untaxed,tax:m.amount_tax,total:m.amount_total};
    const minor = {};
    for (const key of amounts) {
      const v=row[key], scaled=v*10**row.digits, rounded=Math.round(scaled);
      check(typeof v==="number" && Number.isFinite(v) && Number.isSafeInteger(rounded) &&
        Math.abs(scaled-rounded)<0.000001, "Importe de unidad no verificable.");
      minor[key]=rounded;
    }
    check(Number.isSafeInteger(minor.subtotal+minor.tax) && minor.subtotal+minor.tax===minor.total,
      "Subtotal, impuestos y total no concilian.");
    const prior=unique.get(m.id);
    if (prior) { check(JSON.stringify(prior)===JSON.stringify(row),"Documento duplicado contradictorio."); continue; }
    unique.set(m.id,row);
    if (!buckets.has(currency.id)) buckets.set(currency.id,{
      currencyId:currency.id,currency:currency.name,digits:row.digits,
      postedInvoiced:0,postedTax:0,postedTotal:0,invoiced:0,tax:0,total:0,
      reversedInvoiced:0,reversedTax:0,reversedTotal:0,credited:0,creditedTax:0,creditedTotal:0,
    });
    const b=buckets.get(currency.id);
    const add = fields => fields.forEach((f,i)=>{
      b[f]+=minor[amounts[i]];check(Number.isSafeInteger(b[f]),"Total de unidad fuera de precisión segura.");
    });
    if (m.move_type==="out_refund") { creditNoteCount++;add(["credited","creditedTax","creditedTotal"]); }
    else {
      postedInvoiceCount++;add(["postedInvoiced","postedTax","postedTotal"]);
      if (m.payment_state==="reversed") { reversedInvoiceCount++;add(["reversedInvoiced","reversedTax","reversedTotal"]); }
      else { invoiceCount++;clients.add(row.partnerId);add(["invoiced","tax","total"]); }
    }
  }
  const totals=[...buckets.values()].sort((a,b)=>a.currency.localeCompare(b.currency)||a.currencyId-b.currencyId).map(b=>{
    const {currencyId,currency,digits,...values}=b;
    values.net=values.postedInvoiced-values.credited;
    values.netTax=values.postedTax-values.creditedTax;
    values.netTotal=values.postedTotal-values.creditedTotal;
    check(Object.values(values).every(Number.isSafeInteger),"Neto de unidad fuera de precisión segura.");
    return {currencyId,currency,digits,...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v/10**digits]))};
  });
  return {schemaVersion:1,scope:"unit-branch",companyId:12,branchId:41,
    invoiceCount,postedInvoiceCount,reversedInvoiceCount,creditNoteCount,clientCount:clients.size,
    totals,rows:[...unique.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.invoiceId-b.invoiceId)};
}

export async function loadUnitClose(odoo, range, verifiedCompanies) {
  check(verifiedCompanies.some(c=>c.id===12),"Compañía de la unidad no verificada.");
  const context={allowed_company_ids:[12]};
  const moves=await all(odoo,"account.move",[
    ["company_id","=",12],["branch_id","=",41],["state","=","posted"],
    ["move_type","in",["out_invoice","out_refund"]],
    ["invoice_date",">=",range.from],["invoice_date","<=",range.until],
  ],["id","name","company_id","branch_id","state","move_type","invoice_date","partner_id",
    "currency_id","payment_state","amount_untaxed","amount_tax","amount_total"],10000,context);
  check(moves.every(m=>validId(id(m.currency_id))),"Moneda ausente en documento de unidad.");
  const currencies=await byIds(odoo,"res.currency",moves.map(m=>id(m.currency_id)),["id","name","decimal_places"],context);
  return summarizeUnitClose(moves,currencies,range);
}
