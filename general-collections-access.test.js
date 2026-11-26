import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { financeGuard, ownsNotice, generalAccess, daysToDate, noticeForBell } from "./general-collections-access.js";
const staff={id:22,username:"test",moduleAccess:'["adm-contabilidad"]',role:"coordinador administrativo"};
test("collection policy checks server session; treasury only gets shared balance",async()=>{
 for(const [u,path,expect] of [[null,"/payment-promises",401],[{moduleAccess:["generators-administracion"]},"/ar-ap",403],
   [{...staff,isExternal:true},"/ar-ap",403],[staff,"/payment-promises/scan-alerts",200],
   [{moduleAccess:["adm-tesoreria"]},"/payment-promises/alerts",403],[{moduleAccess:["adm-tesoreria"]},"/balance",200],
   [{level:"directiva"},"/ar-ap",200]]){
   let status;
   const res={set(k,v){assert.equal(v,"private, no-store")},status(n){status=n;return this},json(){}};
   await financeGuard({authenticate:async()=>u})({path},res,()=>{status=200});assert.equal(status,expect);
 }
});
test("parallel scan, push and mark-read share a transaction lock (simulated database)",async()=>{
 const src=readFileSync(new URL("./server.js",import.meta.url),"utf8");
 const fn=src.slice(src.indexOf("async function withNoticeLock"),src.indexOf('app.post("/api/admin/finanzas/payment-promises/scan-alerts"'));
 let queue=Promise.resolve(), rows=[{id:0}];
 const pool={connect:async()=>{let unlock;return{release(){},async query(q){
   if(q.includes("pg_advisory_xact_lock")){const prior=queue;queue=new Promise(r=>{unlock=r});await prior;}
   if(q==="COMMIT"||q==="ROLLBACK")unlock();
 }}}};
 const run=vm.runInNewContext(fn+";withNoticeLock",{pool,collectionContext:new AsyncLocalStorage()});
 await Promise.all([1,2,3].map(i=>run(async()=>{const data=structuredClone(rows);
   await new Promise(r=>setImmediate(r));if(i===3)data[0].read=true;else data.push({id:i});rows=data;})));
 assert.deepEqual(rows,[{id:0,read:true},{id:1},{id:2}]);
});
test("scan uses synthetic installments, returns only intended notices and does not duplicate",async()=>{
 const src=readFileSync(new URL("./server.js",import.meta.url),"utf8");
 const fn=src.slice(src.indexOf("async function scanGeneralAlerts"),src.indexOf("async function lockedGeneralScan"));
 const today=new Date(),day=today.toISOString().slice(0,10);
 const db={employees:[staff,{username:"admin"}],paymentPromises:[{id:3,kind:"ar",mode:"installments",installments:[
   {id:1,date:day,amount:10},{id:2,date:day,amount:20,status:"paid"}]}],notifications:[]};
 const scan=vm.runInNewContext(fn+";scanGeneralAlerts",{Date,Intl,generalAccess,daysToDate,nowMs:Date.now,
   readCol:async k=>structuredClone(db[k]),writeCol:async(k,v)=>{db[k]=structuredClone(v)}});
 assert.equal((await scan()).notifications_created,2);assert.equal((await scan()).notifications_created,0);
 const mine=db.notifications.filter(n=>ownsNotice(staff,n));assert.equal(mine.length,1);
 assert.equal(noticeForBell(staff,mine[0]).userId,22);
 assert.equal(ownsNotice({...staff,moduleAccess:[]},mine[0]),false);
 assert.equal(ownsNotice({...staff,username:"someone-else"},mine[0]),false);
});
