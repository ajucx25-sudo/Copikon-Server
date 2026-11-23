import {createHash} from "node:crypto";
import {canAccessPath} from "./secure-access.js";
import {localScope} from "./inventory-comparison.js";
import {photoFromEdit} from "./catalog-photo.js";

const path="/api/generators/inventory/product-sheet";
const amounts=["priceExpress","priceDirect","priceAllies"];
const fields=["imageUrl","salePrice",...amounts,...amounts.map(k=>k+"Pct")];
const technicalFields="brand model category description shortDescription kva kvaNumeric kw voltage phases frequency controlPanel motorBrand motorModel motorType motorCylinders motorRpm motorDisplacement alternatorBrand alternatorModel alternatorType fuelCapacity fuelConsumption runtime towerHeight lightPower lightType coverageArea dimensions weight noiseLevel enclosure".split(" ");
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
  if(scalar(p.rentalPrice))product.rentalPrice=p.rentalPrice;
  return {...product,revision:createHash("sha256").update(JSON.stringify([p.id,product])).digest("hex")};
}
function update(items,code,body){
  const p=find(items,code);if(!p)fail(404,"No hay ficha comercial vinculada a este código.");
  if(!body||body.revision!==project(p).revision)fail(409,"La ficha cambió. Ciérrala y vuelve a abrirla.");
  const changes=body.changes;
  if(!changes||typeof changes!=="object"||Array.isArray(changes)||!Object.keys(changes).length)fail(400,"Indica qué deseas modificar.");
  for(const [k,v] of Object.entries(changes)){
    if(amounts.includes(k)){if(!Number.isFinite(v)||v<0||v>1e12)fail(400,"Importe no válido.");}
    else if(k==="imageUrl"){
      if(typeof v!=="string"||v.length>2200000||!(v===""||/^https?:\/\/[^\s]+$/i.test(v)||/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(v)))fail(400,"Usa una foto JPG, PNG o WebP o una URL http(s).");
    }else fail(400,"Campo no permitido.");
  }
  Object.assign(p,changes,photoFromEdit(p,changes));return project(p);
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
      const current=find(await readCol("erpProducts"),code.trim());
      if(current&&!localScope(current)&&!await inInventory(code.trim()))fail(404,"El código no pertenece a Inventario de Generators.");
      if(req.method!=="PATCH")product=project(current);
      else{
        const c=await pool.connect();try{
          await c.query("BEGIN");
          const r=await c.query("SELECT value FROM kv WHERE key=$1 FOR UPDATE",["erpProducts"]);
          const items=r.rows[0]?.value||[];
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
