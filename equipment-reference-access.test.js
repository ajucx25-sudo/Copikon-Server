import test from "node:test";
import assert from "node:assert/strict";
import {isEquipmentDocumentResource,isEquipmentResource,validateEquipmentDocuments} from "./equipment-reference-access.js";
import {requiresCollectionTransaction} from "./client-collection-transactions.js";
import {canAccessPath} from "./secure-access.js";

const park=[{id:1,clientId:10,source:"odoo-baifa-sales"}];
const check=row=>validateEquipmentDocuments([{id:1,...row}],[],park);
test("sold equipment must exist and belong to the document client",()=>{
  assert.doesNotThrow(()=>check({clientId:10,clientEquipmentId:1,source:"venta"}));
  assert.throws(()=>check({clientId:10,clientEquipmentId:2}),/no existe/);
  assert.throws(()=>check({clientId:11,clientEquipmentId:1}),/otro cliente/);
  assert.throws(()=>check({clientEquipmentId:1}),/Selecciona/);
});
test("nested and plural references are validated",()=>{
  assert.doesNotThrow(()=>check({clientId:10,equipments:[{kind:"venta",equipmentId:1}]}));
  assert.throws(()=>check({clientId:11,equipments:[{kind:"venta",equipmentId:1}]}),/otro cliente/);
  assert.throws(()=>check({clientId:10,items:[{clientEquipmentIds:[1,2]}]}),/no existe/);
  assert.throws(()=>check({clientId:10,items:[{clientId:11,clientEquipmentId:1}]}),/otro cliente/);
});
test("rental/external domain remains separate, but cannot masquerade as clientEquipmentId",()=>{
  assert.doesNotThrow(()=>check({clientId:10,equipments:[{kind:"alquiler",equipmentId:999},{kind:"externo",equipmentId:888}]}));
  assert.throws(()=>check({clientId:10,source:"alquiler",clientEquipmentId:1}),/tipo incompatible/);
  assert.throws(()=>check({clientId:10,equipments:[{kind:"arbitrary",equipmentId:1}]}),/no reconocido/);
});
test("strict reference IDs and structures",()=>{
  for(const value of [true,{},[],0,-1,"1e0","1.0",""]) assert.throws(()=>check({clientId:10,clientEquipmentId:value}),/inválida/);
  assert.throws(()=>check({clientId:10,clientEquipmentIds:"[1]"}),/arreglo/);
  assert.throws(()=>check({clientId:10,equipments:'[{"kind":"venta","equipmentId":1}]'}),/arreglo/);
});
test("documents without equipment references retain ordinary workflows",()=>{
  assert.doesNotThrow(()=>check({clientName:"Manual",items:[{productId:9,quantity:2}],source:"interno"}));
});
test("unchanged historical orphans remain intact, but edits are revalidated",()=>{
  const rows=[{id:1,clientId:10,clientEquipmentId:999}];
  assert.doesNotThrow(()=>validateEquipmentDocuments(rows,structuredClone(rows),park));
  assert.throws(()=>validateEquipmentDocuments([{...rows[0],clientId:11}],rows,park),/no existe/);
});
for(const path of ["/api/erp/maintenance-orders","/api/erp/maintenance-plans","/api/erp/maintenance-contracts",
  "/api/erp/service-contracts","/api/erp/sales-invoices"]) test(`auth and locking ${path}`,()=>{
  assert(isEquipmentDocumentResource(path.toUpperCase()+"/1/"));
  for(const method of ["POST","PATCH","PUT","DELETE"]) assert(requiresCollectionTransaction(path+"/1",method));
  for(const method of ["GET","HEAD","POST","PATCH","PUT","DELETE"]) {
    assert(!canAccessPath(null,path,method));
    assert(!canAccessPath({level:"employee",moduleAccess:["logistica-nacional"]},path,method));
    assert(!canAccessPath({level:"ceo",isPartner:true},path,method));
    assert(canAccessPath({level:"employee",moduleAccess:["generators-tecnico"]},path,method));
  }
});
test("equipment collection and item reads are limited to authorized internal readers",()=>{
  for(const path of ["/api/erp/client-equipment","/API/ERP/CLIENT-EQUIPMENT/1/"]) {
    assert(isEquipmentResource(path));
    for(const method of ["GET","HEAD"]) {
      assert(!canAccessPath(null,path,method));
      assert(!canAccessPath({level:"employee",moduleAccess:[]},path,method));
      assert(!canAccessPath({level:"ceo",isPartner:true},path,method));
      assert(canAccessPath({level:"coordinador"},path,method));
      assert(canAccessPath({level:"employee",moduleAccess:["generators-posventa"]},path,method));
    }
  }
});
