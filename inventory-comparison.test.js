import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {comparison,registerInventoryComparison} from "./inventory-comparison.js";
const sku="BF-C90SAE-60";
function fixture(){
 const products=[{id:51,default_code:sku,uom_id:[1,"Unidades"]},{id:52,default_code:sku,uom_id:[1,"Unidades"]},{id:53,default_code:"ATS-BAIFA",uom_id:[1,"Unidades"]}];
 const locations=[{id:1,complete_name:"ATR/Stock",warehouse_id:[4,"Atrium"],company_id:[7,"Compañía"]},{id:2,complete_name:"GEN/Stock",warehouse_id:[5,"Generators"],company_id:[7,"Compañía"]}];
 const quants=[{id:1,product_id:51,location_id:1,quantity:1,reserved_quantity:0},{id:2,product_id:52,location_id:2,quantity:2,reserved_quantity:1},{id:3,product_id:53,location_id:2,quantity:8,reserved_quantity:0}];
 const odoo={execute:async()=>({}),searchRead:async(m,d)=>{assert.ok(d.some(x=>x[0]==="company_id"));return m==="stock.quant"?quants:m==="stock.location"?locations:products;}};
 const deps={odoo,readInventory:async()=>({source:"odoo-po-invoices",complete:true,observedAt:new Date().toISOString(),companies:[{id:7}],rows:[{code:sku,name:"Generador",uomId:1,uomLabel:"Unidades",productIds:[51,52],balance:-2,pending:0,creditUnits:5}]}),readCol:async()=>[{code:"SIN-VINCULO",brand:"BAIFA",category:"generador"}]};
 return {deps,products,quants};
}
test("3 físicas en dos almacenes, una reservada, sin sumar saldo −2 ni cinco NC; incluye existencia sin PO",async()=>{
 const {deps}=fixture(),r=await comparison(deps);assert.ok(r.physicalAt);
 const p=r.rows.find(r=>r.code===sku);assert.equal(p.commercial,-2);assert.deepEqual(p.locations.map(l=>[l.name,l.quantity,l.reserved]),[["ATR/Stock",1,0],["GEN/Stock",2,1]]);
 assert.equal(r.rows.find(r=>r.code==="ATS-BAIFA").commercial,null);assert.equal(r.rows.find(r=>r.code==="ATS-BAIFA").locations[0].quantity,8);
 assert.equal(r.rows.find(r=>r.code==="SIN-VINCULO").locations,null);
});
test("incluye repuestos de generadores sin marca y conserva GEN y RMA por separado",async()=>{
 const code="CUM-BOMAGUA4BT",{deps}=fixture();
 deps.readCol=async()=>[{code,brand:"",category:"repuestos_de_generadores",stock:99},
   {code:"NO-GEN",category:"repuestos_de_vehiculos"},{code:"SERV",category:"repuestos_de_generadores",type:"service"}];
 const base=deps.odoo.searchRead;
 deps.odoo.searchRead=async(m,d,...args)=>{
  const rows=await base(m,d,...args);
  if(m==="product.product"&&d.some(x=>Array.isArray(x)&&x[0]==="default_code"&&x[1]==="in"&&x[2].includes(code)))
    return [...rows,{id:54,default_code:code,uom_id:[1,"Unidades"]}];
  if(m==="stock.location")return [...rows,{id:3,complete_name:"RMA-G/Stock",warehouse_id:[6,"RMA"],company_id:[7,"Compañía"]}];
  if(m==="stock.quant")return [...rows,{id:4,product_id:54,location_id:2,quantity:2,reserved_quantity:1},{id:5,product_id:54,location_id:3,quantity:4,reserved_quantity:0}];
  return rows;
 };
 const {rows}=await comparison(deps),pump=rows.find(r=>r.code===code);
 assert.deepEqual(pump.locations.map(l=>[l.name,l.quantity,l.reserved]),[["GEN/Stock",2,1],["RMA-G/Stock",4,0]]);
 assert.equal(pump.commercial,null);assert.ok(!rows.some(r=>["NO-GEN","SERV"].includes(r.code)));
});
test("unidades incompatibles no se agregan; error de Odoo no se interpreta como cero",async()=>{
 const {deps,products,quants}=fixture();products[1].uom_id=[2,"Metros"];assert.equal((await comparison(deps)).rows.find(r=>r.code===sku).locations,null);
 quants.push(quants[0]);const failed=await comparison(deps);assert.equal(failed.physicalAt,null);assert.equal(failed.rows[0].commercial,-2);assert.equal(failed.rows[0].locations,null);
});
test("la consulta no se ejecuta sin acceso a Inventario",async()=>{
 const app=express();app.use((req,res,next)=>{if(req.headers.testuser)req.verifiedUser={level:"vendedor",moduleAccess:"[]"};next();});registerInventoryComparison(app,{});
 const s=app.listen(0,"127.0.0.1");await new Promise(r=>s.once("listening",r));try{
 const url=`http://127.0.0.1:${s.address().port}/api/generators/inventory/comparison`;assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{testuser:"1"}})).status,403);
 }finally{s.close();}
});
