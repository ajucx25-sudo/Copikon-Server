import { createHash } from "node:crypto";
import { financingSchedule,validateQuote } from "./baifa-sales-rules.js";
import { quotedBand,downCents } from "./financing-policy.js";
const fail=message=>{throw Object.assign(Error(message),{status:400});};
export function financeName(r){return Array.isArray(r.productIds)&&r.productIds.length===1&&typeof r.name==="string"&&r.name.length<=500?r.name:"";}
export function financeRows(snapshot){
  if(!snapshot?.ok||snapshot.source!=="odoo-po-invoices"||snapshot.schemaVersion!==1||!snapshot.complete||!Array.isArray(snapshot.rows)||!Number.isFinite(Date.parse(snapshot.observedAt)))throw Object.assign(Error("No se pudo verificar el inventario de Odoo."),{status:503});
  return snapshot.rows.filter(r=>r.available>0||r.pending>0).map(r=>({code:r.code,financeName:financeName(r)}));
}
export function assessFinancing(raw,plan,products,rows=[]){
  if(plan?.mode!=="financiado")return null;
  if(plan.method!=="amortizacion_mensual"||Number(plan.annualRate)!==24||plan.frequency!=="mensual")fail("El financiamiento requiere 24% anual y cuotas mensuales.");
  const q=validateQuote({...raw,items:typeof raw.items==="string"?JSON.parse(raw.items):raw.items});
  const schedule=financingSchedule(q.total/100,plan);
  const pct=Number(plan.initialPct);
  if(plan.initialPct==null||String(plan.initialPct).trim()===""||!Number.isFinite(pct)||pct<0||pct>=100||Math.abs(pct*100-Math.round(pct*100))>1e-7||downCents(q.total,pct)!==schedule.initial)fail("Revisa el porcentaje de inicial y el monto calculado.");
  const band=quotedBand(q.items,products,rows), count=Number(plan.count);
  // Never trust approval metadata from the browser. Bind the decision to this draft's commercial terms.
  const key=createHash("sha256").update(JSON.stringify([q.companyName,q.contactName,q.contactPhone,q.contactEmail,q.total,
    q.items.map(i=>[i.productId,i.concepto,i.qty,i.precio]),band,pct,count,plan.firstDate])).digest("hex");
  return {key,pct,count,initial:schedule.initial/100,band,exception:!band||band.pct!==pct||band.count!==count};
}
export function requireApproval(review,approval){
  if(review?.exception&&review.key!==approval?.key)throw Object.assign(Error("Esta excepción de financiamiento requiere aprobación del CEO. Guarda el borrador para solicitarla."),{status:403});
}
