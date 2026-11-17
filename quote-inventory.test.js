import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerSalesDocumentRoutes, SALES_DOCUMENTS_PATH } from "./baifa-sales-documents.js";
import { canAccessPath } from "./secure-access.js";
import { INVENTORY_PATH } from "./baifa-inventory.js";

test("Sales inventory projection: authenticated, minimal, read-only, positive balances, fail closed", async () => {
  const fixture = { ok:true, schemaVersion:1, source:"odoo-po-invoices", complete:true,
    observedAt:"2026-11-17T12:00:00Z", companies:[{id:99,name:"PRIVATE"}],
    rows:[{code:"GEN",available:2,pending:0,orders:["PRIVATE"],invoiced:10},
      {code:"PART",available:0,pending:3,cost:123}, {code:"EMPTY",available:0,pending:0}] };
  let snapshot = fixture, reads = 0;
  const users = {sales:{id:1,moduleAccess:["generators-ventas"]},inventory:{id:2,moduleAccess:["generators-inventario"]},
    partner:{id:3,username:"admin",isPartner:true},admin:{id:4,level:"ceo"},other:{id:5}};
  const app = express();
  registerSalesDocumentRoutes(app, {
    sessions:{authenticate:async req=>users[req.headers.authorization] || null},
    pool:{query(){throw Error("Unexpected database access");}}, readCol(){throw Error("Unexpected catalog access");},
    readInventory:async()=>{reads++; if(snapshot instanceof Error)throw snapshot; return snapshot;},
  });
  const server = app.listen(0); await new Promise(r=>server.once("listening",r));
  const url = `http://127.0.0.1:${server.address().port}${SALES_DOCUMENTS_PATH}/quote-inventory`;
  const get = (auth="sales",tail="",method="GET")=>fetch(url+tail,{method,headers:{Authorization:auth}});
  try {
    for (const [auth,status] of [["",401],["other",403],["inventory",403],["partner",403]])
      assert.equal((await get(auth)).status,status);
    assert.equal(reads,0);
    assert.equal((await get("sales","?company=99")).status,400); assert.equal(reads,0);
    for (const method of ["POST","PUT","PATCH","DELETE"]) assert.equal((await get("sales","",method)).status,404);
    assert.equal(reads,0);
    for (const role of ["sales","admin"]) {
      const response = await get(role);
      assert.equal(response.status,200); assert.equal(response.headers.get("cache-control"),"no-store");
      assert.deepEqual(await response.json(),{ok:true,schemaVersion:1,source:"generators-inventory",complete:true,
        observedAt:fixture.observedAt,rows:[{code:"GEN",available:2,pending:0},{code:"PART",available:0,pending:3}]});
    }
    assert.equal(canAccessPath(users.sales,INVENTORY_PATH,"GET"),false);
    for (const invalid of [
      new Error("secret upstream detail"), {...fixture,complete:false}, {...fixture,schemaVersion:2},
      {...fixture,rows:null}, {...fixture,observedAt:"invalid"},
      {...fixture,rows:[{code:"GEN",available:"2",pending:0}]},
      {...fixture,rows:[{code:"GEN",available:-1,pending:2}]},
      {...fixture,rows:[fixture.rows[0],fixture.rows[0]]},
    ]) {
      snapshot=invalid; const response=await get(); assert.equal(response.status,502);
      const body=await response.text(); assert.doesNotMatch(body,/secret|PRIVATE/);
    }
    snapshot={...fixture,rows:[]};assert.deepEqual((await (await get()).json()).rows,[]);
    snapshot=fixture;assert.equal((await get()).status,200);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});
