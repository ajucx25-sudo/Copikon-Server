import test from "node:test";import assert from "node:assert/strict";
import {installments,view,allowed,invoices,base,registerReceivables,assertNoGeneratorsPlan} from "./generators-receivables.js";
import {requiresCollectionTransaction} from "./client-collection-transactions.js";
const i={id:9,balance:100,currency:"USD",digits:2,due:"2026-12-02"};
test("ambos módulos serializan escrituras y no duplican una factura",async()=>{
 const legacy="/api/admin/finanzas/payment-promises",read=async()=>[{id:9}];
 for(const [path,method] of [[legacy,"POST"],[legacy+"/p","PATCH"],[legacy+"/p","DELETE"],[base+"/9/plan","PUT"]])assert(requiresCollectionTransaction(path,method));
 await assert.rejects(assertNoGeneratorsPlan(read,{move_id:"9",kind:"ar",status:"pending"}),e=>e.status===409);
 await assertNoGeneratorsPlan(read,{move_id:9,kind:"ar",status:"cancelled"});await assertNoGeneratorsPlan(read,{move_id:9,kind:"ap"});
});
test("cuotas exactas, fechas reales, alertas por día calendario y saldos cambiantes",()=>{
 const rows=installments([{date:"2026-12-03",amount:60},{date:"2026-12-02",amount:40}],i),p={...i,rows,revision:1};
 for(const [day,days] of [["2026-11-24",[]],["2026-11-25",[7]],["2026-12-02",[0,1]],["2026-12-03",[-1,0]]])assert.deepEqual(view(i,p,null,day).alerts.map(a=>a.days),days);
 assert.equal(view(i,null,null,"2026-11-25").alerts[0].label,"Factura sin plan");assert(view({...i,balance:60},p,null,"2026-12-02").review);
 assert.equal(view(i,null,{mode:"single",currency:"USD",promise_amount:100,promise_date:i.due},"2026-11-25").alerts.length,1);
 assert.deepEqual(view(i,null,{mode:"single",currency:"USD",promise_amount:100,promise_date:i.due},"2026-11-25").rows,[{date:i.due,amount:100}]);
 for(const [date,amount] of [["2026-02-30",100],[i.due,0],[i.due,99],[i.due,100.001]])assert.throws(()=>installments([{date,amount}],i));
});
test("acceso interno y escritura transaccional",()=>{assert(allowed({moduleAccess:["generators-administracion"]}));for(const u of [null,{moduleAccess:["generators-ventas"]},{level:"ceo",isPartner:true}])assert(!allowed(u));assert(requiresCollectionTransaction(base+"/9/plan","PUT"));});
test("consulta facturas en Odoo de la compañía y rama fijadas, conserva moneda y vendedor; no permite guardar dos revisiones iguales",async()=>{
 const r={id:9,name:"F-DEMO",partner_id:[2,"Demo"],invoice_user_id:[3,"Vendedor de prueba"],amount_residual:100,currency_id:[1,"USD"],company_id:[12,"Operativa"],branch_id:[41,"Generadores"],move_type:"out_invoice",state:"posted",payment_state:"partial"};
 const odoo={searchRead:async(model,domain,fields,options)=>{assert.deepEqual(options.context.allowed_company_ids,[12]);if(model==="res.currency")return [{id:1,name:"USD",decimal_places:2}];assert(domain.some(([k,,v])=>k==="branch_id"&&v===41));assert(fields.includes("invoice_user_id"));return [r]}};
 assert.equal((await invoices(odoo))[0].seller,"Vendedor de prueba");assert.equal((await invoices(odoo))[0].sellerId,3);r.invoice_user_id=false;assert.equal((await invoices(odoo))[0].seller,"Sin asignar");assert.equal((await invoices(odoo))[0].sellerId,null);
 assert.equal((await invoices(odoo))[0].clientId,2);r.partner_id=[8,"Demo"];assert.equal((await invoices(odoo))[0].clientId,8);
 let put,store=[];registerReceivables({use(){},get(){},put(_p,f){put=f}},{sessions:{},odoo,readCol:async k=>k==="paymentPromises"?[]:store,writeCol:async(_k,v)=>store=v,wrap:f=>f});
 const req={params:{id:"9"},verifiedUser:{id:3},body:{revision:0,currency:"USD",balance:100,rows:[{date:i.due,amount:100}]}};await put(req,{json:r=>assert.equal(r.revision,1)});await assert.rejects(put(req,{}),e=>e.status===409);
 r.branch_id=[42,"Otra"];await assert.rejects(invoices(odoo));r.branch_id=[41,"Generators"];r.payment_state="paid";await assert.rejects(invoices(odoo));
});
