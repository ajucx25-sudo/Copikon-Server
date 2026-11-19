// Used in both the server and the quote editor. Product metadata comes from the catalog.
export function kvaBand(products) {
  if(!products.length)return null;
  const bands=products.map(p=>{
    const text=String(p.kva??"").trim()||String(p.kvaNumeric??"").trim()||String(p.name||"");
    const values=/^\d+(?:[.,]\d+)?$/.test(text)?[Number(text.replace(",","."))]:
      [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*kva\b/gi)].map(m=>Number(m[1].replace(",",".")));
    if(new Set(values).size!==1||/[\d]\s*[-/]\s*\d+\s*kva/i.test(text))return 0;
    const n=values[0];return n>=20&&n<=77?30:n>=100&&n<=306?40:n>=375?50:0;
  });
  return bands[0]&&bands.every(b=>b===bands[0])?{pct:bands[0],count:bands[0]/10}:null;
}
export function downCents(totalCents,pct){return Math.round(totalCents*Math.round(Number(pct)*100)/10000);}
const standardServices=new Set(["Instalación eléctrica","Base de concreto","Tanque diésel","Transporte","Izaje"]);
export function quotedBand(items,products,rows){
  const models=[];
  for(const i of items){
    if(i.productId==null&&i.serviceItem===true&&standardServices.has(i.concepto))continue;
    const local=products.find(p=>String(p.id)===String(i.productId));
    const r=local&&rows.find(r=>r.code===(local.code||local.sku));
    if(!r?.financeName||i.concepto!==`${r.financeName} (${r.code})`)return null;
    if(!/^TRPE/i.test(r.code)&&!(/baifa/i.test(r.financeName)&&/generador|grupo electr[oó]geno|genset/i.test(r.financeName)))return null;
    models.push({name:r.financeName});
  }
  return kvaBand(models);
}
