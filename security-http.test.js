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
