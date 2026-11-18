import express from "express";
import {randomUUID} from "node:crypto";
import {isAdministrator} from "./secure-access.js";
import {visibleLead} from "./lead-access.js";
export const compatPath="/api/device-compat";
export const compatSchema=`CREATE TABLE IF NOT EXISTS cpk_visit_media (
  id uuid PRIMARY KEY,owner_id text NOT NULL,lead_id text NOT NULL,jpeg bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS cpk_visit_media_owner ON cpk_visit_media(owner_id);
  CREATE TABLE IF NOT EXISTS cpk_user_prefs (owner_id text NOT NULL,name text NOT NULL,setting jsonb NOT NULL,PRIMARY KEY(owner_id,name));`;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const keySet=new Set(["tracker","couriers","price-layout"]);
export function registerDeviceCompat(app,{pool,sessions,readCol}){
  const router=express.Router();
  const run=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||503).json({message:e.status?e.message:"No se confirmó la operación. Reintenta con conexión."});}};
  router.use(async(req,res,next)=>{
    res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
    try{req.actor=await sessions.authenticate(req);}catch{return res.sendStatus(503);}
    if(!req.actor?.id)return res.sendStatus(401);
    if(req.actor.isPartner||req.actor.level==="partner_externo")return res.sendStatus(403);
    next();
  });
  router.get("/prefs/:name",run(async(req,res)=>{
    if(!keySet.has(req.params.name))fail("Preferencia no válida.");
    const r=await pool.query("SELECT setting FROM cpk_user_prefs WHERE owner_id=$1 AND name=$2",[String(req.actor.id),req.params.name]);
    res.json({value:r.rows[0]?.setting??null});
  }));
  router.put("/prefs/:name",express.json({limit:"24kb"}),run(async(req,res)=>{
    const name=req.params.name, v=req.body?.value;
    if(!keySet.has(name)||v==null)fail("Preferencia no válida.");
    if(name==="tracker"){
      if(typeof v!=="string"||v.length>2000||(v&&!/^https:\/\/[^\s]+$/i.test(v)))fail("Usa una URL HTTPS válida.");
    }else if(typeof v!=="object"||Array.isArray(v)||Object.values(v).some(x=>!["boolean","string","number"].includes(typeof x)))fail("Formato de preferencia no válido.");
    await pool.query("INSERT INTO cpk_user_prefs(owner_id,name,setting) VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_id,name) DO UPDATE SET setting=excluded.setting",[String(req.actor.id),name,JSON.stringify(v)]);
    res.json({value:v});
  }));
  const permitted=async(user,id)=>{
    const lead=(await readCol("erpLeads")).find(l=>String(l.id)===id);
    if(!visibleLead(user,lead))return false;
    if(user.providerId!=null)return lead.inspectionAssigneeType==="externo"&&lead.inspectionProviderId!=null&&String(lead.inspectionProviderId)===String(user.providerId);
    return isAdministrator(user)||[lead.assigneeId,lead.inspectionBy].some(v=>v!=null&&String(v)===String(user.id));
  };
  router.get("/visits/:leadId/photos",run(async(req,res)=>{
    const lead=req.params.leadId;
    if(!await permitted(req.actor,lead))fail("Sin acceso a esta visita.",403);
    const {rows}=await pool.query("SELECT id,created_at FROM cpk_visit_media WHERE lead_id=$1 AND (owner_id=$2 OR $3) ORDER BY created_at DESC",[lead,String(req.actor.id),isAdministrator(req.actor)]);
    res.json(rows.map(row=>({id:"vs_"+row.id,takenAt:row.created_at})));
  }));
  router.post("/visits/:leadId/photos",express.json({limit:"3mb"}),run(async(req,res)=>{
    const lead=req.params.leadId;
    if(!await permitted(req.actor,lead))fail("Sin acceso a esta visita.",403);
    const data=req.body?.jpeg;
    if(typeof data!=="string"||data.length>2800000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(data))fail("JPEG inválido.");
    const bytes=Buffer.from(data.slice(23),"base64");
    if(bytes.length<32||bytes.length>2*1024*1024||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)fail("Foto JPEG no válida.");
    const id=randomUUID(),owner=String(req.actor.id),db=await pool.connect();
    try{await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(193098)");
      const {rows}=await db.query("SELECT count(*) FILTER(WHERE owner_id=$1 AND created_at>now()-interval '1 day') AS n,coalesce(sum(octet_length(jpeg)),0) AS bytes FROM cpk_visit_media",[owner]);
      if(Number(rows[0].n)>=100||Number(rows[0].bytes)+bytes.length>1024**3)fail("Límite de fotos alcanzado. Contacta al administrador.",429);
      await db.query("INSERT INTO cpk_visit_media(id,owner_id,lead_id,jpeg) VALUES($1,$2,$3,$4)",[id,owner,lead,bytes]);await db.query("COMMIT");
    }catch(e){await db.query("ROLLBACK").catch(()=>{});throw e;}finally{db.release();}
    res.status(201).json({id:"vs_"+id,bytes:bytes.length});
  }));
  const fetchPhoto=async(req)=>{
    if(!/^vs_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(req.params.id))fail("Foto no encontrada.",404);
    const id=req.params.id.slice(3), owner=String(req.actor.id);
    const {rows}=await pool.query("SELECT lead_id FROM cpk_visit_media WHERE id=$1 AND (owner_id=$2 OR $3)",[id,owner,isAdministrator(req.actor)]);
    if(!rows[0]||!await permitted(req.actor,rows[0].lead_id))fail("Foto no encontrada.",404);
    return id;
  };
  router.get("/photos/:id",run(async(req,res)=>{
    const id=await fetchPhoto(req);const r=await pool.query("SELECT jpeg FROM cpk_visit_media WHERE id=$1",[id]);
    if(!r.rows[0])fail("Foto no encontrada.",404);
    res.set({"Content-Disposition":`attachment; filename="visita-${id}.jpg"`,"Content-Security-Policy":"sandbox"}).type("image/jpeg").send(r.rows[0].jpeg);
  }));
  router.delete("/photos/:id",run(async(req,res)=>{
    const id=await fetchPhoto(req);await pool.query("DELETE FROM cpk_visit_media WHERE id=$1 AND owner_id=$2",[id,String(req.actor.id)]).then(r=>{if(!r.rowCount)fail("Solo el autor puede eliminar esta foto.",403);});res.json({deleted:true});
  }));
  app.use(compatPath,router);
}
