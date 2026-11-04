import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {monthRange, summarizeClose, loadMonthlyClose, registerMonthlyClose} from "./baifa-monthly-close.js";
import {canAccessPath} from "./secure-access.js";

const now = new Date("2026-11-04T17:00:00Z");
const range = monthRange("2026-10",now);
const row = {companyId:12,invoiceId:1,lineId:10,invoice:"F1",date:"2026-10-10",type:"out_invoice",
  client:"Cliente",rif:"J123456789",product:"BAIFA",quantity:2,subtotal:100.15,currencyId:1,currency:"USD",digits:2};
const summary = (rows,excluded=[])=>summarizeClose({...range,observedAt:now.toISOString(),rows,excluded});

test("month dates, leap year and Caracas boundary",()=>{
  assert.equal(monthRange("2024-02",now).until,"2024-02-29");
  assert.equal(monthRange("2026-10",new Date("2026-11-01T04:00:00Z")).until,"2026-10-31");
  assert.throws(()=>monthRange("2026-10",new Date("2026-11-01T03:59:59Z")));
  for(const bad of ["2026-11","2026-13","2021-12","2026-1",["2026-10"],undefined])
    assert.throws(()=>monthRange(bad,now));
});
test("deduplicates identities, not SKU; 2-unit invoice remains one document",()=>{
  const d=summary([row,row,{...row,lineId:11,quantity:1,subtotal:50}]);
  assert.equal(d.invoiceCount,1);assert.equal(d.rows.length,2);assert.equal(d.totals[0].invoicedUnits,3);
  assert.equal(d.totals[0].net,150.15);
});
test("credit-only clients and old-sale credits are included by credit date",()=>{
  const d=summary([row,{...row,invoiceId:2,lineId:20,type:"out_refund",rif:"J987654321",quantity:1,subtotal:40.10}]);
  assert.equal(d.creditNoteCount,1);assert.equal(d.clientCount,2);assert.equal(d.totals[0].net,60.05);
  assert.equal(d.totals[0].netUnits,1);
});
test("separate currencies, no implicit FX and no floating 0.1+0.2 defect",()=>{
  const d=summary([{...row,subtotal:.1},{...row,lineId:11,subtotal:.2},
    {...row,lineId:12,currencyId:2,currency:"VES",subtotal:1000}]);
  assert.equal(d.totals.length,2);assert.equal(d.totals[0].net,.3);assert.equal(d.totals[1].net,1000);
});
test("fail closed for contradictory duplicates and missing or non-finite money",()=>{
  assert.throws(()=>summary([row,{...row,subtotal:4}]));
  for(const subtotal of [undefined,null,NaN,Infinity,"100",1e20])
    assert.throws(()=>summary([{...row,subtotal}]));
  assert.throws(()=>summary([{...row,currency:""}]));
  assert.throws(()=>summary([{...row,date:"2026-11-01"}]));
});
test("pending fiscal identity marks partial; intentional internal exclusions do not",()=>{
  assert.equal(summary([row],[{reason:"Sin RIF"}]).complete,false);
  assert.equal(summary([row],[{reason:"Uso interno"}]).complete,true);
  assert.equal(summary([]).invoiceCount,0);assert.deepEqual(summary([]).totals,[]);
});

