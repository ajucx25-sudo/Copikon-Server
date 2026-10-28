import test from "node:test";
import assert from "node:assert/strict";
import {isGenerator, buildPlan, loadBaifaCustomers, isBaifaSyncPath, registerBaifaClientSync, fingerprint} from "./baifa-client-sync.js";
import {canAccessPath} from "./secure-access.js";

const source = {
  observedAt: "2026-10-28T20:00:00.000Z",
  customers: [{partner: {id: 7001, name: "Cliente QA", vat: "J-12345678-9", phone: "04240000000", city: "Lara"},
    sales: [{invoiceId: 81, lineId: 901, productId: 100, quantity: 1}], credits: []}],
};
test("only BAIFA complete generators, not parts or services", () => {
  const categ_id = [60, "GENERADORES ELÉCTRICOS"];
  for (const name of ["GENERADOR ELECTRICO BAIFA 50 KVA", "GRUPO ELECTROGENO BAIFA BF110",
    "GENERADOR ELÉCTRICO DIÉSEL MONOFÁSICO: POTENCIA 125 KVA STANDBY//MOTOR CUMMINS//ATS 630A// MARCA BAIFA",
    "GENERADOR ELECTRICO DIESEL 180KVA CAPACIDAD DE ACEITE 16.4L MARCA BAIFA ATS 630A"])
    assert.ok(isGenerator({name,type:"product",categ_id}), name);
  for (const name of ["FILTRO PARA GENERADOR BAIFA", "ALQUILER GENERADOR BAIFA", "TABLERO ATS BAIFA", "ACEITE BAIFA", "GENERADOR OTRA MARCA", "SILENCIADOR GENERADOR BAIFA", "BASE PARA GRUPO ELECTROGENO BAIFA"])
    assert.equal(isGenerator({name,type:"product",categ_id}),false,name);
  assert.equal(isGenerator({name:"GENERADOR BAIFA",type:"service",categ_id}),false);
  assert.ok(isGenerator({name:"GENERADOR 50KVA",x_studio_marca:"BAIFA",type:"product",categ_id}));
  assert.equal(isGenerator({name:"GENERADOR BAIFA",type:"product",categ_id:[99,"REPUESTOS"]}),false);
});
test("plan adds clients, reserves orphan equipment IDs, does not mutate original", () => {
  const existing=[{id:1,name:"Otro cliente",notes:"Conservar"}], snapshot=structuredClone(existing);
  const plan=buildPlan(existing,source,[450]);
  assert.equal(plan.created,1); assert.equal(plan.next[1].id,451); assert.deepEqual(existing,snapshot);
  assert.equal(plan.next[1].region,undefined); assert.equal(plan.next[1].classification,undefined);
  assert.equal(JSON.parse(plan.next[1].odooBaifaSales).invoiceCount,1);
});
test("Odoo ID makes a repeat import idempotent and preserves local fields", () => {
  const first=buildPlan([{id:5,name:"Local",odooId:7001,phone:"Local phone",notes:"Keep"}],source);
  const second=buildPlan(first.next,source);
  assert.equal(second.created,0); assert.equal(second.next.length,1); assert.equal(second.next[0].name,"Local");
  assert.equal(second.next[0].phone,"Local phone"); assert.equal(second.next[0].notes,"Keep");
});
test("unique normalized RIF matches but conflicting Odoo partner or duplicate RIF blocks", () => {
  assert.equal(buildPlan([{id:2,rif:"J123456789",name:"Existing"}],source).created,0);
  assert.equal(buildPlan([{id:2,rif:"J123456789",odooId:999}],source).conflicts.length,1);
  assert.equal(buildPlan([{id:2,rif:"J123456789"},{id:3,rif:"J-12345678-9"}],source).conflicts.length,1);
  assert.equal(buildPlan([{id:2,odooId:7001},{id:3,odooId:7001}],source).conflicts.length,1);
  assert.equal(buildPlan([{id:2,odooId:7001,rif:"J123456789"},{id:3,rif:"J123456789"}],source).conflicts.length,1);
});
test("strict route authorization, including uppercase and external admin lookalikes", () => {
  const route="/api/generators/clients/odoo-baifa/import";
  assert.ok(isBaifaSyncPath(route.toUpperCase()));
  assert.ok(canAccessPath({level:"ceo"},route,"POST"));
  for (const user of [{level:"coordinador"},{level:"employee"},{level:"partner_externo",username:"admin"},{level:"ceo",isPartner:true}])
    assert.equal(canAccessPath(user,route,"POST"),false);
});
test("read-only historical source includes old/current Copikon, archived products, posted invoices and credit evidence", async () => {
  const calls=[];
  const odoo={isConfigured:()=>true,execute:async(model,method)=>{assert.equal(method,"fields_get");return {x_studio_marca:{type:"char"}};},
    searchRead:async(model,domain,fields,opts)=>{
      calls.push({model,domain,opts});
      if(model==="res.company")return [{id:1,name:"COPIKON VENEZUELA, C.A. J294654568",vat:"J294654568"},{id:12,name:"COPIKON C.A. J294654568",vat:"J294654568"},{id:6,name:"Otra empresa",vat:"J294654568"}];
      if(model==="product.product")return [{id:100,name:"GENERADOR BAIFA",type:"product",categ_id:[60,"GENERADORES ELÉCTRICOS"]},{id:101,name:"FILTRO BAIFA",type:"product",categ_id:[99,"REPUESTOS"]}];
      if(model==="account.move.line")return [{id:901,move_id:[81,"F1"],product_id:[100,"BAIFA"],quantity:1},{id:902,move_id:[82,"NC1"],product_id:[100,"BAIFA"],quantity:1}];
      if(model==="account.move")return [{id:81,name:"F1",invoice_date:"2022-01-01",state:"posted",move_type:"out_invoice",commercial_partner_id:[7001,"QA"],company_id:[1,"COPIKON"]},
        {id:82,name:"NC1",invoice_date:"2023-01-01",state:"posted",move_type:"out_refund",commercial_partner_id:[7001,"QA"],company_id:[12,"COPIKON"]}];
      if(model==="res.partner")return [source.customers[0].partner];
      throw Error("Unexpected model");
    }};
  const data=await loadBaifaCustomers(odoo);
  assert.equal(data.customers.length,1); assert.equal(data.creditNoteCount,1);
  assert.equal(data.excludedProducts.length,1); assert.deepEqual(data.companies.map(c=>c.id),[1,12]);
  const lineCall=calls.find(c=>c.model==="account.move.line");
  assert.ok(lineCall.domain.some(d=>d[0]==="move_id.invoice_date"&&d[2]==="2022-01-01"));
  assert.ok(lineCall.domain.some(d=>d[0]==="move_id.state"&&d[2]==="posted"));
  assert.ok(lineCall.domain.some(d=>d[0]==="move_id.invoice_date"&&d[1]==="<="));
  assert.ok(calls.every(c=>c.opts.context.active_test===false));
  assert.ok(calls.filter(c=>c.model!=="res.company").every(c=>JSON.stringify(c.opts.context.allowed_company_ids)==="[1,12]"));
});
test("missing source configuration fails closed", async()=> {
  await assert.rejects(loadBaifaCustomers({isConfigured:()=>false}),/configurado/);
});
test("import rejects malformed payload before database connection", async()=>{
  const handlers={};
  registerBaifaClientSync({get:(p,h)=>handlers[p]=h,post:(p,h)=>handlers[p]=h},
    {odoo:{},readCol:()=>{},pool:{connect:()=>{throw Error("Must not connect");}},wrap:fn=>fn});
  const response={status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await handlers["/api/generators/clients/odoo-baifa/import"]({body:{previewToken:"x",extra:true}},response);
  assert.equal(response.code,400);
  await handlers["/api/generators/clients/odoo-baifa/import"]({body:{previewToken:"a".repeat(48)},verifiedUser:{id:1}},response);
  assert.equal(response.code,409);
});
test("fingerprints detect local changes",()=>assert.notEqual(fingerprint([{id:1,name:"A"}]),fingerprint([{id:1,name:"B"}])));
