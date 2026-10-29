import test from "node:test";
import assert from "node:assert/strict";
import {isGenerator, buildPlan, loadBaifaCustomers, isBaifaSyncPath, registerBaifaClientSync, fingerprint, fiscalIdentity, consolidateCustomers} from "./baifa-client-sync.js";
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
    "[BF-C110S-60] GENERADOR DIESEL BAIFA 1250KVA",
    "GENERADOR DIESEL BAIFA // 1250KVA // INCLUYE 1000HRS DE PIEZAS DE MANTENIMIENTO",
    "GENERADOR ELECTRICO DIESEL 180KVA CAPACIDAD DE ACEITE 16.4L MARCA BAIFA ATS 630A"])
    assert.ok(isGenerator({name,type:"product",categ_id}), name);
  for (const name of ["FILTRO PARA GENERADOR BAIFA", "ALQUILER GENERADOR BAIFA", "TABLERO ATS BAIFA", "ACEITE BAIFA", "GENERADOR OTRA MARCA", "SILENCIADOR GENERADOR BAIFA", "BASE PARA GRUPO ELECTROGENO BAIFA", "GENERADOR BAIFA // ALQUILER", "GENERADOR BAIFA // SERVICIO DE MANTENIMIENTO", "GENERADOR BAIFA // REPUESTOS"])
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

test("fiscal identity requires explicit consistent evidence, never fuzzy names",()=>{
  assert.equal(fiscalIdentity({name:"Cliente",vat:"J-12345678-9"}).rif,"J123456789");
  assert.equal(fiscalIdentity({name:"Cliente J123456789",vat:false}).rif,"J123456789");
  assert.equal(fiscalIdentity({name:"Cliente J123456789",vat:"123456789"}).rif,"J123456789");
  for(const p of [{name:"Cliente"}, {name:"Cliente J123",vat:false},
    {name:"Cliente J123456789",vat:"J999999999"}, {name:"Cliente J123456789",vat:"INVALID"}])
    assert.equal(fiscalIdentity(p).rif,undefined);
});
test("consolidates explicit RIF across historical/current IDs, preserves history and is repeatable",()=>{
  const other=structuredClone(source.customers[0]);
  other.partner={id:9001,name:"Cliente actual J123456789",vat:false};
  other.sales=[{invoiceId:82,lineId:902,companyId:12,quantity:1}];
  other.credits=[{invoiceId:83,lineId:903,companyId:12,quantity:1}];
  const s={...source,customers:[...source.customers,other]};
  const original=[{id:45,odooId:7001,name:"Nombre local",rif:"J-12345678-9",notes:"Conservar"}];
  const plan=buildPlan(original,s,[450]);
  assert.equal(plan.created,0);assert.equal(plan.updated,1);assert.equal(plan.conflicts.length,0);
  assert.equal(plan.next.length,1);assert.equal(plan.next[0].odooId,7001);
  assert.equal(plan.next[0].name,"Nombre local");assert.equal(plan.next[0].notes,"Conservar");
  const evidence=JSON.parse(plan.next[0].odooBaifaSales);
  assert.deepEqual(evidence.sourcePartnerIds,[7001,9001]);assert.equal(evidence.sales.length,2);assert.equal(evidence.credits.length,1);
  assert.deepEqual(buildPlan(plan.next,s).next,plan.next);
  assert.equal(buildPlan([{id:1,odooId:7001,rif:"J999999999"}],s).conflicts.length,1);
  const creditOnly={...other,sales:[]};
  const withCreditAlias=buildPlan([],{...source,customers:[source.customers[0],creditOnly]});
  assert.equal(withCreditAlias.actions.length,1);
  assert.equal(JSON.parse(withCreditAlias.next[0].odooBaifaSales).credits.length,1);
  assert.equal(buildPlan([],{...source,customers:[creditOnly]}).actions.length,0);
});
test("excludes internal use and leaves unverified identity pending without touching local records",()=>{
  const c=source.customers[0];
  const customers=[c,{...c,partner:{id:2,name:"Uso Interno Copikon Venezuela C.A.",vat:"J294654568"}},
    {...c,partner:{id:3,name:"Sin identificación",vat:false}}];
  const grouped=consolidateCustomers(customers);
  assert.equal(grouped.customers.length,1);assert.equal(grouped.pending.length,1);assert.equal(grouped.excluded.length,1);
  const original=[{id:8,name:"Otra ficha",notes:"No borrar"}];
  const result=buildPlan(original,{...source,customers},[450]);
  assert.equal(result.next.length,2);assert.deepEqual(result.next[0],original[0]);assert.equal(result.next[1].id,451);
});