function mockOdoo(change={}) {
  const calls=[];
  const data={
    "res.company":[{id:12,name:"Copikon Venezuela C.A.",vat:"J294654568"}],
    "product.product":[{id:100,name:"GENERADOR BAIFA 435 KVA",type:"product",categ_id:[60,"GENERADORES ELÉCTRICOS"],uom_id:[1,"Unidades"]}],
    "account.move.line":[{id:10,move_id:[1,"F1"],product_id:[100,"GENERADOR BAIFA 435 KVA"],product_uom_id:[1,"Unidades"],quantity:2,price_subtotal:80000},
      {id:20,move_id:[2,"NC1"],product_id:[100,"GENERADOR BAIFA 435 KVA"],product_uom_id:[1,"Unidades"],quantity:1,price_subtotal:40000}],
    "account.move":[{id:1,name:"F1",invoice_date:"2026-10-31",move_type:"out_invoice",state:"posted",commercial_partner_id:[7,"Cliente"],company_id:[12,"Copikon"],currency_id:[1,"USD"]},
      {id:2,name:"NC1",invoice_date:"2026-10-02",move_type:"out_refund",state:"posted",commercial_partner_id:[8,"Cliente NC"],company_id:[12,"Copikon"],currency_id:[1,"USD"]}],
    "res.partner":[{id:7,name:"Cliente",vat:"J123456789"},{id:8,name:"Cliente NC",vat:"J987654321"}],
    "res.currency":[{id:1,name:"USD",decimal_places:2}],...change,
  };
  return {calls,data,isConfigured:()=>true,execute:async(model,method)=>{
    assert.equal(model,"product.product");assert.equal(method,"fields_get");return {};
  },searchRead:async(model,domain,fields,options)=>{calls.push({model,domain,fields,options});return data[model];}};
}
test("loader reads posted month lines with amounts/UOM; no write methods and includes credit-only client",async()=>{
  const o=mockOdoo(), d=await loadMonthlyClose(o,"2026-10",now);
  assert.equal(d.totals[0].net,40000);assert.equal(d.totals[0].netUnits,1);
  assert.equal(d.clientCount,2);assert.equal(d.complete,true);
  const q=o.calls.find(c=>c.model==="account.move.line");
  assert.ok(q.domain.some(d=>d[0]==="move_id.invoice_date"&&d[2]==="2026-10-31"));
  assert.ok(q.domain.some(d=>d[0]==="move_id.state"&&d[2]==="posted"));
  assert.ok(q.fields.includes("price_subtotal"));
  assert.ok(o.calls.every(c=>c.options.context.active_test===false));
});
test("loader never labels an unverifiable fiscal client complete",async()=>{
  const o=mockOdoo();o.data["res.partner"][1].vat="";
  const d=await loadMonthlyClose(o,"2026-10",now);
  assert.equal(d.complete,false);assert.equal(d.excluded.length,1);assert.equal(d.creditNoteCount,0);
});
for(const [name,mutate] of [
  ["draft",o=>o.data["account.move"][0].state="draft"],
  ["wrong company",o=>o.data["account.move"][0].company_id=[1,"Other"]],
  ["wrong month",o=>o.data["account.move"][0].invoice_date="2026-11-01"],
  ["missing money",o=>delete o.data["account.move.line"][0].price_subtotal],
  ["different UOM",o=>o.data["account.move.line"][0].product_uom_id=[99,"Pack"]],
  ["missing currency",o=>o.data["res.currency"]=[]],
]) test(`loader rejects ${name}`,async()=>{const o=mockOdoo();mutate(o);await assert.rejects(()=>loadMonthlyClose(o,"2026-10",now));});

test("route inherits restrictive role policy, including uppercase paths",()=>{
  const path="/api/generators/clients/odoo-baifa/monthly-close";
  for(const user of [{level:"ceo"},{username:"admin",level:"gerente"}]) assert.equal(canAccessPath(user,path,"GET"),true);
  for(const user of [{level:"employee"},{level:"coordinador"},{level:"partner_externo",username:"admin"},{level:"ceo",isPartner:true}])
    assert.equal(canAccessPath(user,path.toUpperCase(),"GET"),false);
});
test("Express missing session, invalid query and upstream failure remain no-store and non-mutating",async()=>{
  const app=express();
  app.use((req,res,next)=>{if(req.headers["x-test-user"]) req.verifiedUser={id:1};next();});
  registerMonthlyClose(app,{odoo:{isConfigured:()=>false},wrap:fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>res.status(e.status||500).json({message:e.message}))});
  const server=app.listen(0);await new Promise(r=>server.once("listening",r));
  const url=`http://127.0.0.1:${server.address().port}/api/generators/clients/odoo-baifa/monthly-close`;
  try {
    for(const [query,headers,status] of [["?month=2026-10",{},401],["?month=bad",{"x-test-user":"1"},400],
      ["?month=2026-10&extra=1",{"x-test-user":"1"},400],["?month=2026-10",{"x-test-user":"1"},502]]) {
      const r=await fetch(url+query,{headers});assert.equal(r.status,status);assert.equal(r.headers.get("cache-control"),"no-store");
    }
  } finally {await new Promise(r=>server.close(r));}
});
