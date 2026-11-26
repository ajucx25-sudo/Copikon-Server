import {loadBaifaCustomers} from "./baifa-client-sync.js";
import {collectionContext,CLIENT_LOCK} from "./client-collection-transactions.js";
import {persistSoldPark} from "./posventa-client-sync.js";
const marker="adminMaintenance:soldParkFromOdoo:success:v1";
const day=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Caracas",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
export function soldParkRefresh({pool,odoo,readCol,writeCol}){
 let inFlight;
 const sync=async(actorId=null)=>{
  if(inFlight)return inFlight;
  inFlight=(async()=>{
   const source=await loadBaifaCustomers(odoo,{operatingOnly:true});
   const db=await pool.connect();
   try{
    await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(41577113)");
    await db.query("SELECT pg_advisory_xact_lock($1)",[CLIENT_LOCK]);
    const result=await collectionContext.run(db,async()=>{
      const last=(await readCol(marker))[0];if(last?.observedAt>source.observedAt)throw Object.assign(Error("Ya se aplicó una consulta más reciente. Actualiza la vista."),{status:409});
      const r=await persistSoldPark({readCol,writeCol,source,actorId});
      await writeCol(marker,[{observedAt:source.observedAt,day:day(),created:r.created,total:r.total}]);return r;
    });
    await db.query("COMMIT");return result;
   }catch(e){await db.query("ROLLBACK");throw e}finally{db.release()}
  })().finally(()=>{inFlight=null});
  return inFlight;
 };
 let checking=false;
 const check=async()=>{if(checking)return;checking=true;try{if((await readCol(marker))[0]?.day!==day())await sync()}catch{console.error("[posventa] actualización diaria pendiente; se reintentará")}finally{checking=false}};
 return {sync,start(){setInterval(check,15*60*1000).unref();setTimeout(check,60000).unref()}};
}
