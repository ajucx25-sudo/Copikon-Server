import {createHash} from "node:crypto";
import {canAccessPath} from "./secure-access.js";
import {localScope} from "./inventory-comparison.js";
import {photoFromEdit} from "./catalog-photo.js";

const path="/api/generators/inventory/product-sheet";
const amounts=["priceExpress","priceDirect","priceAllies"];
const fields=["imageUrl","salePrice",...amounts,...amounts.map(k=>k+"Pct")];
const technicalFields="brand model category description shortDescription kva kvaNumeric kw voltage phases frequency controlPanel motorBrand motorModel motorType motorCylinders motorRpm motorDisplacement alternatorBrand alternatorModel alternatorType fuelCapacity fuelConsumption runtime towerHeight lightPower lightType coverageArea dimensions weight noiseLevel enclosure".split(" ");
const editableSpecs=technicalFields.filter(k=>!["brand","category","kvaNumeric","shortDescription"].includes(k));
const validImage=v=>typeof v==="string"&&v.length<=2200000&&(/^https?:\/\/[^\s<>"'`\\]+$/i.test(v)||/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(v));
function gallery(raw){try{const a=Array.isArray(raw)?raw:JSON.parse(raw||"[]");return Array.isArray(a)&&a.every(v=>typeof v==="string")?a:null;}catch{return null;}}
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function find(items,code){
  const matches=items.filter(p=>String(p.code||p.sku||"").trim()===code);
  if(!matches.length) return null;
  if(matches.length!==1)fail(409,"Hay más de una ficha para este código. Revisa las referencias antes de editar.");
  return matches[0];
}
function project(p){
  if(!p)return null;
  const product=Object.fromEntries(fields.map(k=>[k,p[k]??null]));
  const scalar=v=>(typeof v==="string"&&v.trim()!=="")||Number.isFinite(v);
  product.technical=Object.fromEntries(technicalFields.filter(k=>scalar(p[k])).map(k=>[k,p[k]]));
  product.gallery=gallery(p.galleryImages);
  if(scalar(p.rentalPrice))product.rentalPrice=p.rentalPrice;
  return {...product,revision:createHash("sha256").update(JSON.stringify([p.id,product])).digest("hex")};
}
function update(items,code,body){
  const p=find(items,code);if(!p)fail(404,"No hay ficha comercial vinculada a este código.");
  if(!body||body.revision!==project(p).revision)fail(409,"La ficha cambió. Ciérrala y vuelve a abrirla.");
  const changes=body.changes;
  if(!changes||typeof changes!=="object"||Array.isArray(changes)||!Object.keys(changes).length)fail(400,"Indica qué deseas modificar.");
  for(const [k,v] of Object.entries(changes)){
    if(amounts.includes(k)||k==="rentalPrice"){if(!Number.isFinite(v)||v<0||v>1e12)fail(400,"Importe no válido.");}
    else if(amounts.some(a=>k===a+"Pct")){if(!Number.isFinite(v)||v<=-100||v>1000)fail(400,"Porcentaje no válido.");}
    else if(editableSpecs.includes(k)){if(typeof v!=="string"||v.length>(k==="description"?4000:200)||/[<>\u0000-\u0008]/.test(v))fail(400,"Característica técnica no válida.");}
    else if(k==="gallery"){if(!Array.isArray(v)||!gallery(p.galleryImages)||v.length>8||!v.every(s=>validImage(s)||gallery(p.galleryImages).includes(s))||v.reduce((n,s)=>n+s.length,0)>10000000)fail(400,"Galería no válida. Admite hasta ocho imágenes y 10 MB en total.");}
    else if(k==="imageUrl"){
      if(v!==""&&!validImage(v))fail(400,"Usa una foto JPG, PNG o WebP o una URL http(s).");
    }else fail(400,"Campo no permitido.");
  }
  const {gallery:images,...rest}=changes;
  Object.assign(p,rest,photoFromEdit(p,rest));
  for(const k of ["model","description"])if(Object.hasOwn(rest,k))p[k+"Manual"]=!!rest[k].trim();
  if(images!==undefined)p.galleryImages=JSON.stringify(images);
  return project(p);
}
export function registerInventorySheet(app,{readCol,pool,inInventory}){
  async function handle(req,res){
    res.set("Cache-Control","private, no-store");
    if(!req.verifiedUser)return res.sendStatus(401);
    if(!canAccessPath(req.verifiedUser,path,req.method))return res.sendStatus(403);
    const code=req.query.code;
    if(typeof code!=="string"||!code.trim()||code.length>200)return res.status(400).json({message:"Código no válido."});
    try{
      let product;
      const sku=code.trim(),current=find(await readCol("erpProducts"),sku),canEdit=canAccessPath(req.verifiedUser,path,"PATCH");
      const verified=(!current&&canEdit)||(current&&!localScope(current))?await inInventory(sku):null;
      if(current&&!localScope(current)&&!verified)fail(404,"El código no pertenece a Inventario de Generators.");
      const draft=!current&&canEdit&&!!verified;
      if(req.method!=="PATCH")product=draft?{...project({code:sku}),revision:`nuevo:${sku}`,draft:true}:project(current);
      else{
        const c=await pool.connect();try{
          await c.query("BEGIN");
          const r=await c.query("SELECT value FROM kv WHERE key=$1 FOR UPDATE",["erpProducts"]);
          const items=r.rows[0]?.value;
          if(!Array.isArray(items))fail(503,"No se pudo verificar el catálogo.");
          if(!find(items,sku)&&draft&&req.body?.revision===`nuevo:${sku}`){
            const created={id:items.reduce((max,it)=>Math.max(max,Number(it.id)||0),0)+1,code:sku,sku,name:verified.catalogName||verified.name||sku,unit:verified.unit||"",status:"activo"};
            items.push(created);req.body={...req.body,revision:project(created).revision};
          }
          product=update(items,code.trim(),req.body);
          await c.query("UPDATE kv SET value=$1::jsonb,updated_at=$2 WHERE key=$3",[JSON.stringify(items),Date.now(),"erpProducts"]);
          await c.query("COMMIT");
        }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
      }
      res.json({code:code.trim(),product,editable:!!product&&canAccessPath(req.verifiedUser,path,"PATCH")});
    }catch(e){res.status(e.status||503).json({message:e.status?e.message:"No se pudo verificar la ficha."});}
  }
  app.get(path,handle);app.patch(path,handle);
}
