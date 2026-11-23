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
    const [price,stock]=await Promise.all([request(sheet,boss,"PATCH",{revision:initial.product.revision,changes:{priceExpress:35,imageUrl:"https://example.org/manual.jpg",gallery:["https://example.org/lado.jpg"],motorBrand:"Motor persistido",model:"Serie QA",description:"Descripción QA"}}),request(item,wms,"PATCH",{stock:9})]);assert.equal(price.status,200);assert.equal(stock.status,200);
    const reopened=(await(await request(sheet,boss)).json()).product;assert.equal(reopened.technical.motorBrand,"Motor persistido");assert.deepEqual(reopened.gallery,["https://example.org/lado.jpg"]);assert.equal(reopened.priceExpress,35);assert.equal(reopened.imageUrl,"https://example.org/manual.jpg");
    const updated=await(await request(item,boss)).json();assert.equal(updated.priceExpress,35);assert.equal(updated.imageSource,"manual");assert.equal(updated.stock,9);
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEtsAAAAASUVORK5CYII=";
    const upload="DATA:image/png;base64,"+png;
    const saveGallery=(revision,gallery)=>request(sheet,boss,"PATCH",{revision,changes:{gallery}});
    assert.equal((await saveGallery(reopened.revision,[upload,"data:image/png;base64,YWJj"])).status,400);
    assert.equal((await pool.query("SELECT count(*) FROM inventory_gallery_photos")).rows[0].count,"0");
    assert.equal((await saveGallery(reopened.revision,[upload])).status,200);
    const reloaded=(await(await request(sheet,boss)).json()).product;
    const ref=reloaded.gallery[0];assert.match(ref,/^\/api\/generators\/inventory\/gallery-photo\/[a-f0-9-]{36}$/);
    const catalog=(await pool.query("SELECT value FROM kv WHERE key='erpProducts'")).rows[0].value;
    assert.deepEqual(JSON.parse(catalog[0].galleryImages),[ref]);assert.ok(!JSON.stringify(catalog).includes(png));
    const pic=ref.slice(5),read=await request(pic,boss);assert.equal(read.status,200);assert.equal(read.headers.get("content-type"),"image/png");assert.equal(Buffer.from(await read.arrayBuffer()).toString("base64"),png);
    assert.equal((await request(pic,null)).status,401);assert.equal((await request(pic,sales)).status,403);
    assert.equal((await saveGallery(reopened.revision,[])).status,409);assert.equal((await request(pic,boss)).status,200);
    assert.equal((await saveGallery(reloaded.revision,[])).status,200);assert.equal((await request(pic,boss)).status,404);
    assert.equal((await pool.query("SELECT count(*) FROM inventory_gallery_photos")).rows[0].count,"0");
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,"exit");child.kill();await ended;}await pool.end();await admin.query(`DROP DATABASE ${db}`);await admin.end();}
});
