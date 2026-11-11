import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {readFileSync} from "node:fs";
import {reconcileInventory, loadInventory, registerInventory, INVENTORY_PATH, safeInventoryReason} from "./baifa-inventory.js";
import {canAccessPath} from "./secure-access.js";

const fixture = () => ({
  companyIds:[91],until:"2026-11-10",
  products:[{id:10,default_code:"TEST-GEN",uom_id:[1,"Units"]}],
  orders:[{id:20,name:"PO-TEST",state:"purchase",company_id:[91,"Test"]}],
  purchaseLines:[{id:30,order_id:[20,"PO-TEST"],product_id:[10,"Test"],product_qty:10,qty_received:6,product_uom:[1,"Units"]}],
  invoices:[{id:40,state:"posted",company_id:[91,"Test"],move_type:"out_invoice",invoice_date:"2026-10-10"}],
  invoiceLines:[{id:50,move_id:[40,"Test"],product_id:[10,"Test"],product_uom_id:[1,"Units"],quantity:2}],
});
test("Partial PO: 6 received - 2 invoiced = 4 available, 4 pending, no repeat subtraction",()=>{
  const f=fixture(), before=JSON.stringify(f), r=reconcileInventory(f).rows[0];
  assert.deepEqual([r.received,r.invoiced,r.available,r.pending],[6,2,4,4]);
  assert.deepEqual(reconcileInventory(f),reconcileInventory(f));
  assert.equal(JSON.stringify(f),before);
});
test("Closed PO retains receipts, no unreceived balance in transit",()=>{
  const f=fixture();f.orders[0].state="done";
  const r=reconcileInventory(f).rows[0];assert.equal(r.available,4);assert.equal(r.pending,0);
});
test("Full receipt and overreceipt never negative transit",()=>{
  for(const qty of [10,12]) { const f=fixture();f.purchaseLines[0].qty_received=qty;
    const r=reconcileInventory(f).rows[0];assert.equal(r.pending,0);assert.equal(r.available,qty-2); }
});
test("Credit does not imply physical return",()=>{
  const f=fixture();f.invoices[0].move_type="out_refund";
  const r=reconcileInventory(f).rows[0];assert.equal(r.available,6);assert.equal(r.creditUnits,2);assert.equal(r.review,true);
});
test("Negative balance remains visible, not sellable",()=>{
  const f=fixture();f.invoiceLines[0].quantity=8;
  const r=reconcileInventory(f).rows[0];assert.equal(r.balance,-2);assert.equal(r.available,0);assert.equal(r.review,true);
});
test("Identical repeated lines deduplicated",()=>{
  const f=fixture();f.purchaseLines.push(structuredClone(f.purchaseLines[0]));f.invoiceLines.push(structuredClone(f.invoiceLines[0]));
  assert.equal(reconcileInventory(f).rows[0].available,4);
});
test("Contradictory duplicates rejected in both orders",()=>{
  for(const reverse of [false,true]) { const f=fixture();f.invoiceLines.push({...f.invoiceLines[0],quantity:3});
    if(reverse)f.invoiceLines.reverse();assert.throws(()=>reconcileInventory(f),/contradictorio/); }
});
test("Exact SKU combines old/new Odoo IDs, without fuzzy aliases",()=>{
  const f=fixture();f.products.push({id:11,default_code:"TEST-GEN",uom_id:[1,"Units"]});
  f.invoiceLines[0].product_id=[11,"Test"];assert.equal(reconcileInventory(f).rows[0].available,4);
  f.products[1].default_code="TESTGEN";assert.equal(reconcileInventory(f).rows.length,2);
});
for(const state of ["draft","sent","to approve","cancel"]) test(`Reject PO state ${state}`,()=>{
  const f=fixture();f.orders[0].state=state;assert.throws(()=>reconcileInventory(f));
});
for(const state of ["draft","cancel"]) test(`Reject invoice state ${state}`,()=>{
  const f=fixture();f.invoices[0].state=state;assert.throws(()=>reconcileInventory(f));
});
for(const qty of [NaN,Infinity,-1,"2",null]) test(`Invalid quantity ${String(qty)}`,()=>{
  const f=fixture();f.purchaseLines[0].qty_received=qty;assert.throws(()=>reconcileInventory(f));
});
test("Foreign company on either document rejected",()=>{
  for(const key of ["orders","invoices"]) {const f=fixture();f[key][0].company_id=[92,"Other"];assert.throws(()=>reconcileInventory(f));}
});
test("Different UOM and missing records rejected",()=>{
  for(const mutate of [
    f=>f.invoiceLines[0].product_uom_id=[2,"Box"],f=>f.purchaseLines[0].product_uom=[2,"Box"],
    f=>f.orders=[],f=>f.invoices=[],f=>f.products[0].id="10",f=>f.products[0].default_code="",
    f=>f.invoices[0].invoice_date="2027-01-01",
  ]) { const f=fixture();mutate(f);assert.throws(()=>reconcileInventory(f));}
});
test("Roles match inventory tab and exclude external partners and mutations",()=>{
  for(const user of [{level:"ceo"},{username:"admin"},{moduleAccess:["generators-inventario"]}]) {
    assert.equal(canAccessPath(user,INVENTORY_PATH,"GET"),true);
    for(const method of ["POST","PATCH","DELETE","PUT"])assert.equal(canAccessPath(user,INVENTORY_PATH,method),false);
  }
  for(const user of [{},{moduleAccess:["generators-ventas"]},{level:"ceo",isPartner:true},{username:"admin",level:"partner_externo"}])
    assert.equal(canAccessPath(user,INVENTORY_PATH,"GET"),false);
});
function mockOdoo() {
  const f=fixture(), calls=[];
  const data={
    "res.company":[{id:91,name:"COPIKON C.A.",vat:"J294654568"}],
    "product.product":[{...f.products[0],name:"GENERADOR BAIFA TEST",type:"product",categ_id:[2,"Generadores eléctricos"]}],
    "purchase.order.line":f.purchaseLines, "purchase.order":f.orders,
    "account.move.line":f.invoiceLines, "account.move":f.invoices,
  };
  const matches = (model,row,domain) => {
    const get = key => {
      const parent = model === "purchase.order.line" ? data["purchase.order"].find(o=>o.id===row.order_id?.[0]) :
        model === "account.move.line" ? data["account.move"].find(o=>o.id===row.move_id?.[0]) : null;
      const val = key.includes(".") ? parent?.[key.split(".")[1]] : row[key] ?? (key==="company_id" ? parent?.company_id : undefined);
      return Array.isArray(val) ? val[0] : val;
    };
    let pos=0;
    const evaluate=()=>{
      const c=domain[pos++];
      if(c==="|" || c==="&") {const a=evaluate(),b=evaluate();return c==="|" ? a||b : a&&b;}
      const [key,op,wanted]=c, v=get(key);
      if(op==="in")return wanted.includes(v);
      if(op==="=")return v===wanted;
      if(op==="!=")return wanted===false ? !!v : v!==wanted;
      if(op==="<=")return v<=wanted;
      if(op==="ilike")return String(v||"").toUpperCase().includes(String(wanted).toUpperCase());
      if(op==="=ilike")return String(v||"").toUpperCase().startsWith(wanted.replace(/%$/,"").toUpperCase());
      throw Error(`Unimplemented mock operator ${op}`);
    };
    const results=[];while(pos<domain.length)results.push(evaluate());return results.every(Boolean);
  };
  return {calls,data,isConfigured:()=>true,execute:async(...args)=>{calls.push(args);assert.equal(args[1],"fields_get");return {};},
    searchRead:async(model,domain,fields,opts)=>{calls.push([model,domain,fields,opts]);
      return data[model].filter(row=>matches(model,row,domain)).slice(opts.offset,opts.offset+opts.limit);}};
}
test("Loader: complete historical read, confirmed/posted, company and product scope, read-only",async()=>{
  const o=mockOdoo(),result=await loadInventory(o,new Date("2026-11-10T12:00:00Z"));
  assert.equal(result.rows[0].available,4);assert.equal(result.source,"odoo-po-invoices");
  const po=o.calls.find(c=>c[0]==="purchase.order.line")[1], inv=o.calls.find(c=>c[0]==="account.move.line")[1];
  assert.ok(po.some(c=>c[0]==="order_id.state" && c[2].includes("done")));
  assert.ok(inv.some(c=>c[0]==="move_id.state"&&c[2]==="posted"));
  assert.ok(!inv.some(c=>c[0]==="move_id.invoice_date"&&c[1]===">="));
  for(const domain of [po,inv]) {
    assert.ok(domain.some(c=>c[0]==="company_id"&&c[2][0]===91));
    assert.ok(domain.some(c=>c[0]==="product_id"&&c[2][0]===10));
  }
});
test("Loader fails closed for missing company and missing invoice",async()=>{
  for(const key of ["res.company","account.move"]) {
    const o=mockOdoo(),read=o.searchRead;
    o.searchRead=(model,...args)=>model===key ? Promise.resolve([]) : read(model,...args);
    await assert.rejects(loadInventory(o));
  }
});

