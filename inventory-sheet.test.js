import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {registerInventorySheet} from "./inventory-sheet.js";
test("Ficha por SKU: permisos, revisión obsoleta, duplicados y edición limitada sin tocar stock",async()=>{
 let items=[{id:1,code:"QA",brand:"BAIFA",priceExpress:18,stock:9,costPrice:8,voltage:"480 V",motorBrand:"Prueba",motorModel:{private:"oculto"},rentalPrice:50},{id:3,code:"OTRO",priceExpress:99}];
 const roles={admin:{level:"ceo"},stock:{level:"vendedor",moduleAccess:["generators-inventario"]},sales:{level:"vendedor",moduleAccess:["generators-ventas"]}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.verifiedUser=roles[req.headers.role];next()});
 registerInventorySheet(app,{readCol:async()=>items,inInventory:async()=>false,pool:{connect:async()=>({release(){},query:async(sql,args)=>{
   if(sql.startsWith("SELECT"))return {rows:[{value:structuredClone(items)}]};
   if(sql.startsWith("UPDATE"))items=JSON.parse(args[0]);
 }})}});
 const s=app.listen(0,"127.0.0.1");await new Promise(r=>s.once("listening",r));
 try{const base=`http://127.0.0.1:${s.address().port}/api/generators/inventory/product-sheet?code=`;
  const get=(role,code="QA")=>fetch(base+code,{headers:{role}});
  const patch=(role,revision,changes)=>fetch(base+"QA",{method:"PATCH",headers:{role,"Content-Type":"application/json"},body:JSON.stringify({revision,changes})});
  assert.equal((await get("none")).status,401);assert.equal((await get("sales")).status,403);
  const {product,editable}=await(await get("stock")).json();assert.equal(editable,false);assert.equal(product.costPrice,undefined);
  assert.deepEqual(product.technical,{brand:"BAIFA",voltage:"480 V",motorBrand:"Prueba"});assert.equal(product.rentalPrice,50);
  assert.equal((await patch("admin",product.revision,{technical:{voltage:"600 V"}})).status,400);
  assert.equal((await patch("stock",product.revision,{priceExpress:24})).status,403);
  assert.equal((await patch("admin",product.revision,{stock:0})).status,400);
  assert.equal((await patch("admin",product.revision,{priceExpress:24,imageUrl:"https://example.org/pump.jpg"})).status,200);
  assert.equal(items[0].stock,9);assert.equal(items[0].priceExpress,24);
  assert.equal((await(await get("stock")).json()).product.imageUrl,"https://example.org/pump.jpg");
  assert.equal((await patch("admin",product.revision,{priceDirect:1})).status,409);
  assert.equal((await(await get("stock","FALTA")).json()).product,null);
  assert.equal((await get("stock","OTRO")).status,404);
  items.push({...items[0],id:2});assert.equal((await get("stock")).status,409);
 }finally{await new Promise(r=>s.close(r));}
});
