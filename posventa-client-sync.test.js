import test from "node:test";
import assert from "node:assert/strict";
import {planPosventaClientSync,POSVENTA_SYNC_PATH} from "./posventa-client-sync.js";
import {canAccessPath} from "./secure-access.js";
import {requiresCollectionTransaction} from "./client-collection-transactions.js";
import {isPosventaEquipmentPath} from "./equipment-edit-access.js";

const now = "2026-10-29T20:00:00Z";
const sale = (overrides={}) => ({companyId:12,invoiceId:100,lineId:200,productId:300,
  invoice:"INV/2026/100",date:"2026-10-20",product:"[BF90] GENERADOR BAIFA",quantity:2,...overrides});
const client = ({sales=[sale()],credits=[],...overrides}={}) => ({id:1,name:"Cliente de prueba",syncStatus:"synced",
  odooBaifaSales:JSON.stringify({since:"2022-01-01",invoiceCount:1,policyVersion:"rif-consolidation-2026-10-29",
    observedAt:now,sales,credits}),...overrides});
const plan = (c=[client()],e=[],options={}) => planPosventaClientSync(c,e,{now,...options});

test("quantity two creates two distinct units without operational guesses",()=>{
  const p=plan(); assert.equal(p.additions.length,2);
  assert.deepEqual(p.additions.map(r=>r.odooUnitKey),["odoo:12:100:200:1","odoo:12:100:200:2"]);
  for(const r of p.additions) for(const key of ["serial","installedAt","commissionedAt","warrantyMonths","location"]) assert.equal(r[key],null);
});
test("repeat is idempotent and preserves edited fields exactly",()=>{
  const existing=plan().additions;Object.assign(existing[0],{invoiceNumber:"EDITED",installedAt:"2026-10-21",serial:"S1",warrantyMonths:24});
  const before=structuredClone(existing);const p=plan(undefined,existing);
  assert.equal(p.result.created,0);assert.equal(p.result.alreadyExisting,2);assert.deepEqual(existing,before);
});
test("source and equipment inputs are not mutated",()=>{
  const c=[client()];const old=structuredClone(c);plan(c);assert.deepEqual(c,old);
});
test("credit clients require review; an earlier import is not authorization for new units",()=>{
  const existing=plan().additions.slice(0,1);
  const p=plan([client({credits:[{invoice:"NC1"}]})],existing);
  assert.equal(p.result.alreadyExisting,1);assert.equal(p.result.pendingCreditUnits,1);assert.equal(p.result.created,0);
});
test("duplicate source rows do not duplicate equipment",()=>assert.equal(plan([client({sales:[sale(),sale()]})]).result.created,2));
for(const reverse of [false,true]) test(`invalid duplicate quarantines valid line, reverse=${reverse}`,()=>{
  const sales=[sale(),sale({quantity:0})];if(reverse)sales.reverse();
  const p=plan([client({sales})]);assert.equal(p.result.created,0);assert.equal(p.result.issues.length,1);
});
test("contradictory duplicate across clients is held",()=>{
  const p=plan([client(),client({id:2,name:"Otro"})]);assert.equal(p.result.created,0);assert.equal(p.result.issues.length,1);
});
for(const quantity of [0,-1,1.5,"2",true,1001]) test(`reject quantity ${JSON.stringify(quantity)}`,()=>{
  assert.equal(plan([client({sales:[sale({quantity})]})]).result.created,0);
});
for(const bad of [true,[],{},0,-1,"1e2","1.0"]) test(`strict ID ${JSON.stringify(bad)}`,()=>{
  assert.equal(plan([client({sales:[sale({invoiceId:bad})]})]).result.created,0);
});
for(const date of ["2026-02-30","2021-12-31","2027-01-01","bad"]) test(`date ${date}`,()=>{
  assert.equal(plan([client({sales:[sale({date})]})]).result.created,0);
});
test("only synchronized BAIFA clients",()=>{
  assert.equal(plan([client({syncStatus:"manual"})]).result.created,0);
  assert.equal(plan([client({odooBaifaSales:"{}"})]).result.created,0);
});
test("malformed credits are not treated as an empty credit history",()=>{
  assert.equal(plan([client({credits:null})]).result.created,0);
});
test("manual equipment with same invoice blocks automatic association",()=>{
  const p=plan(undefined,[{id:8,clientId:1,invoiceNumber:"inv/2026/100",active:true}]);
  assert.equal(p.result.created,0);assert.equal(p.result.pendingConflictUnits,2);
});
test("duplicate existing key fails closed",()=>{
  const [a]=plan().additions;assert.throws(()=>plan(undefined,[a,{...a,id:9}]),/repetidas/);
});
test("duplicate existing IDs fail closed",()=>{
  assert.throws(()=>plan(undefined,[{id:1},{id:1}]),/identificadores/);
});
test("existing key associated with different client is not reassigned",()=>{
  const [a]=plan().additions;const p=plan(undefined,[{...a,clientId:5}]);
  assert.equal(p.result.pendingConflictUnits,1);assert.equal(p.result.created,1);
});
test("inactive source-key equipment is not resurrected",()=>{
  const rows=plan().additions.map(r=>({...r,active:false}));
  assert.equal(plan(undefined,rows).result.created,0);
});
test("historical document equipment references reserve IDs",()=>{
  assert.deepEqual(plan(undefined,[],{reservedIds:[90,"200",null]}).additions.map(x=>x.id),[201,202]);
});
test("total limit fails whole operation instead of partial import",()=>{
  const sales=Array.from({length:11},(_,i)=>sale({lineId:200+i,quantity:1000}));
  assert.throws(()=>plan([client({sales})]),/10.000 unidades/);
});
test("new path is authenticated, management-only and transaction-wrapped",()=>{
  assert(isPosventaEquipmentPath(POSVENTA_SYNC_PATH));assert(requiresCollectionTransaction(POSVENTA_SYNC_PATH,"POST"));
  for(const user of [{level:"ceo"},{username:"admin"},{level:"coordinador"}]) assert(canAccessPath(user,POSVENTA_SYNC_PATH,"POST"));
  for(const user of [null,{level:"employee",moduleAccess:["generators-posventa"]},{level:"ceo",isPartner:true},{level:"partner_externo"}]) assert(!canAccessPath(user,POSVENTA_SYNC_PATH,"POST"));
});
