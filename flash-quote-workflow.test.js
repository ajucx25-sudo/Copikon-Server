import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import express from "express";
import pg from "pg";
import {registerSalesDocumentRoutes} from "./baifa-sales-documents.js";
import {workflowSchema,protectPipelineQuotes} from "./flash-quote-workflow.js";

test("the pipeline permits stage changes but not overwriting finalized quote figures",()=>{
  const old={id:6,flashQuoteId:4,stage:"cotizacion",quoteTotal:"100.00"};
  assert.doesNotThrow(()=>protectPipelineQuotes([old],[{...old,stage:"negociacion"}]));
  assert.throws(()=>protectPipelineQuotes([old],[{...old,quoteTotal:"0"}]),{status:409});
  assert.throws(()=>protectPipelineQuotes([old],[]),{status:409});
});

// Set FLASH_QUOTE_TEST_PORT to a disposable local PostgreSQL instance. Never use production credentials.
test("quote lifecycle: permissions, draft revisions, definitive save, rollback and concurrency",{
  skip:!process.env.FLASH_QUOTE_TEST_PORT
},async()=>{
  const config={host:"127.0.0.1",port:Number(process.env.FLASH_QUOTE_TEST_PORT),database:"postgres",user:"postgres",password:"test-only"};
  const schema="quote_qa_"+randomUUID().replaceAll("-","");
  const admin=new pg.Client(config);await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({...config,options:`-c search_path=${schema}`});let server;
  try{
    await pool.query(workflowSchema);
    await pool.query("CREATE TABLE kv(key text primary key,value jsonb not null,updated_at bigint not null)");
    const app=express();
    registerSalesDocumentRoutes(app,{pool,sessions:{authenticate:async req=>{
      const k=req.headers["x-test-user"];return k?{id:k,level:k==="admin"?"ceo":"vendedor",moduleAccess:k==="otro"?"[]":'["generators-ventas"]'}:null;
    }}});
    server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
    const url=`http://127.0.0.1:${server.address().port}/api/generators/sales-documents/quotes`;
    const req=async(method,tail="",body,user="7")=>{
      const r=await fetch(url+tail,{method,headers:{"content-type":"application/json",...(user?{"x-test-user":user}:{})},body:body?JSON.stringify(body):undefined});
      return {s:r.status,v:await r.json()};
    };
    const draft={requestId:randomUUID(),companyName:"Empresa ficticia",items:JSON.stringify([{concepto:"Equipo de ejemplo",qty:1,precio:100}]),status:"borrador",applyTax:false,total:"100.00"};
    assert.equal((await req("GET","",null,"")).s,401);assert.equal((await req("GET","",null,"otro")).s,403);
    const a=await req("POST","",draft);assert.equal(a.s,200);const id="/"+a.v.id;
    const count=async()=>Number((await pool.query("SELECT jsonb_array_length(value) AS n FROM kv WHERE key='erpLeads'")).rows[0]?.n||0);
    assert.equal(await count(),0);
    assert.deepEqual((await req("GET","",null,"8")).v,[]);
    assert.equal((await req("PATCH",id,{...draft,version:1},"8")).s,404);
    const change={...draft,companyName:"Cliente corregido",version:1};assert.equal((await req("PATCH",id,change)).v.version,2);
    assert.equal((await req("PATCH",id,change)).s,409);assert.equal((await req("DELETE",id+"?version=1")).s,409);
    const saved={...change,status:"guardada",version:2};
    const finals=await Promise.all([req("PATCH",id,saved),req("PATCH",id,saved)]);
    assert.ok(finals.every(r=>r.s===200));assert.equal(finals[0].v.convertedToLeadId,finals[1].v.convertedToLeadId);
    assert.equal(await count(),1);
    const lead=(await pool.query("SELECT value FROM kv WHERE key='erpLeads'")).rows[0].value[0];
    assert.equal(lead.stage,"cotizacion");assert.equal(lead.quoteNumber,finals[0].v.number);assert.equal(lead.quoteTotal,"100.00");
    assert.equal((await req("PATCH",id,{...change,version:3})).s,409);
    assert.equal((await req("DELETE",id+"?version=3")).s,409);
    const b=(await req("POST","",{...draft,requestId:randomUUID()})).v;
    assert.equal((await req("DELETE",`/${b.id}?version=1`)).s,200);assert.equal(await count(),1);
    const direct={...saved,requestId:randomUUID()};
    const both=await Promise.all([req("POST","",direct),req("POST","",direct)]);assert.equal(both[0].v.id,both[1].v.id);assert.equal(await count(),2);
    await pool.query("ALTER TABLE kv ADD CHECK(jsonb_array_length(value)<=2)");
    assert.equal((await req("POST","",{...direct,requestId:randomUUID()})).s,500);
    assert.equal((await req("GET")).v.length,2);assert.equal(await count(),2);
  }finally{if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
