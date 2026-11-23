import {all} from "./baifa-client-sync.js";
import {canAccessPath} from "./secure-access.js";
const path="/api/generators/inventory/comparison";
const dispatchPaths=new Set(["CCS/STOCK","BTO/STOCK","TDA-B/STOCK","INV/STOCK","ATR/STOCK","VAL/STOCK","MCY/STOCK","GEN/STOCK"]);
export function freeForDispatch(locations){return Math.max(0,locations.filter(l=>dispatchPaths.has(String(l.name??"").trim().toUpperCase())).reduce((n,l)=>n+l.quantity-l.reserved,0));}
const id=v=>Array.isArray(v)?v[0]:v;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const requireValue=v=>{if(!v)throw Error("Lectura de inventario incompleta");};
const localScope=p=>/^(TRPE|VTM)/i.test(p.code||p.sku||"")||
  (!["service","servicio"].includes(String(p.type||p.category||"").trim().toLowerCase())&&
    (["baifa","copikon_gen"].includes(String(p.brand||"").trim().toLowerCase())||
     String(p.category||"").trim().toLowerCase()==="repuestos_de_generadores"));
export async function comparison({odoo,readCol,readInventory}){
  const [c,catalog]=await Promise.all([readInventory(),readCol("erpProducts")]);
  requireValue(c?.complete&&c.source==="odoo-po-invoices"&&Array.isArray(catalog)&&Array.isArray(c.rows));
  const companies=c.companies.map(x=>x.id);requireValue(companies.length&&companies.every(positive));
  const context={allowed_company_ids:companies},map=new Map();
  for(const r of c.rows)map.set(r.code,{code:r.code,name:r.name,unit:r.uomLabel,commercial:r.balance,pending:r.pending,credits:r.creditUnits,locations:null});
  for(const p of catalog){const code=String(p.code||p.sku||"").trim();if(!code||(!map.has(code)&&!localScope(p)))continue;
    if(!map.has(code))map.set(code,{code,name:p.name||code,commercial:null,pending:null,credits:null,locations:null});
    const r=map.get(code);if(!r.catalogName&&p.name)r.catalogName=p.name;
    if(p.kva||p.kvaNumeric)r.power=String(p.kva||`${p.kvaNumeric} kVA`);}
  const original=[...map.values()];
  try{
    const fields=await odoo.execute("product.product","fields_get",[],{attributes:["type"]});
    const clauses=[["name","ilike","BAIFA"],["default_code","=ilike","TRPE%"],["default_code","=ilike","VTM%"],
      ...["x_studio_marca","x_studio_marca_1"].filter(f=>fields[f]).map(f=>[f,"ilike","BAIFA"])];
    const scop=[["type","in",["product","consu"]],"|",["company_id","=",false],["company_id","in",companies]];
    const candidates=await all(odoo,"product.product",[...scop,...Array(clauses.length-1).fill("|"),...clauses],["id","default_code","name"],50000,context);
    for(const p of candidates)if(typeof p.default_code==="string"&&p.default_code.trim()&&!map.has(p.default_code))map.set(p.default_code,{code:p.default_code,name:p.name,commercial:null,pending:null,credits:null,locations:null,physicalOnly:true});
    const codes=[...map.keys()],rows=[...map.values()];
    const prods=[], seen=new Set();
    for(let n=0;n<codes.length;n+=300)prods.push(...await all(odoo,"product.product",[
      ["default_code","in",codes.slice(n,n+300)],["type","in",["product","consu"]],"|",["company_id","=",false],["company_id","in",companies]],
      ["id","default_code","uom_id"],50000,context));
    const byId=new Map(),units=new Map(),conflict=new Set();
    for(const p of prods){const code=p.default_code,u=id(p.uom_id);requireValue(map.has(code)&&positive(p.id)&&positive(u)&&!byId.has(p.id));byId.set(p.id,code);
      if(units.has(code)&&units.get(code)!==u)conflict.add(code);units.set(code,u);
      if(!map.get(code).unit)map.get(code).unit=p.uom_id[1];}
    for(const r of c.rows)if(r.productIds.some(i=>byId.get(i)!==r.code)||units.get(r.code)!==r.uomId)conflict.add(r.code);
    const locs=await all(odoo,"stock.location",[["usage","=","internal"],["company_id","in",companies]],["id","complete_name","warehouse_id","company_id"],50000,context);
    const locations=new Map(locs.map(l=>[l.id,l]));requireValue(locations.size&&locations.size===locs.length&&locs.every(l=>companies.includes(id(l.company_id))&&l.complete_name));
    const totals=new Map(),ids=[...byId.keys()];
    for(let n=0;n<ids.length;n+=300){
      const batch=ids.slice(n,n+300),quants=await all(odoo,"stock.quant",[["product_id","in",batch],["location_id","in",[...locations.keys()]],["company_id","in",companies]],
        ["id","product_id","location_id","quantity","reserved_quantity"],100000,context);
      for(const q of quants){const pid=id(q.product_id),lid=id(q.location_id),code=byId.get(pid),l=locations.get(lid);
        requireValue(positive(q.id)&&!seen.has(q.id)&&batch.includes(pid)&&l&&Number.isFinite(q.quantity)&&Number.isFinite(q.reserved_quantity)&&q.reserved_quantity>=0);
        seen.add(q.id);if(!q.quantity&&!q.reserved_quantity)continue;if(!totals.has(code))totals.set(code,new Map());const buckets=totals.get(code);
        const v=buckets.get(lid)||{name:l.complete_name,warehouse:l.warehouse_id?.[1]||"Sin almacén asignado",quantity:0,reserved:0};v.quantity+=q.quantity;v.reserved+=q.reserved_quantity;buckets.set(lid,v);}
    }
    for(const r of rows)if(units.has(r.code)&&!conflict.has(r.code))r.locations=[...(totals.get(r.code)?.values()||[])].sort((a,b)=>a.name.localeCompare(b.name));
    return {rows:rows.filter(r=>!r.physicalOnly||r.locations===null||r.locations.some(l=>l.quantity||l.reserved)),commercialAt:c.observedAt,physicalAt:new Date().toISOString()};
  }catch{return {rows:original.map(r=>({...r,locations:null})),commercialAt:c.observedAt,physicalAt:null};}
}
export function registerInventoryComparison(app,deps){
  let running;
  const load=()=>running??=comparison(deps).finally(()=>{running=undefined;});
  app.get("/api/generators/seller-catalog",async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    if(!req.verifiedUser)return res.sendStatus(401);
    if(!canAccessPath(req.verifiedUser,"/api/generators/seller-catalog","GET"))return res.sendStatus(403);
    try{const [inventory,catalog]=await Promise.all([load(),deps.readCol("erpProducts")]);
      if(!inventory.physicalAt)throw Error();
      const byCode=new Map(catalog.map(p=>[String(p.code||p.sku||"").trim(),p]));
      const products=inventory.rows.flatMap(r=>{
        const p=byCode.get(r.code)||{};
        if(["inactivo","archived"].includes(p.status)||!Array.isArray(r.locations))return [];
        const stock=freeForDispatch(r.locations);
        const out={id:r.code,code:r.code,name:r.catalogName||r.name||r.code,stock,unit:r.unit||"",_catalogDispatch:true};
        for(const k of ["brand","category","model","kva","kw","imageUrl","priceExpress","priceExpressPct","salePrice"])if(["number","string"].includes(typeof p[k]))out[k]=p[k];
        return [out];
      });res.json({physicalAt:inventory.physicalAt,products});
    }catch{res.status(503).json({message:"No se pudo verificar el catálogo."});}
  });
  app.get(path,async(req,res)=>{res.set("Cache-Control","private, no-store");
    if(!req.verifiedUser)return res.status(401).json({message:"Inicia sesión."});
    if(!canAccessPath(req.verifiedUser,path,"GET"))return res.status(403).json({message:"Se requiere acceso a Inventario."});
    if(Object.keys(req.query).length)return res.status(400).json({message:"Consulta no permitida."});
    try{res.json(await load());}catch{res.status(503).json({message:"No se pudo verificar el inventario."});}
  });
}
