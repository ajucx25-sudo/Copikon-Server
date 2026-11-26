import {createHash} from "node:crypto";
import {loadBaifaCustomers,consolidateCustomers} from "./baifa-client-sync.js";
import {CLIENT_LOCK} from "./client-collection-transactions.js";
import {welcomeAdditions} from "./posventa-welcome.js";

// Private business identifiers are not published in the release manifest.
const approved=[
"f62110904a8a3c5f04a7556337e7799a4abbfcd5d799eba51d14b33a22874100",
"42c08154898cecb8064e95f1458c6a5213822551c4dc699b4b106fb62241915e",
"c9f42e67882667c0a7a72dbcbc721304c6a2d9d556d7ad96a107ee970e06b832",
"99b625162b41bbfb618879fcc73d635a4702be76bf9cbbe2f534548839f91237",
"bfbdc45861714114389406fc8896852496db861a08a5aa42f279667865b417b4",
"6699fab797f6589cf7f0d75a62b2f2632ac76af0a912a300561460288901ab3f",
"5e2249e62c54841f94a6eccc158d450328bcbcaf47ef62cbab798d1b122b9d68",
"4c021571457fb059007b5f68a808ea6ee118ebf7c46d60c6e9a078f3007eeddc"];
const key="adminMaintenance:posventaWelcomesV1",marker=key+":approvedEight:20261126";
export const fingerprintWelcome=(company,invoice,date,sku)=>createHash("sha256").update(JSON.stringify([company,invoice,date,sku])).digest("hex");
const norm=x=>String(x||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
export function planApprovedWelcomes({customers,clients,equipment,history,now,manifest=approved}){
 const additions=[],skipped=[];
 for(const target of manifest){
   const matches=customers.flatMap(c=>c.sales.filter(l=>fingerprintWelcome(l.companyId,l.invoice,l.date,/^\[([^\]]+)\]/.exec(l.product)?.[1])===target).map(l=>[c,l]));
   if(matches.length!==1)throw Error("Factura no verificable o ambigua.");
   const [c,l]=matches[0],expected=`odoo:12:${l.invoiceId}:${l.lineId}:1`;
   if(c.credits.length||l.companyId!==12||l.quantity!==1)throw Error("Venta no apta para bienvenida.");
   const people=clients.filter(p=>norm(p.rif)===c.rif);
   const units=equipment.filter(e=>e.odooUnitKey===expected);
   if(people.length!==1||units.length!==1)throw Error("Cliente o unidad no verificable.");
   const e=units[0],s=e.odooSource;
   if(e.active===false||e.source!=="odoo-baifa-sales"||Number(e.clientId)!==Number(people[0].id)||s?.invoiceId!==l.invoiceId||s?.companyId!==12||s?.lineId!==l.lineId||e.invoiceNumber!==l.invoice||e.invoiceDate!==l.date)throw Error("La ficha no coincide con la factura.");
   const [n]=welcomeAdditions([e],[],now,l.date);if(!n)throw Error("Unidad sin evidencia.");
   if(history.some(h=>h.id===n.id||h.invoice===n.invoice||h.equipment?.some(x=>x.unit===expected||x.id===e.id))){skipped.push(n.id);continue}
   additions.push(n);
 }
 if(new Set(additions.map(n=>n.id)).size!==additions.length)throw Error("Bienvenida repetida en la selección.");
 return {additions,skipped};
}
export async function applyApprovedWelcomesOnce(pool,odoo){
 if((await pool.query("SELECT 1 FROM kv WHERE key=$1",[marker])).rowCount)return;
 const source=await loadBaifaCustomers(odoo,{operatingOnly:true});
 const {customers}=consolidateCustomers(source.customers);
 const db=await pool.connect();
 try{
   await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(41577113)");await db.query("SELECT pg_advisory_xact_lock($1)",[CLIENT_LOCK]);
   if((await db.query("SELECT 1 FROM kv WHERE key=$1",[marker])).rowCount){await db.query("ROLLBACK");return}
   const read=async k=>{const v=(await db.query("SELECT value FROM kv WHERE key=$1 FOR UPDATE",[k])).rows[0]?.value;if(!Array.isArray(v))throw Error("Colección ausente o inválida.");return v};
   const write=(k,v)=>db.query("INSERT INTO kv(key,value,updated_at) VALUES ($1,$2::jsonb,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",[k,JSON.stringify(v),Date.now()]);
   const history=await read(key),now=new Date().toISOString();
   const {additions,skipped}=planApprovedWelcomes({customers,clients:await read("erpClients"),equipment:await read("erpClientEquipment"),history,now});
   if(additions.length){await write(marker+":before",history);await write(key,[...history,...additions])}
   await write(marker,[{now,created:additions.map(n=>n.id),skipped}]);await db.query("COMMIT");
 }catch(e){await db.query("ROLLBACK");throw e}finally{db.release()}
}
