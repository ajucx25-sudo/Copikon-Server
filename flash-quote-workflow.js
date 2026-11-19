import { isAdministrator } from "./secure-access.js";
import {isDeepStrictEqual} from "node:util";
import {assessFinancing,requireApproval} from "./financing-authorization.js";
import { financingSchedule, validateQuote } from "./baifa-sales-rules.js";

export const workflowSchema = `CREATE TABLE IF NOT EXISTS sales_flash_quotes (
  id serial PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
  snapshot jsonb NOT NULL, UNIQUE(owner_id,request_id))`;
export const LEAD_LOCK = 176202211;
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
const view = r => ({...r.snapshot,id:r.id});
const same = (a,b) => Object.keys(b).every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
const money = c => (c/100).toFixed(2);
function requireClosingFields(q){
  const fields={companyName:"Empresa o referencia",contactName:"Nombre de contacto",contactPhone:"Teléfono",
    contactEmail:"Email",city:"Ciudad",state:"Estado",classification:"Clasificación del cliente",validUntil:"Válida hasta"};
  const missing=Object.entries(fields).filter(([k])=>typeof q[k]!=="string"||!q[k].trim()).map(([,name])=>name);
  if(missing.length)fail("Falta completar: "+missing.join(", ")+".");
  const date=new Date(q.validUntil+"T00:00:00Z");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(q.validUntil)||!Number.isFinite(+date)||date.toISOString().slice(0,10)!==q.validUntil)fail("Revisa la fecha Válida hasta.");
}
// Pipeline movement and follow-up remain editable; the originating quote does not.
export function protectPipelineQuotes(previous,next){
  const prior=new Map(previous.map(x=>[String(x.id),x]));
  for(const r of next){
    const old=prior.get(String(r.id));
    if(r.flashQuoteId!=null||!r.quoteTerms||(r.quoteTerms===old?.quoteTerms&&r.quoteStatus===old?.quoteStatus&&["quoteItems","quoteTotal","quoteSubtotal","quoteTax","companyName","contactName"].every(k=>isDeepStrictEqual(r[k],old?.[k]))))continue;
    let terms;try{terms=typeof r.quoteTerms==="string"?JSON.parse(r.quoteTerms):r.quoteTerms;}catch{continue;}
    if(terms?.plan?.mode==="financiado")fail("Gestiona el financiamiento desde Cotización Flash.",409);
  }
  const sent=new Set(previous.filter(x=>x.quoteStatus==="enviada").map(x=>String(x.id)));
  for(const r of next)if(r.flashQuoteId==null&&r.quoteStatus==="enviada"&&!sent.has(String(r.id)))
    requireClosingFields({...r,classification:r.priceBand||r.classification,validUntil:r.quoteValidUntil});
  const locked=new Map(previous.filter(x=>x.flashQuoteId!=null).map(x=>[String(x.id),x]));
  for(const row of next){
    const old=locked.get(String(row.id));
    if(!old){if(row.flashQuoteId!=null)fail("La cotización solo se vincula al guardarla.",409);continue;}
    for(const k of ["flashQuoteId","quoteNumber","quoteDate","quoteValidUntil","quoteItems","quoteSubtotal","quoteTax","quoteTotal","quoteNotes","quoteTerms"]){
      if(!isDeepStrictEqual(row[k],old[k]))fail("La cotización guardada es de solo lectura.",409);
    }
    locked.delete(String(row.id));
  }
  if(locked.size)fail("No se puede quitar del pipeline una cotización guardada desde este formulario.",409);
}
function snapshot(body) {
  if (!body || !["borrador","guardada"].includes(body.status)) fail("Estado inválido.");
  const result={};
  for(const [k,max] of Object.entries({companyName:250,contactName:250,contactEmail:250,contactPhone:80,
    classification:64,validUntil:10,notes:4000,city:80,state:80,conditions:8000,complements:8000})){
    const v=body[k]??"";if(typeof v!=="string"||v.length>max) fail(`Revisa el campo ${k}.`);
    result[k]=v.trim();
  }
  if(body.status==="guardada")requireClosingFields(result);
  else if(!result.companyName&&!result.contactName) fail("Indica empresa o contacto.");
  let items;try{items=typeof body.items==="string"?JSON.parse(body.items):body.items;}catch{fail("Líneas no válidas.");}
  if(!Array.isArray(items)||items.length>100||items.some(x=>!x||typeof x!=="object"||Array.isArray(x))||JSON.stringify(items).length>600000) fail("Líneas no válidas.");
  const discount=Number(body.globalDiscountPct??0);
  if(!Number.isFinite(discount)||discount<0||discount>100) fail("Descuento inválido.");
  const applyTax=body.applyTax!==false;
  let gross=0;
  for(const it of items){
    if(typeof it.concepto!=="string"||it.concepto.length>500||(it.detalle!=null&&(typeof it.detalle!=="string"||it.detalle.length>24000)))fail("Descripción o anexo inválidos.");
    if(!Number.isFinite(Number(it.precio))||Number(it.precio)<0||!Number.isFinite(Number(it.qty))||Number(it.qty)<=0) fail("Precio o cantidad inválidos.");
    gross+=Math.round(Math.round(Number(it.precio)*100)*Number(it.qty));
  }
  if(!Number.isSafeInteger(gross))fail("Total inválido.");
  const subtotal=gross-Math.round(gross*discount/100), tax=applyTax?Math.round(subtotal*.16):0;
  const opts=body.quoteTerms||"";
  if(typeof opts!=="string"||opts.length>16000)fail("Plan o selección de briefs inválidos.");
  let terms;
  if(opts){try{terms=JSON.parse(opts);}catch{fail("Plan o selección de briefs inválidos.");}
    if(!terms?.plan||typeof terms.plan!=="object"||Array.isArray(terms.plan)||
      !terms.choices||typeof terms.choices!=="object"||Array.isArray(terms.choices)||
      Object.values(terms.plan).some(v=>!["number","string"].includes(typeof v))||
      Object.values(terms.choices).some(v=>typeof v!=="string"))fail("Plan o selección de briefs inválidos.");
  }
  if(body.status==="guardada"){
    validateQuote({...result,items,applyTax,globalDiscountPct:discount,total:body.total});
    if(terms?.plan.mode)financingSchedule((subtotal+tax)/100,terms.plan);
  }
  return {...result,status:body.status,items:JSON.stringify(items),compraProgramada:body.compraProgramada===true,
    quoteTerms:opts,applyTax,globalDiscountPct:discount,subtotal:money(subtotal),tax:money(tax),total:money(subtotal+tax)};
}
export function registerFlashWorkflow(router,{pool,handle,readCol,readFinanceRows}) {
  const tx=async fn=>{
    const db=await pool.connect();
    try{await db.query("BEGIN");const result=await fn(db);await db.query("COMMIT");return result;}
    catch(e){await db.query("ROLLBACK").catch(()=>{});throw e;}finally{db.release();}
  };
  router.get("/quotes",handle(async(req,res)=>{
    const r=await pool.query("SELECT id,snapshot FROM sales_flash_quotes WHERE owner_id=$1 OR $2 ORDER BY id DESC",
      [String(req.salesUser.id),isAdministrator(req.salesUser)]);
    res.json(r.rows.map(view));
  }));
  async function save(req,db,create,issuing=false){
    const user=req.salesUser,owner=String(user.id),data=snapshot(req.body),now=new Date().toISOString();
    let row;
    if(create){
      const key=req.body.requestId;
      if(typeof key!=="string"||!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(key)) fail("Falta el identificador del formulario.");
      const r=await db.query("INSERT INTO sales_flash_quotes(owner_id,request_id,snapshot) VALUES($1,$2,'{}') ON CONFLICT DO NOTHING RETURNING *",[owner,key]);
      row=r.rows[0];
      if(!row){
        const prev=(await db.query("SELECT * FROM sales_flash_quotes WHERE owner_id=$1 AND request_id=$2 FOR UPDATE",[owner,key])).rows[0];
        if(prev&&same(prev.snapshot,data))return view(prev);
        fail("El formulario ya fue registrado. Revisa el historial.",409);
      }
    }else{
      row=await owned(req,db);
      if(row.snapshot.status!=="borrador"){
        if(data.status==="guardada"&&same(row.snapshot,data))return view(row);
        fail("La cotización guardada no se puede editar.",409);
      }
      if(req.body.version!==row.snapshot.version)fail("El borrador cambió. Reábrelo antes de guardar.",409);
    }
    const number=row.snapshot.number||`COT-${now.slice(0,4)}-${String(row.id).padStart(5,"0")}`;
    const saved={...data,number,createdBy:row.snapshot.createdBy??user.id,createdAt:row.snapshot.createdAt||now,
      updatedAt:now,version:(row.snapshot.version||0)+1};
    const plan=data.quoteTerms?JSON.parse(data.quoteTerms).plan:null;
    if(plan?.mode==="financiado"){
      const products=await readCol("erpProducts");
      let review;
      try{review=assessFinancing(data,plan,products,await readFinanceRows(req));}catch(e){if(data.status==="guardada"||issuing||![400,503].includes(e.status))throw e;}
      if(review?.exception){
        saved.financeRequest=review;
        if(row.snapshot.financeApproval?.key===review.key)saved.financeApproval=row.snapshot.financeApproval;
      }
      if(data.status==="guardada"||issuing)requireApproval(review,saved.financeApproval);
    }
    if(data.status==="guardada"){
      await db.query("SELECT pg_advisory_xact_lock($1)",[LEAD_LOCK]);
      const prior=(await db.query("SELECT value FROM kv WHERE key='erpLeads' FOR UPDATE")).rows[0];
      const leads=prior?prior.value:[];
      if(!Array.isArray(leads))fail("No se pudo verificar el pipeline.",503);
      const id=leads.reduce((m,l)=>Math.max(m,Number(l.id)||0),0)+1;
      const lead={id,number:`LEAD-${number}`,flashQuoteId:row.id,stage:"cotizacion",source:"directo",priority:"media",
        assigneeId:saved.createdBy,companyName:data.companyName||data.contactName,contactName:data.contactName,
        contactEmail:data.contactEmail,contactPhone:data.contactPhone,classification:({industria_comercio:"industria",institucional:"industria"})[data.classification]||data.classification,
        quoteNumber:number,quoteStatus:"enviada",quoteItems:data.items,quoteSubtotal:data.subtotal,quoteTax:data.tax,quoteTotal:data.total,
        quoteNotes:data.notes,quoteTerms:data.quoteTerms,quoteDate:now.slice(0,10),quoteValidUntil:data.validUntil,createdAt:now,updatedAt:now};
      await db.query("INSERT INTO kv(key,value,updated_at) VALUES('erpLeads',$1::jsonb,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",[JSON.stringify([...leads,lead]),Date.now()]);
      saved.convertedToLeadId=id;
    }
    await db.query("UPDATE sales_flash_quotes SET snapshot=$2 WHERE id=$1",[row.id,JSON.stringify(saved)]);
    return {...saved,id:row.id};
  }
  async function owned(req,db){
    if(!/^[1-9]\d{0,8}$/.test(req.params.id))fail("Cotización no encontrada.",404);
    const row=(await db.query("SELECT * FROM sales_flash_quotes WHERE id=$1 AND (owner_id=$2 OR $3) FOR UPDATE",[req.params.id,String(req.salesUser.id),isAdministrator(req.salesUser)])).rows[0];
    if(!row)fail("Cotización no encontrada.",404);return row;
  }
  router.post("/quotes",handle(async(req,res)=>res.json(await tx(db=>save(req,db,true)))));
  router.patch("/quotes/:id",handle(async(req,res)=>res.json(await tx(db=>save(req,db,false)))));
  router.post("/quotes/:id/finance-approval",handle(async(req,res)=>res.json(await tx(async db=>{
    if(req.salesUser.level!=="ceo"||req.salesUser.isPartner)fail("Solo el CEO puede aprobar la excepción.",403);
    const row=await owned(req,db),s=row.snapshot;
    if(s.status!=="borrador"||s.version!==req.body?.version||!s.financeRequest)fail("Actualiza el historial antes de aprobar.",409);
    const r=assessFinancing(s,JSON.parse(s.quoteTerms).plan,await readCol("erpProducts"),await readFinanceRows(req));
    if(!r?.exception||r.key!==s.financeRequest.key||r.key!==req.body.key)fail("La propuesta cambió. Revisa el borrador.",409);
    const financeApproval={key:r.key,by:req.salesUser.id,at:new Date().toISOString()};
    await db.query("UPDATE sales_flash_quotes SET snapshot=$2 WHERE id=$1",[row.id,{...s,financeApproval}]);
    return {approved:true};
  }))));
  router.delete("/quotes/:id",handle(async(req,res)=>res.json(await tx(async db=>{
    const r=await owned(req,db);if(r.snapshot.status!=="borrador")fail("Solo se pueden eliminar borradores.",409);
    if(String(r.snapshot.version)!==req.query.version)fail("El borrador cambió. Revisa la última versión.",409);
    await db.query("DELETE FROM kv WHERE key LIKE 'baifa.sales.package:%' AND value->>'flashQuoteId'=$1",[String(r.id)]);
    await db.query("DELETE FROM sales_flash_quotes WHERE id=$1",[r.id]);return {deleted:true};
  }))));
  return (req,db,link,terms)=>save({salesUser:req.salesUser,financeRowsPromise:req.financeRowsPromise,params:{id:String(link.id??"")},body:{
    ...req.body.quote,quoteTerms:terms,status:"borrador",requestId:link.requestId,version:link.version
  }},db,link.id==null,true);
}
