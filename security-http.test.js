import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("HTTP authorization through real Express routes with isolated fake database", async () => {
  const child=spawn(process.execPath,["--loader","./security-fixture-loader.mjs","server.js"],{
    cwd:new URL(".",import.meta.url),
    env:{...process.env,DATABASE_URL:"postgres://fake-test-only",PORT:"3199"},
    stdio:["ignore","pipe","pipe"],
  });
  let logs="";
  child.stdout.on("data",data=>{logs+=data;});
  child.stderr.on("data",data=>{logs+=data;});
  const request=(path,method="GET",token,body)=>fetch(`http://127.0.0.1:3199${path}`,{
    method,headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  try {
    for(let i=0;i<100;i++){
      if(logs.includes("listening on"))break;
      if(child.exitCode!==null)throw Error(logs);
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(logs.includes("listening on"),logs);
    const routes=[
      ["/api/employees","GET"],["/API/EMPLOYEES","GET"],
      ["/api/admin/users","GET"],["/api/sync/migrate","POST"],
      ["/api/logistica/carriers","GET"],["/api/logistica/shipments","GET"],
      ["/api/logistica/tarifario/routes","GET"],["/api/logistica/traslados","GET"],
      ["/api/logistica/gps/live","GET"],["/api/generators/shipments","GET"],
      ["/api/generators/price-list-settings","PUT"],
      ["/api/sales-partners/1/set-credentials","POST"],
      ["/api/admin/technical-providers/1/reset-access","POST"],
      ["/api/erp/pre-leads","GET"], ["/API/ERP/PRE-LEADS","GET"],
      ["/api/erp/pre-leads","POST"], ["/api/erp/pre-leads/1","PATCH"],
      ["/api/erp/pre-leads/1","PUT"], ["/api/erp/pre-leads/1","DELETE"],
      ["/api/erp/clients/501","PATCH"], ["/API/ERP/CLIENTS/501","PUT"],
      ["/api/erp/clients/501","DELETE"],
      ["/api/generators/posventa/equipment/601","PATCH"],
      ["/api/erp/client-equipment/601","PATCH"], ["/api/erp/client-equipment/601","PUT"],
      ["/api/erp/client-equipment/601","DELETE"],
    ];
    for(const [path,method] of routes){
      assert.equal((await request(path,method)).status,401,`${method} ${path}`);
      assert.equal((await request(path,method,"srv-1-17211111")).status,401,`forged ${path}`);
    }
    const login=async username=>{
      const res=await request("/api/auth/login","POST",null,{username,password:"test-only-password"});
      assert.equal(res.status,200);const body=await res.json();
      assert.equal(body.user.password,undefined);return body.token;
    };
    const admin=await login("qa-admin"),sales=await login("qa-sales"),logistics=await login("qa-logistics");
    const coordinator = await login("qa-coordinator");
    assert.equal((await request("/api/generators/posventa/equipment/601","PATCH",sales,{warrantyMonths:12})).status,403);
    assert.equal((await request("/api/erp/client-equipment/601","PATCH",logistics,{warrantyMonths:12})).status,403);
    for (const bad of [{clientId:999},{id:2},{installedAt:"2026-02-30"},{warrantyMonths:1.5},{warrantyMonths:0},{warrantyMonths:121},{}]) {
      assert.equal((await request("/api/generators/posventa/equipment/601","PATCH",coordinator,bad)).status,400);
    }
    for (const method of ["PATCH","PUT"]) {
      assert.equal((await request("/api/erp/client-equipment/601",method,admin,{commissionedAt:"bad"})).status,400);
    }
    const eqEdit = await request("/api/generators/posventa/equipment/601","PATCH",coordinator,{
      installedAt:"2026-01-01",commissionedAt:"2026-02-01",warrantyMonths:24,invoiceNumber:" QA-01 "
    });
    assert.equal(eqEdit.status,200);
    const editedEq=await eqEdit.json();
    assert.equal(editedEq.clientId,501); assert.equal(editedEq.serial,"QA-601"); assert.equal(editedEq.invoiceNumber,"QA-01");
    const eqRead=await request("/api/erp/client-equipment/601","GET",admin);
    assert.equal((await eqRead.json()).warrantyMonths,24);
    assert.equal((await (await request("/api/erp/client-equipment/602","GET",admin)).json()).warrantyMonths,undefined);
    assert.equal((await request("/api/generators/posventa/equipment/603","PATCH",admin,{warrantyMonths:12})).status,403);
    assert.equal((await request("/api/generators/posventa/equipment/604","PATCH",admin,{warrantyMonths:12})).status,403);
    assert.equal((await request("/api/generators/posventa/equipment/999","PATCH",admin,{warrantyMonths:12})).status,404);
    assert.equal((await request("/api/erp/client-equipment/601","PATCH",sales,{location:"QA location"})).status,200);
    const clearEq=await request("/api/generators/posventa/equipment/601","PATCH",admin,{commissionedAt:null,warrantyMonths:null,invoiceNumber:null});
    assert.equal(clearEq.status,200); assert.equal((await clearEq.json()).warrantyMonths,null);
    for (const method of ["PATCH","PUT","DELETE"]) {
      assert.equal((await request("/api/erp/clients/501",method,sales,{name:"forbidden"})).status,403);
    }
    for (const body of [{id:999,name:"Bad"}, {odooId:1}, {name:" "}, {email:"bad"}, {phone:123}, [], {}]) {
      assert.equal((await request("/api/erp/clients/501","PATCH",admin,body)).status,400);
    }
    const edit = await request("/api/erp/clients/501","PATCH",coordinator,{name:" Updated QA ",phone:null});
    assert.equal(edit.status,200);
    assert.equal(edit.headers.get("cache-control"),"no-store");
    const edited = await edit.json();
    assert.equal(edited.name,"Updated QA"); assert.equal(edited.phone,null);
    assert.equal(edited.id,501); assert.equal(edited.odooId,771); assert.equal(edited.status,"activo");
    const putEdit = await request("/api/erp/clients/501","PUT",admin,{city:"Barquisimeto"});
    assert.equal(putEdit.status,200);
    assert.equal((await putEdit.json()).odooId,771);
    const reread = await request("/api/erp/clients/501","GET",admin);
    assert.equal((await reread.json()).name,"Updated QA");
    assert.equal((await request("/api/erp/clients/999999","PATCH",admin,{name:"Not found"})).status,404);
    assert.equal((await request("/api/erp/pre-leads","GET",logistics)).status,403);
    assert.equal((await request("/api/erp/pre-leads","POST",logistics,{companyName:"forbidden"})).status,403);
    const preleadResponse = await request("/api/erp/pre-leads","POST",sales,{id:12345,companyName:"QA intake",intakeBrand:"baifa",intakePhone:"+584126381163"});
    assert.equal(preleadResponse.status,201);
    assert.equal((await preleadResponse.json()).intakeBrand,"baifa");
    const preleadRetry = await request("/api/erp/pre-leads","POST",sales,{id:12345,companyName:"QA intake"});
    assert.equal(preleadRetry.status,200);
    assert.equal((await request("/api/erp/pre-leads/12345","PATCH",sales,{intakeStatus:"contactado"})).status,200);
    const preleads = await request("/api/erp/pre-leads","GET",sales);
    assert.equal(preleads.headers.get("cache-control"),"no-store");
    assert.equal((await preleads.json()).find(p=>p.id===12345).intakeStatus,"contactado");
    assert.equal((await request("/api/employees","GET",admin)).status,200);
    const employeeResponse=await request("/api/employees","GET",admin);
    assert.equal(employeeResponse.headers.get("cache-control"),"no-store");
    assert.ok((await employeeResponse.json()).every(e=>!("password" in e)));
    assert.equal((await request("/api/logistica/carriers","GET",sales)).status,403);
    assert.equal((await request("/api/logistica/carriers","GET",logistics)).status,200);
    assert.equal((await request("/api/employees/1","PATCH",sales,{level:"ceo"})).status,403);
    assert.equal((await request("/api/generators/price-list-settings","GET",sales)).status,200);
    assert.equal((await request("/api/generators/shipments","GET",admin)).status,200);
    assert.equal((await request("/api/auth/logout","POST",admin)).status,200);
    assert.equal((await request("/api/auth/me","GET",admin)).status,401);
    assert.equal((await request("/api/public/baifa/price-list")).status,200);
    assert.equal((await request("/api/auth/login","POST",null,{})).status,401);
    const forbiddenOrigin=await fetch("http://127.0.0.1:3199/api/health",{headers:{Origin:"https://untrusted.invalid"}});
    assert.equal(forbiddenOrigin.headers.get("access-control-allow-origin"),null);
    const allowedOrigin=await fetch("http://127.0.0.1:3199/api/health",{headers:{Origin:"https://copikon-intranet.pplx.app"}});
    assert.equal(allowedOrigin.headers.get("access-control-allow-origin"),"https://copikon-intranet.pplx.app");
  } finally { child.kill(); await once(child,"exit").catch(()=>{}); }
});
