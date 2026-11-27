// Only future sync additions can generate a welcome. Existing equipment is never scanned.
import {createHash} from "node:crypto";
const key="adminMaintenance:posventaWelcomesV1";
export function welcomeAdditions(additions,existing,now,fromDate){
 const known=new Map(existing.map(r=>[r.id,r])),groups=new Map();
 for(const e of additions){
  if(e.source!=="odoo-baifa-sales"||!e.odooUnitKey||!e.odooSource?.invoiceId||!e.clientId||!e.invoiceDate||e.invoiceDate<fromDate)continue;
  const id=createHash("sha256").update(JSON.stringify([e.odooSource.companyId,e.odooSource.invoiceId,e.clientId])).digest("hex");
  const prior=known.get(id);
  if(prior?.status==="done")continue;
  const group=groups.get(id)||(prior?{...prior,equipment:[...prior.equipment]}:{id,clientId:e.clientId,invoice:e.invoiceNumber,invoiceDate:e.invoiceDate,createdAt:now,equipment:[],status:"pending"});
  if(group.equipment.some(x=>x.unit===e.odooUnitKey))continue;
  group.equipment.push({id:e.id,unit:e.odooUnitKey,code:e.productCode||e.model||"Generador"});
  groups.set(id,group);
 }
 return [...groups.values()];
}
export async function recordWelcomes(additions,readCol,writeCol,now){
 const activationKey=key+":activation",activation=await readCol(activationKey);
 const date=activation[0]?.date||"2026-11-25"; // Fecha de activación en la compañía operativa.
 if(!activation.length)await writeCol(activationKey,[{date}]);
 const rows=await readCol(key),next=welcomeAdditions(additions,rows,now,date);
 if(next.length){const changed=new Set(next.map(r=>r.id));await writeCol(key,[...rows.filter(r=>!changed.has(r.id)),...next]);}
}
export const welcomePath="/api/generators/posventa/equipment/welcomes";
export function welcomeSpecs(unit,entry,clientId){
 if(!unit||unit.clientId!==clientId||unit.id!==entry.id||unit.odooUnitKey!==entry.unit||!entry.unit)return {};
 const description=String(unit.productDescription||"");
 const models=[...new Set((description.match(/\bBF-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/gi)||[]).map(s=>s.toUpperCase()))];
 const ambiguousGrouping=/\d[.,\s]\d{3}(?:[.,]\d+)?\s*kVA\b/i.test(description);
 const powers=[...new Set([...description.matchAll(/(?<![\d.,/-])(\d{1,4}(?:[.,]\d+)?)\s*kVA\b/gi)].map(m=>Number(m[1].replace(",","."))).filter(n=>n>0))];
 return {...(models.length===1?{model:models[0]}:{}),...(powers.length===1&&!ambiguousGrouping&&!/\d\s*[-/]\s*\d+(?:[.,]\d+)?\s*kVA/i.test(description)?{powerKva:powers[0]}:{})};
}
export function registerWelcomes(app,{readCol,writeCol,wrap}){
 app.get(welcomePath,wrap(async(req,res)=>{
  const [rows,clients,units]=await Promise.all([readCol(key),readCol("erpClients"),readCol("erpClientEquipment")]);
  const unitsById=new Map(units.map(u=>[u.id,u]));
  res.json({items:rows.filter(r=>r.status!=="done").map(r=>{const c=clients.find(c=>c.id===r.clientId);
   const own=r.status==="claimed"&&r.owner!=null&&r.owner===req.verifiedUser?.id;
   return {id:r.id,invoice:r.invoice,invoiceDate:r.invoiceDate,createdAt:r.createdAt,status:r.status,owner:r.owner||null,client:c?.name||"Cliente por verificar",...(own?{contact:c?.contact||"",phone:c?.phone||""}:{}),equipment:r.equipment.map(e=>({id:e.id,code:e.code,...welcomeSpecs(unitsById.get(e.id),e,r.clientId)}))};
  })});
 }));
 app.post(welcomePath+"/:id/:action",wrap(async(req,res)=>{
  const {id,action}=req.params,owner=req.verifiedUser.id;
  if(!["claim","release","done"].includes(action))return res.status(400).json({message:"Acción no válida."});
  const rows=await readCol(key),r=rows.find(x=>x.id===id);
  if(!r)return res.status(404).json({message:"La alerta no existe."});
  if(r.status==="done"||r.owner!=null&&r.owner!==owner||action!=="claim"&&r.owner!==owner)return res.status(409).json({message:"La alerta ya fue atendida o asignada a otra persona."});
  r.status=action==="claim"?"claimed":action==="release"?"pending":"done";r.owner=action==="release"?null:owner;r.updatedAt=new Date().toISOString();
  await writeCol(key,rows);res.json({id,status:r.status,owner:r.owner});
 }));
}