test("Whole BAIFA PO includes unbranded spares, ATS and consumables, excludes services and other POs",async()=>{
  const o=mockOdoo(),d=o.data;
  d["product.product"].push(
    {id:11,name:"Filtro sintético",default_code:"TEST-PART",type:"product",uom_id:[1,"Units"]},
    {id:12,name:"ATS BAIFA TEST",default_code:"CATS100ABF-TEST",type:"product",uom_id:[1,"Units"]},
    {id:13,name:"Cable",default_code:"TEST-CABLE",type:"consu",uom_id:[2,"m"]},
    {id:14,name:"Servicio BAIFA TEST",default_code:"TEST-SERVICE",type:"service",uom_id:[1,"Units"]},
  );
  for(const [pid,qty,uom] of [[11,7,1],[12,3,1],[13,12,2],[14,1,1]])
    d["purchase.order.line"].push({id:30+pid,order_id:[20,"PO-TEST"],product_id:[pid,"Test"],product_qty:qty,qty_received:qty-1,product_uom:[uom,"Unit"]});
  d["purchase.order"].push({id:21,name:"PO-OTHER",state:"purchase",company_id:[91,"Test"]});
  d["purchase.order.line"].push({id:99,order_id:[21,"Other"],product_id:[11,"Part"],product_qty:100,qty_received:100,product_uom:[1,"Units"]});
  const r=await loadInventory(o);
  assert.equal(r.rows.find(r=>r.code==="TEST-PART").received,6);
  assert.equal(r.rows.find(r=>r.code==="CATS100ABF-TEST").available,2);
  assert.equal(r.rows.find(r=>r.code==="TEST-CABLE").uomLabel,"m");
  assert.ok(!r.rows.some(r=>r.code==="TEST-SERVICE"));
  assert.ok(!r.rows.some(r=>r.orders.some(o=>o.orderId===21)));
});
test("BAIFA spare-only PO and historical exact-SKU invoice identity are included",async()=>{
  const o=mockOdoo(),d=o.data;
  d["product.product"][0].name="Filtro BAIFA TEST";
  d["product.product"].push({...d["product.product"][0],id:15,name:"Historical filter"});
  d["account.move.line"][0].product_id=[15,"Historical filter"];
  const r=await loadInventory(o);
  assert.equal(r.rows[0].available,4);
  assert.deepEqual(r.rows[0].productIds,[10,15]);
});
test("Unused BAIFA catalog template without SKU is not an inventory item",async()=>{
  const o=mockOdoo();
  o.data["product.product"].push({id:19,name:"BAIFA template",default_code:false,type:"consu",uom_id:[1,"Units"]});
  const result=await loadInventory(o);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].available,4);
  assert.ok(!result.rows.some(r=>r.productIds.includes(19)));
});
test("Missing SKU on an actual selected PO still fails closed",async()=>{
  const o=mockOdoo();
  o.data["product.product"].push({id:19,name:"BAIFA template",default_code:false,type:"consu",uom_id:[1,"Units"]});
  o.data["purchase.order.line"].push({id:39,order_id:[20,"PO-TEST"],product_id:[19,"Template"],product_qty:1,qty_received:1,product_uom:[1,"Units"]});
  await assert.rejects(loadInventory(o),e=>safeInventoryReason(e)==="SKU_MISSING");
});
test("No confirmed PO means no opening stock, even for seeded products",async()=>{
  const o=mockOdoo();
  o.data["purchase.order.line"]=[];
  assert.deepEqual((await loadInventory(o)).rows,[]);
});
test("Whole PO read cannot omit seed lines or inject an unrelated order",async()=>{
  for(const inject of [false,true]) {
    const o=mockOdoo(),read=o.searchRead;
    o.searchRead=async(model,domain,...args)=>{
      const result=await read(model,domain,...args);
      if(model==="purchase.order.line" && domain.some(c=>c[0]==="order_id"))
        return inject ? [{...result[0],order_id:[999,"Foreign"]}] : [];
      return result;
    };
    await assert.rejects(loadInventory(o));
  }
});
test("Actual Express route: anonymous 401, invalid query before reads, valid response",async()=>{
  const app=express(),o=mockOdoo();
  app.use((req,res,next)=>{if(req.headers["x-test-user"])req.verifiedUser={level:"ceo"};next();});
  registerInventory(app,{odoo:o,wrap:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next)});
  const server=app.listen(0);await new Promise(resolve=>server.once("listening",resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}${INVENTORY_PATH}`;
    assert.equal((await fetch(base)).status,401);assert.equal(o.calls.length,0);
    assert.equal((await fetch(base+"?company=92",{headers:{"x-test-user":"1"}})).status,400);assert.equal(o.calls.length,0);
    const res=await fetch(base,{headers:{"x-test-user":"1"}});
    assert.equal(res.headers.get("cache-control"),"no-store");assert.equal((await res.json()).rows[0].available,4);
  } finally {await new Promise(r=>server.close(r));}
});
test("Production authentication runs before new route registration",()=>{
  const s=readFileSync(new URL("./server.js",import.meta.url),"utf8");
  assert.ok(s.indexOf("const protectedPath = isInventoryPath(path)") < s.indexOf("registerBaifaInventory(app,"));
  assert.ok(s.indexOf("sessions.authenticate(req)") < s.indexOf("registerBaifaInventory(app,"));
});
test("Safe validation reason never echoes upstream errors or arbitrary details",()=>{
  assert.equal(safeInventoryReason(new Error("private upstream detail")),"UPSTREAM_READ_FAILED");
  assert.equal(safeInventoryReason({inventoryReason:"untrusted detail"}),"UPSTREAM_READ_FAILED");
  assert.equal(safeInventoryReason({inventoryReason:"SKU_MISSING"}),"SKU_MISSING");
  assert.equal(INVENTORY_PATH,"/api/generators/inventory/baifa-stock");
});
