import {all,byIds} from "./baifa-client-sync.js";
import express from "express";
import {isAdministrator,permissionList} from "./secure-access.js";
export const base="/api/generators/administracion/cuentas-por-cobrar";
const key="adminMaintenance:generatorsAR:v1",ctx={allowed_company_ids:[12]},states=["partial","not_paid"];
const domain=[["company_id","=",12],["branch_id","=",41],["move_type","=","out_invoice"],["state","=","posted"],["payment_state","in",states],["amount_residual",">",0]];
const fields=["id","name","partner_id","invoice_user_id","invoice_date","invoice_date_due","amount_residual","amount_total","currency_id","company_id","branch_id","move_type","state","payment_state"];
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
export const allowed=u=>!!u&&!u.isPartner&&!u.isExternal&&!u.isExternalProvider&&u.providerId==null&&!["partner_externo","tecnico_externo"].includes(u.level)&&(isAdministrator(u)||permissionList(u.moduleAccess).includes("generators-administracion"));
const today=()=>new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"America/Caracas"}).format(new Date());
const validDay=d=>typeof d==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const minor=(n,d)=>Math.round(n*10**d);
export async function invoices(odoo,id){
 const rows=await all(odoo,"account.move",id?[...domain,["id","=",id]]:domain,fields,50000,ctx);
 const currencies=await byIds(odoo,"res.currency",rows.map(r=>r.currency_id?.[0]),["id","name","decimal_places"],ctx);
 return rows.map(r=>{
 const c=currencies.find(c=>c.id===r.currency_id?.[0]);
 if(r.company_id?.[0]!==12||r.branch_id?.[0]!==41||r.move_type!=="out_invoice"||r.state!=="posted"||!states.includes(r.payment_state)||!Number.isFinite(r.amount_residual)||r.amount_residual<=0||!c||!Number.isInteger(c.decimal_places)||c.decimal_places<0||c.decimal_places>6||id&&r.id!==id)fail("No se pudo verificar la cartera de la rama en Odoo.",502);
 return {id:r.id,number:r.name,client:r.partner_id?.[1]||"Por verificar",seller:r.invoice_user_id?.[1]||"Sin asignar",date:r.invoice_date,due:r.invoice_date_due||null,total:r.amount_total,balance:r.amount_residual,currency:c.name,digits:c.decimal_places};
 });
}
export function installments(rows,invoice){
 if(!Array.isArray(rows)||!rows.length||rows.length>120)fail("Ingresa entre 1 y 120 cuotas.");
 let sum=0;
 const result=rows.map(r=>{const n=r?.amount,d=invoice.digits;
 if(!validDay(r?.date)||typeof n!=="number"||!Number.isFinite(n)||n<=0||!Number.isSafeInteger(minor(n,d))||minor(n,d)/10**d!==n)fail("Revisa las fechas, los montos y los decimales de la moneda.");
 sum+=minor(n,d);return {date:r.date,amount:n};});
 if(sum!==minor(invoice.balance,invoice.digits))fail("Las cuotas deben sumar exactamente el saldo vigente de Odoo.",409);
 return result.sort((a,b)=>a.date.localeCompare(b.date));
}
export function view(invoice,plan,legacy,day){
 const changed=!!plan&&(plan.currency!==invoice.currency||minor(plan.balance,invoice.digits)!==minor(invoice.balance,invoice.digits));
 const oldRows=legacy?(legacy.mode==="installments"?(legacy.installments||[]).filter(r=>r.status!=="paid").map(r=>({date:r.date,amount:r.amount})):[{date:legacy.promise_date,amount:legacy.promise_amount}]):[];
 const legacyOk=!!legacy&&legacy.currency===invoice.currency&&oldRows.length>0&&oldRows.every(r=>validDay(r.date)&&Number.isFinite(r.amount)&&r.amount>0)&&oldRows.reduce((s,r)=>s+minor(r.amount,invoice.digits),0)===minor(invoice.balance,invoice.digits);
 const status=legacy?(legacyOk?"Plan en Administración general":"Revisar plan de Administración general"):changed?"Revisar saldo":plan?"Con plan":"Sin plan";
 const rows=legacy?(legacyOk?oldRows:[]):changed?[]:plan?plan.rows:invoice.due?[{date:invoice.due,amount:invoice.balance}]:[];
 const alerts=rows.flatMap((r,i)=>{if(!validDay(r.date))return [];const days=(Date.parse(r.date)-Date.parse(day))/86400000;
 return days<=7?[{...r,days,label:plan||legacy?`Cuota ${i+1}`:"Factura sin plan"}]:[];});
 return {...invoice,status,review:changed||(!!legacy&&!legacyOk),alerts,revision:plan?.revision||0,rows:plan?.rows||[],legacy:!!legacy};
}
const legacyFor=(rows,id)=>rows.find(p=>Number(p.move_id)===id&&p.kind==="ar"&&!["cancelled","paid"].includes(p.status));
export async function assertNoGeneratorsPlan(readCol,p){
 if(p.kind==="ar"&&!["cancelled","paid"].includes(p.status)&&(await readCol(key)).some(plan=>plan.id===Number(p.move_id)))fail("Ya existe un plan activo para esta factura.",409);
}
export function registerReceivables(app,{sessions,odoo,readCol,writeCol,wrap}){
 app.use(base,(req,res,next)=>{res.setHeader("Cache-Control","no-store");sessions.authenticate(req).then(u=>{if(!u)return res.status(401).json({message:"Inicia sesión."});if(!allowed(u))return res.status(403).json({message:"Se requiere acceso a Administración de Generators."});req.verifiedUser=u;next()}).catch(next)});
 app.get(base,wrap(async(_req,res)=>{const [list,plans,legacy]=await Promise.all([invoices(odoo),readCol(key),readCol("paymentPromises")]);const day=today(),map=new Map(plans.map(p=>[p.id,p]));res.json({day,items:list.map(i=>view(i,map.get(i.id),legacyFor(legacy,i.id),day))});}));
 app.use(base,express.json({limit:"24kb"}));
 app.put(`${base}/:id(\\d+)/plan`,wrap(async(req,res)=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0||String(id)!==req.params.id)fail("Factura no válida.");
 const [i]=await invoices(odoo,id);if(!i)fail("La factura ya no está abierta en la rama Generators.",409);
 const plans=await readCol(key),old=plans.find(p=>p.id===id),b=req.body;
 if(legacyFor(await readCol("paymentPromises"),id))fail("Esta factura ya tiene un plan en Administración general.",409);
 if(b?.revision!==(old?.revision||0)||b?.balance!==i.balance||b?.currency!==i.currency)fail("El plan o el saldo cambió. Actualiza la cartera y revisa los importes.",409);
 const rows=installments(b.rows,i),plan={id,revision:(old?.revision||0)+1,rows,currency:i.currency,balance:i.balance,by:req.verifiedUser.id,at:new Date().toISOString()};
 await writeCol(key,[...plans.filter(p=>p.id!==id),plan]);res.json({ok:true,revision:plan.revision});
 }));
}
