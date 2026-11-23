import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import net from "node:net";
import pg from "pg";
import {createSessions} from "./secure-access.js";

test("Servidor completo: permisos sobre catálogo compartido, ficha, importación y ajuste WMS",{skip:!process.env.FLASH_QUOTE_TEST_PORT,timeout:60000},async()=>{
  const cfg={host:"127.0.0.1",port:Number(process.env.FLASH_QUOTE_TEST_PORT),user:"postgres",password:"test-only",database:"postgres"};
  const db="catalog_qa_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool(cfg);await admin.query(`CREATE DATABASE ${db}`);
  const pool=new pg.Pool({...cfg,database:db}); let child;
  try{
    const portProbe=net.createServer();portProbe.listen(0,"127.0.0.1");await once(portProbe,"listening");const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
    child=spawn(process.execPath,["server.js"],{cwd:new URL(".",import.meta.url),env:{PATH:process.env.PATH,NODE_ENV:"test",PORT:String(port),DATABASE_URL:`postgresql://postgres:test-only@127.0.0.1:${cfg.port}/${db}`},stdio:["ignore","pipe","pipe"]});
    await new Promise((resolve,reject)=>{child.once("exit",()=>reject(Error("El servidor de prueba no arrancó")));child.stdout.on("data",x=>{if(x.toString().includes("[copikon-server] listening"))resolve()});});
    const users=[{id:1,username:"qa-admin",level:"ceo"},{id:2,level:"vendedor",moduleAccess:["generators-ventas"]},{id:3,level:"operador",moduleAccess:["wms"]},{id:4,level:"empleado",moduleAccess:[]}];
    for(const [key,obj] of [["employees",users],["erpProducts",[{id:10,code:"QA",sku:"QA",brand:"BAIFA",priceExpress:25,stock:4,costPrice:6}]]]){
      await pool.query("INSERT INTO kv VALUES($1,$2,0) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[key,JSON.stringify(obj)]);
    }
    const sessions=createSessions(pool,null,null);
    const [boss,sales,wms,unassigned]=await Promise.all(users.map(u=>sessions.issue(u)));
    const request=(path,token,method="GET",body)=>fetch(`http://127.0.0.1:${port}/api/${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const products="erp/products",item=products+"/10",sheet="generators/inventory/product-sheet?code=QA";
    assert.equal((await request(products)).status,401);
    assert.equal((await request(products,unassigned)).status,403);
    const list=await(await request(products,sales)).json();assert.equal(list[0].priceExpress,25);assert.equal(list[0].costPrice,undefined);
    assert.equal((await(await request(item,sales)).json()).costPrice,undefined);
    for(const [route,role,method,body] of [[item,sales,"PATCH",{imageUrl:"qa"}],[item,wms,"PATCH",{stock:9,priceExpress:1}],[item,sales,"PUT",{priceExpress:1}],[item,sales,"DELETE"],[products+"/bulk-update-manual-prices",sales,"POST",{rows:[{sku:"QA",priceExpress:1}]}],[sheet,sales,"PATCH",{changes:{priceExpress:1}}]]){
      assert.equal((await request(route,role,method,body)).status,403);
    }
    const initial=await(await request(sheet,boss)).json();assert.equal(initial.editable,true);
    const [price,stock]=await Promise.all([request(sheet,boss,"PATCH",{revision:initial.product.revision,changes:{priceExpress:35,imageUrl:"https://example.org/manual.jpg"}}),request(item,wms,"PATCH",{stock:9})]);assert.equal(price.status,200);assert.equal(stock.status,200);
    const updated=await(await request(item,boss)).json();assert.equal(updated.priceExpress,35);assert.equal(updated.imageSource,"manual");assert.equal(updated.stock,9);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,"exit");child.kill();await ended;}await pool.end();await admin.query(`DROP DATABASE ${db}`);await admin.end();}
});
