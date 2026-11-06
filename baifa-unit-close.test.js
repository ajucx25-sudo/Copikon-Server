import test from "node:test";
import assert from "node:assert/strict";
import {summarizeUnitClose,loadUnitClose} from "./baifa-unit-close.js";
const range={from:"2026-10-01",until:"2026-10-31"};
const currencies=[{id:2,name:"USD",decimal_places:2}];
const row={id:1,name:"QA-1",company_id:[12,"Copikon"],branch_id:[41,"N-COPIKON GENERATOR"],
  state:"posted",move_type:"out_invoice",invoice_date:"2026-10-15",partner_id:[7,"Cliente QA"],
  currency_id:[2,"USD"],payment_state:"not_paid",amount_untaxed:100,amount_tax:16,amount_total:116};
const summary=rows=>summarizeUnitClose(rows,currencies,range);
const refund=(id,amount)=>({...row,id,name:`QA-NC-${id}`,move_type:"out_refund",payment_state:"paid",
  amount_untaxed:amount,amount_tax:0,amount_total:amount});
test("unit shows whole invoices without fiscal/product filtering, not estimates",()=>{
  const d=summary([row]);
  assert.equal(d.invoiceCount,1);assert.equal(d.totals[0].invoiced,100);assert.equal(d.totals[0].tax,16);
  assert.equal(d.totals[0].total,116);assert.equal(d.rows[0].partnerId,7);
});
test("reversed invoices excluded from headline, included once in net basis",()=>{
  const d=summary([row,{...row,id:2,name:"QA-2",payment_state:"reversed",amount_untaxed:20,amount_tax:0,amount_total:20},
    refund(3,20),refund(4,10)]);
  const t=d.totals[0];
  assert.equal(d.invoiceCount,1);assert.equal(d.postedInvoiceCount,2);assert.equal(d.reversedInvoiceCount,1);
  assert.equal(d.creditNoteCount,2);assert.equal(t.invoiced,100);assert.equal(t.postedInvoiced,120);
  assert.equal(t.credited,30);assert.equal(t.net,90);assert.equal(t.netTotal,106);
});
test("credit-only months can have negative net and zero invoice headline",()=>{
  const d=summary([refund(1,30)]);assert.equal(d.invoiceCount,0);assert.equal(d.clientCount,0);
  assert.equal(d.totals[0].invoiced,0);assert.equal(d.totals[0].net,-30);
});
test("payment status is not invoice eligibility except reversed",()=>{
  for(const payment_state of ["not_paid","in_payment","paid","partial","invoicing_legacy"])
    assert.equal(summary([{...row,payment_state}]).invoiceCount,1);
  assert.throws(()=>summary([{...row,payment_state:"future_unknown"}]));
});
test("identity dedupe does not double count, conflicts rejected",()=>{
  assert.equal(summary([row,row]).invoiceCount,1);
  assert.throws(()=>summary([row,{...row,payment_state:"reversed"}]));
});
test("rejects incorrect company, branch, dates, drafts, malformed IDs",()=>{
  for(const patch of [{company_id:[1,"Else"]},{branch_id:[42,"Else"]},{state:"draft"},{invoice_date:"2026-11-01"},
    {invoice_date:false},{id:"1"},{partner_id:false},{currency_id:[99,"XXX"]},{name:""}])
    assert.throws(()=>summary([{...row,...patch}]));
});
test("precision, missing values, contradictory totals and unsafe sums fail closed",()=>{
  for(const patch of [{amount_untaxed:"100"},{amount_tax:undefined},{amount_total:NaN},{amount_total:117},
    {amount_untaxed:100.001},{amount_untaxed:1e20},{amount_tax:Infinity}])
    assert.throws(()=>summary([{...row,...patch}]));
  const huge={...row,amount_untaxed:60000000000000,amount_tax:0,amount_total:60000000000000};
  assert.throws(()=>summary([huge,{...huge,id:2}]));
});
test("separate currencies and metadata, never implicit currency conversion",()=>{
  const d=summarizeUnitClose([row,{...row,id:2,currency_id:[3,"EUR"]}],
    [...currencies,{id:3,name:"EUR",decimal_places:2}],range);
  assert.equal(d.totals.length,2);assert.deepEqual(d.totals.map(t=>t.total),[116,116]);
  assert.throws(()=>summarizeUnitClose([row],[...currencies,...currencies],range));
  assert.throws(()=>summarizeUnitClose([row],[{id:2,name:"usd",decimal_places:2}],range));
});
test("empty period valid; invoice clients counted independently of credit-only clients",()=>{
  assert.deepEqual(summary([]).totals,[]);
  assert.equal(summary([row,{...refund(2,30),partner_id:[8,"Otro cliente QA"]}]).clientCount,1);
});
test("loader is read-only, fixed branch/company and date bounded with verified company",async()=>{
  const calls=[];
  const o={searchRead:async(model,domain,fields,options)=>{
    calls.push({model,domain,fields,options});return model==="account.move"?[row]:currencies;
  }};
  assert.equal((await loadUnitClose(o,range,[{id:12}])).invoiceCount,1);
  assert.deepEqual(calls[0].domain.slice(0,3),[["company_id","=",12],["branch_id","=",41],["state","=","posted"]]);
  assert.ok(calls[0].domain.some(d=>d[0]==="invoice_date"&&d[2]==="2026-10-31"));
  assert.deepEqual(calls[0].options.context.allowed_company_ids,[12]);
  await assert.rejects(loadUnitClose(o,range,[{id:1}]));
});
test("current month range is enforced again on returned moves",async()=>{
  const o={searchRead:async(model)=>model==="account.move"?[{...row,invoice_date:"2026-11-07"}]:currencies};
  await assert.rejects(loadUnitClose(o,{from:"2026-11-01",until:"2026-11-06"},[{id:12}]));
});
