import express from "express";
import {randomUUID} from "node:crypto";
import {permissionList} from "./secure-access.js";
import {runPdfWorker} from "./baifa-sales-documents.js";
export const dossierPath="/api/generators/technician-dossiers";
export const dossierSchema=`CREATE TABLE IF NOT EXISTS cpk_tech_dossiers(provider bigint PRIMARY KEY,civ boolean NOT NULL,actor text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS cpk_tech_files(id uuid PRIMARY KEY,provider bigint NOT NULL,kind text NOT NULL CHECK(kind IN ('cedula','rif','trabajos','civ')),pdf bytea NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS cpk_tech_files_provider ON cpk_tech_files(provider,kind)`;
const kinds={cedula:"Cédula de identidad",rif:"RIF",trabajos:"Trabajos realizados",civ:"CIV"};
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
const internal=u=>!!u&&!u.isPartner&&!u.isExternal&&!u.isExternalProvider&&u.providerId==null&& !["partner_externo","tecnico_externo"].includes(u.level);
export function generatorDept(u,depts){
  const seen=new Set();let d=depts.find(d=>String(d.id)===String(u?.departmentId));
  while(d&&!seen.has(d.id)){if(Number(d.id)===30&&d.name==="Copikon Generators")return true;seen.add(d.id);d=depts.find(x=>d.parentId!=null&&String(x.id)===String(d.parentId));}return false;
}
export function dossierRights(u,depts){
  const manager=internal(u)&&(u.level==="ceo"||(u.level==="coordinador"&&generatorDept(u,depts)));
  const generators=manager||internal(u)&&(generatorDept(u,depts)||permissionList(u.moduleAccess).some(x=>typeof x==="string"&&(x==="copikon-generators"||x.startsWith("generators-"))));
  const infra=manager&&u.level==="ceo"||internal(u)&&permissionList(u.menuAccess).includes("infraestructura");
  return {manager,generators,infra,status:generators||infra};
}
export function technicianStatus(p,files,declaration,certs,now=Date.now()){
  const missing=[];
  if(!(p.active===true||Number(p.active)===1))missing.push("Técnico inactivo");
  for(const k of ["cedula","rif","trabajos"])if(!files.has(k))missing.push(kinds[k]);
  if(declaration==null)missing.push("Indicar si aplica el CIV");else if(declaration&&!files.has("civ"))missing.push("CIV");
  const last=certs.filter(c=>String(c.providerId)===String(p.id)).sort((a,b)=>(Date.parse(b.evaluatedAt)||0)-(Date.parse(a.evaluatedAt)||0)||Number(b.id)-Number(a.id))[0];
  if(!last)missing.push("Certificado técnico no emitido");
  else if(!(Date.parse(last.evaluatedAt)<=now&&Date.parse(last.expiresAt)>now))missing.push("Certificado técnico no vigente");
  else if(!Array.isArray(last.competenciesCertified)||!last.competenciesCertified.some(x=>typeof x==="string"&&x.trim()))missing.push("El certificado no acredita competencias");
  return {providerId:p.id,authorized:!missing.length,missing};
}
export async function statuses(db,readCol){
  const [ps,cs,ds,fs]=await Promise.all([readCol("technicalProviders"),readCol("technicalCertifications"),db.query("SELECT provider,civ FROM cpk_tech_dossiers"),db.query("SELECT DISTINCT provider,kind FROM cpk_tech_files")]);
  const civ=new Map(ds.rows.map(x=>[String(x.provider),x.civ])),files=new Map();
  for(const f of fs.rows){const id=String(f.provider);if(!files.has(id))files.set(id,new Set());files.get(id).add(f.kind);}
  return ps.map(p=>technicianStatus(p,files.get(String(p.id))||new Set(),civ.get(String(p.id)),cs));
}
export const guardedWork=new Set(["erpLeads","erpMaintenanceOrders","erpMaintenancePlans","erpServiceOrders","erpRentalMaintenance","erpVisits","erpServiceContracts","erpRentalContracts","erpOperatingExpenses","infraMaintenanceOrders","infraMaintenancePlans"]);
export function requiredProviders(key,oldRows,next,employees=[]){
  if(!guardedWork.has(key))return [];
  const old=new Map(oldRows.map(x=>[String(x.id),x])),ids=new Set();
  for(const r of next){const p=old.get(String(r.id))||{};
    function changed(fields){return fields.some(f=>JSON.stringify(r[f])!==JSON.stringify(p[f]));}
    function employee(id){
      const emp=employees.find(e=>String(e.id)===String(id));
      if(!emp||!["activo","active"].includes(emp.status)||!internal(emp))fail("Selecciona un empleado interno activo o un técnico externo del directorio.",409);
      return emp;
    }
    for(const [prefix,fields] of [["inspection",["inspectionDate","inspectionScheduledAt","inspectionStatus","inspectionStartedAt","inspectionCompletedAt","inspectionScheduledDate"]],["installation",["installationDate","installationStatus","installationStartedAt","installationScheduledAt","installationCompletedAt","installationScheduledDate"]]]){
      const inherited=prefix==="installation"&&r.installationProviderId==null&&r.installationBy==null&&r.installationAssigneeType==null;
      const id=inherited?r.inspectionProviderId:r[prefix+"ProviderId"],type=inherited?r.inspectionAssigneeType:r[prefix+"AssigneeType"];
      const acted=changed(Object.keys(r).filter(f=>f.startsWith(prefix)));
      if(acted&&(id!=null||type==="externo"))ids.add(String(id));
      if(acted&&r[prefix+"By"]!=null&&type!=="externo")employee(r[prefix+"By"]);
    }
    for(const [idKey,typeKey] of [["technicianId","technicianType"],["assignedTechnicianId","assignedTechnicianType"]]){
      const nameKey=idKey.replace(/Id$/,"Name");
      if((r[idKey]!=null||r[typeKey]!=null||r[nameKey])&&changed(Object.keys(r))){
        if(r[typeKey]==="externo")ids.add(String(r[idKey]));
        else if(r[typeKey]!=="interno")fail("Selecciona un técnico interno o externo del directorio.",409);
        else employee(r[idKey]);
      }
    }
  }return [...ids];
}
export function registerDossiers(app,{pool,sessions,readCol}){
  const router=express.Router();let workers=0;
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  router.use(wrap(async(req,res,next)=>{
    res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox"});
    const u=await sessions.authenticate(req);if(!u)fail("Inicia sesión.",401);
    const rights=dossierRights(u,await readCol("departments"));req.dossierActor=String(u.id);req.dossierManager=rights.manager;
    if(!rights.status||(req.path!=="/status"||req.method!=="GET")&&!rights.manager)fail("Sin permiso para el expediente privado.",403);next();
  }));
  router.get("/status",wrap(async(req,res)=>res.json({canManage:req.dossierManager,items:await statuses(pool,readCol)})));
  router.use("/:provider",wrap(async(req,res,next)=>{
    if(!/^[1-9]\d{0,8}$/.test(req.params.provider)||!(await readCol("technicalProviders")).some(p=>String(p.id)===req.params.provider))fail("Técnico no encontrado.",404);
    req.provider=Number(req.params.provider);next();
  }));
  router.get("/:provider",wrap(async(req,res)=>{
    const d=await pool.query("SELECT civ FROM cpk_tech_dossiers WHERE provider=$1",[req.provider]);
    const files=await pool.query("SELECT id,kind,created_at FROM cpk_tech_files WHERE provider=$1 ORDER BY created_at",[req.provider]);
    res.json({civ:d.rows[0]?.civ??null,files:files.rows});
  }));
  router.put("/:provider/civ",express.json({limit:"1kb"}),wrap(async(req,res)=>{
    if(typeof req.body?.applies!=="boolean")fail("Indica si aplica el CIV.");
    await pool.query("WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(41577113)) INSERT INTO cpk_tech_dossiers(provider,civ,actor) SELECT $1,$2,$3 FROM locked ON CONFLICT(provider) DO UPDATE SET civ=excluded.civ,actor=excluded.actor,updated_at=now()",[req.provider,req.body.applies,req.dossierActor]);res.json({saved:true});
  }));
  router.post("/:provider/files/:kind",express.json({limit:"7mb"}),wrap(async(req,res)=>{
    const kind=req.params.kind,data=req.body?.pdf;if(!Object.hasOwn(kinds,kind)||typeof data!=="string"||!data.length||data.length>6990508)fail("Adjunta un PDF de hasta 5 MB.");
    if(workers>=2)fail("Hay otras cargas en proceso. Reintenta.",429);
    let checked;workers++;try{checked=await runPdfWorker("brief",[data]);}finally{workers--;}
    const bytes=Buffer.from(checked.dataBase64,"base64");if(bytes.length>5242880)fail("PDF mayor de 5 MB.");
    const db=await pool.connect(),id=randomUUID();try{await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(41577113)");
      const usage=await db.query("SELECT count(*) FILTER(WHERE provider=$1 AND kind=$2) AS n,coalesce(sum(octet_length(pdf)),0) AS bytes FROM cpk_tech_files",[req.provider,kind]);
      if(+usage.rows[0].n>=20||Number(usage.rows[0].bytes)+bytes.length>1073741824)fail("Se alcanzó el límite de documentos.",409);
      await db.query("INSERT INTO cpk_tech_files(id,provider,kind,pdf,actor) VALUES($1,$2,$3,$4,$5)",[id,req.provider,kind,bytes,req.dossierActor]);await db.query("COMMIT");
    }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
    res.status(201).json({id,kind});
  }));
  router.get("/:provider/files/:id",wrap(async(req,res)=>{
    if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(req.params.id))fail("Archivo no encontrado.",404);
    const file=(await pool.query("SELECT kind,pdf FROM cpk_tech_files WHERE provider=$1 AND id=$2",[req.provider,req.params.id])).rows[0];
    if(!file)fail("Archivo no encontrado.",404);
    res.set("Content-Disposition",`attachment; filename="${file.kind}.pdf"`).type("application/pdf").send(file.pdf);
  }));
  router.use((e,_req,res,_next)=>res.status(e.status||500).json({message:e.status===413?"Archivo demasiado grande.":e.status&&e.status<500&&!e.type?e.message:"No se pudo completar la operación del expediente."}));
  app.use(dossierPath,router);
}
