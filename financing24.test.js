import test from "node:test";
import assert from "node:assert/strict";
import { financingSchedule, validateQuote } from "./baifa-sales-rules.js";
import { createPackagePdf } from "./baifa-sales-documents.js";
import { PDFDocument } from "pdf-lib";

const plan = { mode: "financiado", method: "amortizacion_mensual", annualRate: 24,
  initial: 2000, surcharge: "", count: 12, frequency: "mensual", firstDate: "2028-01-31" };
test("24% nominal annual: independent 12 month amortization reference", () => {
  const result = financingSchedule(10000, plan);
  assert.equal(result.principal, 800000);
  assert.equal(result.installment, 75648);
  assert.equal(result.payments[0].interest, 16000);
  assert.equal(result.payments[0].capital, 59648);
  assert.equal(result.payments[0].balance, 740352);
  assert.equal(result.payments.at(-1).balance, 0);
  assert.equal(result.payments.reduce((s,p) => s+p.capital, 0), 800000);
  assert.equal(result.payments.reduce((s,p) => s+p.interest, 0), result.interest);
  assert.equal(result.initial + result.payments.reduce((s,p) => s+p.amount, 0), result.payable);
  assert.deepEqual(result.payments.slice(0,3).map(p=>p.date), ["2028-01-31","2028-02-29","2028-03-31"]);
});
test("one month, zero initial, term boundaries and rounding invariants", () => {
  assert.equal(financingSchedule(10000, {...plan, initial:0, count:1}).payable, 1020000);
  for (const count of [1,2,6,12,24,36,60]) for (const total of [100,1234.56,10000,999999999.99]) {
    const r=financingSchedule(total,{...plan,initial:0,count});
    assert.equal(r.payments.at(-1).balance,0);
    assert.equal(r.payments.reduce((s,p)=>s+p.capital,0),r.principal);
    assert.equal(r.payments.reduce((s,p)=>s+p.amount,0),r.payable);
    assert.ok(r.payments.every(p=>Number.isSafeInteger(p.amount)&&p.capital>0&&p.interest>=0&&p.balance>=0));
  }
});
test("tampered rate, fee, method, invalid dates, amounts and terms fail closed", () => {
  for(const patch of [{annualRate:12},{annualRate:""},{annualRate:null},{annualRate:Infinity},
    {surcharge:50},{surcharge:"invalid"},{method:"flat24"},{frequency:"semanal"},
    {initial:""},{initial:-1},{initial:10000},{count:0},{count:61},{count:1.5},{firstDate:"2028-02-30"}])
    assert.throws(()=>financingSchedule(10000,{...plan,...patch}));
  assert.throws(()=>financingSchedule(0.01,{...plan,initial:0,count:60}));
});
test("cash and existing fixed-surcharge documents keep their original calculation", () => {
  assert.deepEqual(financingSchedule(10000,{mode:"contado"}),{initial:1000000,principal:0,surcharge:0,payable:1000000,payments:[]});
  const legacy=financingSchedule(10000,{...plan,method:undefined,surcharge:100});
  assert.equal(legacy.payable,1010000);
  assert.equal(legacy.interest,undefined);
});
test("24% PDF renders up to 60 months without losing pages", async () => {
  const q=validateQuote({companyName:"PRUEBA FINANCIAMIENTO",items:[{concepto:"Generador QA",qty:1,precio:10000}],applyTax:false,total:10000});
  const pdf=await PDFDocument.load(await createPackagePdf(q,{...plan,count:60},[],"QA24","2026-11-17"));
  assert.ok(pdf.getPageCount()>=4);
});
