import test from "node:test";
import assert from "node:assert/strict";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { createPackagePdf } from "./baifa-sales-documents.js";
import { validateQuote } from "./baifa-sales-rules.js";

async function render(steps) {
  const q = validateQuote({companyName:"Cliente de ejemplo",applyTax:false,total:1300,items:[
    {productId:7, concepto:"Generador de ejemplo 77 kVA",qty:1,precio:1000},
    {serviceItem:true,concepto:"Instalación eléctrica",qty:1,precio:300,detalle:steps},
    {serviceItem:true,concepto:"Transporte",qty:1,precio:0,detalle:"Coordinar la recepción en sitio."},
    {serviceItem:true,concepto:"Inspección visual",qty:1,precio:0}
  ]});
  const bytes = await createPackagePdf(q,{mode:"contado"},[],"EJEMPLO","2026-11-18");
  const pages=[];
  await pdfParse(Buffer.from(bytes),{pagerender:async p=>{
    const t=(await p.getTextContent()).items.map(i=>i.str).join(" ");
    pages.push(t); return t;
  }});
  return {bytes,pages};
}
test("each quoted service is immediately followed by its own execution steps in the downloaded PDF", async()=>{
  const {pages}=await render("Verificar la acometida eléctrica.\nRegistrar las mediciones finales.");
  assert.match(pages[0],/Servicio: Instalación eléctrica.*1\.\s*Verificar la acometida eléctrica\..*2\.\s*Registrar las mediciones finales\..*Servicio: Transporte.*1\.\s*Coordinar la recepción en sitio\..*Servicio: Inspección visual/s);
  assert.equal(pages[0].match(/Anexo de ejecución/g)?.length,2);
  assert.match(pages[0],/TOTAL USD\s*\$1,300\.00/);
  assert.match(pages[1],/SERVICIO: INSTALACIÓN ELÉCTRICA/);
  assert.match(pages[2],/SERVICIO: TRANSPORTE/);
});
test("long service detail repeats the service name on continuation pages", async()=>{
  const {pages}=await render(Array.from({length:40},(_,i)=>`Paso ${i+1}: ${"Revisar las conexiones del equipo. ".repeat(8)}`).join("\n"));
  assert.ok(pages.slice(1).some(t=>/Instalación eléctrica · Anexo 1 \(continuación\)/.test(t) && /Paso 40:/.test(t)));
});
