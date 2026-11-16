import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { canUseSalesDocuments, cleanBrief, createPackagePdf, registerSalesDocumentRoutes, SALES_DOCUMENTS_PATH } from "./baifa-sales-documents.js";
import { financingSchedule, validateQuote, isGenerator } from "./baifa-sales-rules.js";

const product = { id: 19301, code: "TRPE-QA", brand: "Baifa", name: "Generador QA" };
const rawQuote = { companyName: "Cliente de prueba", items: [{ productId: product.id, concepto: "Generador de prueba", qty: 2, precio: 1000 }], applyTax: true, total: 2320 };
const plan = { mode: "financiado", initial: 500, surcharge: 25, count: 3, frequency: "mensual", firstDate: "2028-01-31" };
async function fixture() { const d = await PDFDocument.create(); d.addPage().drawText("BRIEF DE PRUEBA"); return Buffer.from(await d.save()).toString("base64"); }
test("permission requires internal sales, excludes partners even if admin", () => {
  for (const u of [null, {}, { level: "coordinador" }, { moduleAccess: ["generators-inventario"] }, { username: "admin", isPartner: true }, { level: "partner_externo", moduleAccess: ["generators-ventas"] }]) assert.equal(canUseSalesDocuments(u), false);
  for (const u of [{ username: "admin" }, { level: "ceo" }, { moduleAccess: '["generators-ventas"]' }]) assert.equal(canUseSalesDocuments(u), true);
});
test("generator classification excludes spare parts", () => {
  assert.equal(isGenerator(product), true);
  assert.equal(isGenerator({ brand: "Baifa", name: "Filtro aceite" }), false);
});
test("quote totals include tax and explicit discount", () => {
  assert.equal(validateQuote(rawQuote).total, 232000);
  assert.equal(validateQuote({ ...rawQuote, globalDiscountPct: 10, total: 2088 }).total, 208800);
  assert.equal(validateQuote({ ...rawQuote, applyTax: false, total: 2000 }).total, 200000);
});
test("quote rejects missing client, invalid lines, mismatching totals", () => {
  for (const q of [{ ...rawQuote, companyName: "" }, { ...rawQuote, items: [] }, { ...rawQuote, total: "invalid" }, { ...rawQuote, total: 3 }, { ...rawQuote, globalDiscountPct: 200 }, { ...rawQuote, items: [{ qty: -1, precio: 1, concepto: "x" }] }])
    assert.throws(() => validateQuote(q));
});
test("schedule conserves cents and monthly end-of-month anchor", () => {
  const s = financingSchedule(2320, plan);
  assert.equal(s.initial + s.payments.reduce((sum, p) => sum + p.amount, 0), s.payable);
  assert.deepEqual(s.payments.map(p => p.date), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  assert.deepEqual(s.payments.map(p => p.amount), [61500, 61500, 61500]);
  const rounded = financingSchedule(100, { ...plan, initial: 0, surcharge: 0 });
  assert.deepEqual(rounded.payments.map(p => p.amount), [3333, 3333, 3334]);
});
test("weekly, 15-day and cash modes", () => {
  assert.equal(financingSchedule(100, { ...plan, initial: 0, frequency: "semanal" }).payments[1].date, "2028-02-07");
  assert.equal(financingSchedule(100, { ...plan, initial: 0, frequency: "quincenal" }).payments[1].date, "2028-02-15");
  assert.deepEqual(financingSchedule(100, { mode: "contado" }), { initial: 10000, principal: 0, surcharge: 0, payable: 10000, payments: [] });
});
test("invalid finance input fails closed", () => {
  for (const patch of [{ initial: "" }, { initial: -1 }, { initial: 2320 }, { surcharge: "" }, { surcharge: Infinity }, { count: 0 }, { count: 2.5 }, { count: 61 }, { firstDate: "0001-01-01" }, { firstDate: "2028-02-30" }, { frequency: "daily" }, { mode: "" }])
    assert.throws(() => financingSchedule(2320, { ...plan, ...patch }));
});
test("PDF validated, invalid/header-only/active/oversized rejected", async () => {
  assert.equal((await cleanBrief(await fixture())).pages, 1);
  for (const value of ["not a pdf", Buffer.from("%PDF-broken").toString("base64"), "A".repeat(14 * 1024 * 1024)]) await assert.rejects(() => cleanBrief(value));
  const active = await PDFDocument.create(); active.addPage();
  active.catalog.set(PDFName.of("OpenAction"), active.context.obj({ S: "JavaScript", JS: "app.alert(1)" }));
  const activeBytes = Buffer.from(await active.save()).toString("base64");
  await assert.rejects(() => cleanBrief(activeBytes));
  for (const subtype of ["URI", "GoToE", "Rendition", "SetOCGState"]) {
    const actionPdf = await PDFDocument.create(); const p = actionPdf.addPage();
    p.node.set(PDFName.of("A"), actionPdf.context.obj({ S: subtype, URI: "https://example.invalid" }));
    const b = Buffer.from(await actionPdf.save()).toString("base64");
    await assert.rejects(() => cleanBrief(b));
  }
  const many = await PDFDocument.create(); for (let i = 0; i < 61; i++) many.addPage();
  const manyBytes = Buffer.from(await many.save()).toString("base64");
  await assert.rejects(() => cleanBrief(manyBytes));
});
test("single PDF contains proforma, plan and brief in sequence", async () => {
  const bytes = await createPackagePdf(validateQuote(rawQuote), plan, [{ ...(await cleanBrief(await fixture())), sku: product.code, productName: product.name, filename: "brief.pdf" }], "FLASH-QA", "2026-11-14");
  const result = await PDFDocument.load(bytes);
  assert.equal(result.getPageCount(), 3);
  assert.match(result.getTitle(), /FLASH-QA/);
});
test("PDF binary streams and text containing action-like bytes are not executable actions", async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage();
  const stream = pdf.context.stream(Buffer.from("q\n% /A /JavaScript /EmbeddedFile are inert comment bytes\nQ\n"));
  page.node.set(PDFName.of("Contents"), pdf.context.register(stream));
  pdf.catalog.set(PDFName.of("Description"), PDFString.of("Description /A /OpenAction"));
  const raw = Buffer.from(await pdf.save()).toString("base64");
  assert.equal((await cleanBrief(raw)).pages, 1);
});
test("nested direct/indirect, encoded and stream dictionary actions stay blocked", async () => {
  for (const mode of ["direct", "indirect", "encoded", "stream", "embedded"]) {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const action = pdf.context.obj({S: "JavaScript", JS: PDFString.of("app.alert(1)")});
    if (mode === "direct") pdf.catalog.set(PDFName.of("Nested"),pdf.context.obj([{A: action}]));
    if (mode === "indirect") pdf.catalog.set(PDFName.of("Nested"),pdf.context.register(action));
    if (mode === "encoded") pdf.catalog.set(PDFName.of("#41"),action);
    if (mode === "stream") pdf.catalog.set(PDFName.of("Nested"),pdf.context.register(pdf.context.stream("safe",{AA: action})));
    if (mode === "embedded") pdf.catalog.set(PDFName.of("Nested"),pdf.context.register(pdf.context.stream("safe",{Type: "EmbeddedFile"})));
    const raw = Buffer.from(await pdf.save()).toString("base64");
    await assert.rejects(()=>cleanBrief(raw),/acciones o archivos incrustados/,mode);
  }
});
test("escaped action names alone are rejected with and without object streams", async () => {
  for (const useObjectStreams of [true, false]) {
    for (const encodedKey of [true, false]) {
      const pdf = await PDFDocument.create(); pdf.addPage();
      pdf.catalog.set(PDFName.of(encodedKey ? "#41" : "Nested"),
        encodedKey ? PDFString.of("plain text") : PDFName.of("Java#53cript"));
      const raw = Buffer.from(await pdf.save({useObjectStreams})).toString("base64");
      await assert.rejects(()=>cleanBrief(raw),/acciones o archivos incrustados/);
    }
  }
});
test("authenticated API stores immutable documents and excludes private payload from lists", async () => {
  const store = new Map(), calls = [];
  const pool = { connect: async () => ({ query: pool.query, release() {} }), query: async (sql, params) => {
    calls.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql)) return { rows: [] };
    if (sql.includes("AS bytes")) return { rows: [{ bytes: 0, daily: 0 }] };
    if (sql.startsWith("INSERT")) { assert.ok(!store.has(params[0])); store.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
    if (sql.includes("LIKE")) return { rows: [...store.entries()].filter(([k]) => k.startsWith(params[0].slice(0, -1))).map(([, value]) => ({ value })) };
    return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
  } };
  const app = express();
  registerSalesDocumentRoutes(app, { pool, readCol: async () => [product], sessions: { authenticate: async req => req.headers.authorization === "QA-sales" ? { id: 1, moduleAccess: ["generators-ventas"] } : req.headers.authorization === "QA-other" ? { id: 2 } : null } });
  const server = app.listen(0); await new Promise(resolve => server.once("listening", resolve));
  const root = `http://127.0.0.1:${server.address().port}${SALES_DOCUMENTS_PATH}`;
  const request = (path, body, auth = "QA-sales") => fetch(root + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await request("/briefs", undefined, "")).status, 401);
    assert.equal((await request("/packages", undefined, "QA-other")).status, 403);
    const valid = { productId: product.id, filename: "brief.pdf", dataBase64: await fixture() };
    assert.equal((await request("/briefs", { ...valid, productId: 999 })).status, 400);
    const saved = await request("/briefs", valid); assert.equal(saved.status, 201);
    const brief = await saved.json(); assert.equal(brief.dataBase64, undefined);
    const second = await (await request("/briefs", valid)).json(); assert.notEqual(second.id, brief.id);
    const listing = await (await request("/briefs")).json(); assert.equal(listing.length, 2); assert.equal(listing[0].dataBase64, undefined);
    assert.equal((await request(`/briefs/${brief.id}/download`, undefined, "")).status, 401);
    const pdf = await request(`/briefs/${brief.id}/download`); assert.equal(pdf.headers.get("cache-control"), "no-store"); assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal((await request("/packages", { quote: rawQuote, plan, briefIds: [] })).status, 400);
    assert.equal((await request("/packages", { quote: rawQuote, plan, briefIds: [brief.id, second.id] })).status, 400);
    const packed = await request("/packages", { quote: rawQuote, plan, briefIds: [brief.id] }); assert.equal(packed.status, 201);
    const record = await packed.json(); assert.equal(record.quote, undefined);
    const archive = await (await request("/packages")).json(); assert.equal(archive.length, 1); assert.equal(archive[0].plan, undefined);
    const one = Buffer.from(await (await request(`/packages/${record.id}/download`)).arrayBuffer());
    const two = Buffer.from(await (await request(`/packages/${record.id}/download`)).arrayBuffer());
    assert.deepEqual(one, two); assert.equal((await PDFDocument.load(one)).getPageCount(), 3);
    assert.equal(calls.filter(s => s.startsWith("INSERT")).length, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
