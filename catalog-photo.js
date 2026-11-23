const proxy=id=>Number.isSafeInteger(Number(id))&&Number(id)>0?`/api/erp/products/odoo-image/${Number(id)}`:"";
const proxyPath=/^\/api\/erp\/products\/odoo-image\/\d+(?:[?#].*)?$/;

// Existing, unlabelled photos can be manual or imported. Never guess their
// origin or overwrite them; no migration of historical photos is needed.
export function photoFromSync(existing,op){
  const current=String(existing?.imageUrl||"");
  if(current&&existing?.imageSource!=="odoo"&&!proxyPath.test(current))return {imageUrl:current,...(existing?.imageSource==="manual"?{imageSource:"manual"}:{})};
  const inline=typeof op.image_128==="string"&&op.image_128?`data:image/jpeg;base64,${op.image_128}`:"";
  return {imageUrl:inline||(!Object.hasOwn(op,"image_128")&&existing?.imageSource==="odoo"?current:"")||proxy(op.id),imageSource:"odoo"};
}
export function photoFromEdit(previous,changes){
  if(!Object.hasOwn(changes,"imageUrl")||changes.imageUrl===previous?.imageUrl)return {};
  const url=String(changes.imageUrl||"").trim();
  return !url||proxyPath.test(url)?{imageUrl:proxy(previous?.odooId??changes.odooId)||url,imageSource:"odoo"}:{imageUrl:url,imageSource:"manual"};
}

// Odoo network requests are already finished before this lock is acquired.
// Use the same catalog row lock as the product-sheet PATCH.
export async function withCatalogLock(pool,context,merge){
  const db=await pool.connect();
  try{
    await db.query("BEGIN");
    await db.query("INSERT INTO kv(key,value,updated_at) VALUES($1,'[]'::jsonb,$2) ON CONFLICT(key) DO NOTHING",["erpProducts",Date.now()]);
    await db.query("SELECT key FROM kv WHERE key=$1 FOR UPDATE",["erpProducts"]);
    const result=await context.run(db,merge);
    await db.query("COMMIT");return result;
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}
