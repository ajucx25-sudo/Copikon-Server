import {all,byIds} from "./baifa-client-sync.js";
import {allowed} from "./generators-receivables.js";
export const payablesPath="/api/generators/administracion/cuentas-por-pagar";
const ctx={allowed_company_ids:[12]},domain=[["company_id","=",12],["branch_id","=",41],["move_type","=","in_invoice"],["state","=","posted"],["payment_state","in",["not_paid","partial"]],["amount_residual",">",0]];
const fields=["id","name","ref","partner_id","invoice_date","invoice_date_due","amount_total","amount_residual","currency_id","company_id","branch_id","state","payment_state","move_type"];
export async function payables(odoo){
 const bills=await all(odoo,"account.move",domain,fields,50000,ctx);
 const currencies=await byIds(odoo,"res.currency",bills.map(b=>b.currency_id?.[0]),["id","name","decimal_places"],ctx);
 const map=new Map(currencies.map(c=>[c.id,c])),seen=new Set();
 return bills.map(b=>{const c=map.get(b.currency_id?.[0]);if(!Number.isSafeInteger(b.id)||seen.has(b.id)||b.company_id?.[0]!==12||b.branch_id?.[0]!==41||b.move_type!=="in_invoice"||b.state!=="posted"||!["not_paid","partial"].includes(b.payment_state)||!Number.isFinite(b.amount_residual)||b.amount_residual<=0||!Number.isFinite(b.amount_total)||!c?.name||!Number.isInteger(c.decimal_places)||c.decimal_places<0||c.decimal_places>6)throw Error("Datos de facturación no verificables");seen.add(b.id);
 return {id:b.id,number:b.name,reference:b.ref||"",supplier:b.partner_id?.[1]||"Sin proveedor identificado",issued:b.invoice_date||null,due:b.invoice_date_due||null,partial:b.payment_state==="partial",balance:b.amount_residual,total:b.amount_total,currency:c.name,digits:c.decimal_places};});
}
export function registerPayables(app,{odoo,sessions,wrap}){
 app.get(payablesPath,wrap(async(req,res)=>{res.setHeader("Cache-Control","no-store");const user=await sessions.authenticate(req);if(!user)return res.status(401).json({message:"Inicia sesión."});if(!allowed(user))return res.status(403).json({message:"Se requiere acceso a Administración de Generators."});
 const items=await payables(odoo),day=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());res.json({day,items});}));
}
