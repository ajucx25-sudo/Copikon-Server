import test from "node:test";
import assert from "node:assert/strict";
import {canAccessPath} from "./secure-access.js";
import {requiresCollectionTransaction} from "./client-collection-transactions.js";
import {planLocationContact} from "./posventa-location-contact.js";
const path="/api/generators/posventa/equipment/10/location-contact",equipment=[{id:10,clientId:12,active:true}],clients=[{id:12}];
const plan=(b,e=equipment,c=clients)=>planLocationContact(b,e,c,"10");
test("Permiso específico de Posventa: no abre el editor general ni rutas de gestión",()=>{
 const staff={level:"empleado",moduleAccess:["generators-posventa"]};assert(canAccessPath(staff,path,"PATCH"));
 for(const u of [null,{...staff,isPartner:true},{...staff,level:"partner_externo"},{...staff,moduleAccess:["generators-mantenimiento"]}])assert(!canAccessPath(u,path,"PATCH"));
 assert(!canAccessPath(staff,path,"POST"));assert(!canAccessPath(staff,path.replace("/location-contact",""),"PATCH"));
 assert(!canAccessPath(staff,"/api/erp/clients/12","PATCH"));assert(requiresCollectionTransaction(path,"PATCH"));
});
test("Campos separados, sin reasignar cliente ni modificar otros datos",()=>{
 assert.deepEqual(plan({location:" Sede B ",contact:" Ana ",expectedClientId:12}).result,{equipmentId:10,clientId:12,location:"Sede B",contact:"Ana"});
 assert.deepEqual(plan({location:" "},equipment,[]).result,{equipmentId:10,clientId:null,location:null});
 for(const b of [{contact:"Ana"},{contact:"Ana",expectedClientId:13}])assert.equal(plan(b).status,409);
 for(const b of [{contact:"Ana",expectedClientId:12,invoiceNumber:"X"},{location:42},{contact:"x".repeat(251)},{location:"x".repeat(1001)},{}])assert.equal(plan(b).status,400);
 for(const p of [{source:"externo"},{source:"alquiler"},{active:false}])assert.equal(plan({location:"A"},[{...equipment[0],...p}]).status,404);
});
