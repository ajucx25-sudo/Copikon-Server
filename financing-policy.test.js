import test from "node:test";
import assert from "node:assert/strict";
import {kvaBand,downCents} from "./financing-policy.js";
import {assessFinancing,requireApproval} from "./financing-authorization.js";
test("mínimos de inicial y máximos de cuotas se evalúan de forma independiente en las tres bandas",()=>{
  for(const [k,base,limit] of [[20,30,3],[77,30,3],[100,40,4],[306,40,4],[375,50,5],[550,50,5]]){
    const name=`Generador ${k} kVA`, code="TRPE-QA", products=[{id:1,code,name}], rows=[{code,financeName:name}];
    const quote={companyName:"QA",applyTax:false,total:100,items:[{productId:1,concepto:`${name} (${code})`,precio:100,qty:1}]};
    const assess=(pct,count,selectedBand=String(base))=>assessFinancing(quote,{mode:"financiado",method:"amortizacion_mensual",annualRate:24,frequency:"mensual",firstDate:"2027-01-15",initialPct:pct,initial:pct,count,selectedBand},products,rows);
    for(const [pct,n,exception] of [[base,limit,false],[base+0.01,limit,false],[base,1,false],[base+10,limit-1,false],[base-0.01,1,true],[base+10,limit+1,true],[base-1,limit+1,true]]){
      const review=assess(pct,n);assert.equal(review.exception,exception);if(exception)assert.throws(()=>requireApproval(review,null),{status:403});else requireApproval(review,null);
    }
    assert.throws(()=>assess(base,limit,base===30?"40":"30"),{status:400});
  }
});
test("límites de kVA, intervalos sin política y equipos mixtos",()=>{
  for(const [k,p] of [[19,0],[20,30],[77,30],[77.5,0],[99,0],[100,40],[306,40],[307,0],[374,0],[375,50],[1200,50]]){
    const band=kvaBand([{name:`Generador ${k} kVA`}]);assert.equal(band?.pct??0,p);if(p)assert.equal(band.count,p/10);
  }
  assert.equal(kvaBand([{kva:77},{kva:375}]),null);assert.equal(kvaBand([{name:"Sin potencia"}]),null);
  assert.deepEqual(kvaBand([{kva:100},{kva:306}]),{pct:40,count:4});
});
test("inicial sobre total con impuestos; catálogo y no descripción escrita determina el plan",()=>{
  const q={companyName:"Prueba",items:[{productId:1,concepto:"Generador 77 kVA (TRPE-TEST)",precio:100,qty:1}],total:116};
  const p={mode:"financiado",method:"amortizacion_mensual",frequency:"mensual",annualRate:24,initialPct:30,initial:34.8,count:3,firstDate:"2027-01-01"};
  const catalog=[{id:1,code:"TRPE-TEST",name:"Generador 77 kVA"}];
  const inventory=[{code:"TRPE-TEST",financeName:"Generador 77 kVA"}];
  assert.equal(assessFinancing(q,p,catalog,inventory).exception,false);assert.equal(downCents(12345,30),3704);
  assert.equal(assessFinancing(q,p,catalog,[]).exception,true);
  assert.equal(assessFinancing(q,p,catalog,[{code:"TRPE-TEST",financeName:"Generador 375 kVA"}]).exception,true);
  assert.equal(assessFinancing(q,p,[{...catalog[0],kva:375}],inventory).exception,false);
  for(const extra of [{initial:34.81},{initialPct:""},{initialPct:100},{annualRate:12}])assert.throws(()=>assessFinancing(q,{...p,...extra},catalog));
  const r=assessFinancing(q,{...p,count:4},catalog);assert.equal(r.exception,true);
  assert.throws(()=>requireApproval(r,{key:"no coincide"}));assert.doesNotThrow(()=>requireApproval(r,{key:r.key}));
});
