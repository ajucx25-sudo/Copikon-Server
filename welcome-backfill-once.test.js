import test from "node:test";
import assert from "node:assert/strict";
import {fingerprintWelcome,planApprovedWelcomes} from "./welcome-backfill-once.js";
const l={companyId:12,invoiceId:123,lineId:456,product:"[QA] Generador",invoice:"QA/42",date:"2026-11-17",quantity:1};
function fixture(){return {customers:[{rif:"J123456789",sales:[{...l}],credits:[]}],clients:[{id:50,rif:"J-12345678-9"}],equipment:[{id:60,clientId:50,active:true,source:"odoo-baifa-sales",odooUnitKey:"odoo:12:123:456:1",productCode:"QA",invoiceNumber:l.invoice,invoiceDate:l.date,odooSource:{...l}}],history:[],now:"2026-11-26T18:00:00Z",manifest:[fingerprintWelcome(12,l.invoice,l.date,"QA")]}}
test("only listed units are added pending; all existing statuses and owners stay untouched",()=>{
 const data=fixture();data.equipment.push({...data.equipment[0],odooUnitKey:"unlisted"});
 const [n]=planApprovedWelcomes(data).additions;assert.equal(n.status,"pending");assert.equal(n.equipment.length,1);
 for(const status of ["pending","claimed","done"]){data.history=[{...n,status,owner:99}];const before=structuredClone(data.history);assert.equal(planApprovedWelcomes(data).additions.length,0);assert.deepEqual(data.history,before)}
 data.history=[{...n,id:"legacy",equipment:[]}];assert.equal(planApprovedWelcomes(data).additions.length,0);
});
test("credit, inactive unit, ambiguity or different evidence blocks writes",()=>{
 for(const mutate of [x=>x.customers[0].credits.push({}),x=>x.equipment[0].active=false,x=>x.clients.push({...x.clients[0]}),x=>x.equipment[0].invoiceDate="2026-01-01",x=>x.customers[0].sales[0].companyId=1]){const data=fixture();mutate(data);assert.throws(()=>planApprovedWelcomes(data));assert.equal(data.history.length,0)}
});
