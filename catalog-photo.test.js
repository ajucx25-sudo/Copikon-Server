import test from "node:test";
import assert from "node:assert/strict";
import {AsyncLocalStorage} from "node:async_hooks";
import pg from "pg";
import {photoFromSync,photoFromEdit,withCatalogLock} from "./catalog-photo.js";

const op={id:19,image_128:"YWJj"};
test("URL o archivo manual prevalece sobre imagen inline y proxy; las históricas sin origen no se reclasifican",()=>{
  for(const url of ["https://example.org/manual.jpg","data:image/jpeg;base64,bWFudWFs","/uploads/manual.png"]){
    for(const existing of [{imageUrl:url},{imageUrl:url,imageSource:"manual"}]){
      for(const o of [op,{id:19},{id:19,image_128:false}])assert.deepEqual(photoFromSync(existing,o),existing);
    }
  }
});
test("Sin foto manual usa Odoo; reemplazar, retirar o editar solo precio no congela la foto de Odoo",()=>{
  const first=photoFromSync(null,op);assert.equal(first.imageUrl,"data:image/jpeg;base64,YWJj");
  assert.deepEqual(photoFromSync(first,{id:19}),first);
  assert.notEqual(photoFromSync(first,{id:19,image_128:"ZGVm"}).imageUrl,first.imageUrl);
  const saved=photoFromEdit(first,{imageUrl:"https://example.org/a.jpg"});assert.equal(saved.imageSource,"manual");
  assert.deepEqual(photoFromEdit(saved,{priceExpress:30}),{});
  const removed=photoFromEdit({...saved,odooId:19},{imageUrl:""});
  assert.equal(removed.imageUrl,"/api/erp/products/odoo-image/19");
  assert.deepEqual(photoFromSync(removed,op),first);
});
test("La sincronización lee la última edición manual aunque compita con una edición en PostgreSQL",{skip:!process.env.FLASH_QUOTE_TEST_PORT},async()=>{
  const cfg={host:"127.0.0.1",port:Number(process.env.FLASH_QUOTE_TEST_PORT),database:"postgres",user:"postgres",password:"test-only"};
  const schema=`photo_qa_${process.pid}`,admin=new pg.Pool(cfg),pool=new pg.Pool({...cfg,options:`-c search_path=${schema}`});
  const context=new AsyncLocalStorage();
  try{await admin.query(`CREATE SCHEMA ${schema}`);await pool.query("CREATE TABLE kv(key text PRIMARY KEY,value jsonb,updated_at bigint)");
    await pool.query("INSERT INTO kv VALUES('erpProducts','[]',0)");
    const edit=await pool.connect();
    let sync;
    try{await edit.query("BEGIN");await edit.query("SELECT key FROM kv WHERE key='erpProducts' FOR UPDATE");
      sync=withCatalogLock(pool,context,async()=>{const db=context.getStore();const {rows}=await db.query("SELECT value FROM kv WHERE key='erpProducts'");return photoFromSync(rows[0].value[0],op);});
      await edit.query("UPDATE kv SET value=$1 WHERE key='erpProducts'",[JSON.stringify([{imageUrl:"https://example.org/nueva.jpg",imageSource:"manual"}])]);
      await edit.query("COMMIT");
    }finally{edit.release();}
    assert.deepEqual(await sync,{imageUrl:"https://example.org/nueva.jpg",imageSource:"manual"});
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
