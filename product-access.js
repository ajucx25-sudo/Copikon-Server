import {isAdministrator,permissionList} from "./secure-access.js";

const base="/api/erp/products";
const clean=path=>path.toLowerCase().replace(/\/+$/,"");
export function productCollectionWrite(path,method){
  const p=clean(path);
  return (method==="POST"&&(p===base||p===base+"/bulk-update-manual-prices"))||
    (["PATCH","PUT","DELETE"].includes(method)&&/^\/api\/erp\/products\/[^/]+$/.test(p));
}
const rentAmounts=new Set(["rentalRateDay","rentalRateWeek","rentalRateMonth","rentalDeposit"]);
const validAmount=v=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
const catalogModules=new Set("wms ops-almacen operaciones comercializacion tiendas-retail tecnica-proyectos modo-campo playbooks pricelists-b2b requerimientos-especiales copikon-generators generators-ventas generators-inventario generators-tecnico generators-alquiler generators-mantenimiento generators-posventa generators-compras generators-administracion".split(" "));
export function productAccess(sessions){
  return async(req,res,next)=>{
    const p=clean(req.path),m=req.method;
    if(p!==base&&!p.startsWith(base+"/"))return next();
    // Read-only image proxy is used by <img> tags that do not carry a Bearer header.
    if(["GET","HEAD"].includes(m)&&/^\/api\/erp\/products\/odoo-image\/\d+$/.test(p))return next();
    res.set("Cache-Control","private, no-store");
    try{
      const u=await sessions.authenticate(req);
      if(!u)return res.sendStatus(401);
      if(u.isPartner||u.level==="partner_externo")return res.sendStatus(403);
      req.verifiedUser=u;
      if(isAdministrator(u))return next();
      const mods=permissionList(u.moduleAccess);
      if(["GET","HEAD"].includes(m))return mods.some(k=>catalogModules.has(k))?next():res.sendStatus(403);
      if(m==="PATCH"&&/^\/api\/erp\/products\/[^/]+$/.test(p)){
        const body=req.body,keys=Object.keys(body||{});
        if(keys.length===1&&keys[0]==="stock"&&mods.some(k=>k==="wms"||k==="ops-almacen")&&validAmount(body.stock))return next();
        if(keys.length&&mods.includes("generators-alquiler")&&keys.every(k=>
          k==="rentable"?typeof body[k]==="boolean":k==="rentalStatus"?typeof body[k]==="string"&&body[k].length<=64:rentAmounts.has(k)&&validAmount(body[k])))return next();
      }
      if(m==="POST"&&/^\/api\/erp\/products\/[^/]+\/serials$/.test(p)&&mods.includes("generators-inventario"))return next();
      return res.sendStatus(403);
    }catch{return res.sendStatus(503);}
  };
}
const commercial=new Set("id odooId sku code name active status syncStatus brand category type model kva kvaNumeric kw unit stock minStock shortDescription description imageUrl datasheetUrl manualUrl videoUrl priceExpress priceExpressPct priceDirect priceDirectPct priceAllies priceAlliesPct salePrice rentable rentalStatus rentalRateDay rentalRateWeek rentalRateMonth rentalDeposit".split(" "));
export function productRead(p,user){
  if(isAdministrator(user)||permissionList(user?.moduleAccess).some(m=>["wms","generators-inventario","generators-compras","generators-administracion"].includes(m)))return p;
  return Object.fromEntries(Object.entries(p).filter(([k])=>commercial.has(k)));
}
