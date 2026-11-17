import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { createPackagePdf } from "./baifa-sales-documents.js";
import { validateQuote } from "./baifa-sales-rules.js";

const base = { companyName: "CLIENTE QA", city: "Barcelona", state: "Anzoátegui", applyTax: false,
  conditions: "Garantía 18 meses o 1.200 horas\n\nIncluye traslado", complements: "Cargador de batería",
  items: [{ productId: "7", concepto: "Generador BF-C220S-60 250 kVA", qty: 1, precio: 1000 },
    { concepto: "Instalación", qty: 1, precio: 500, serviceItem: true, detalle: "Paso A\nPaso B\nPaso A\n  \nPaso C" },
    { concepto: "ATS incluido", qty: 1, precio: 0, serviceItem: true }], total: 1500 };

test("quote keeps conditions, complements, location and deduplicated annex steps", () => {
  const q = validateQuote(base);
  assert.deepEqual(q.conditions, ["Garantía 18 meses o 1.200 horas", "Incluye traslado"]);
  assert.deepEqual(q.complements, ["Cargador de batería"]);
  assert.equal(q.city, "Barcelona"); assert.equal(q.state, "Anzoátegui");
  assert.deepEqual(q.items[1].detalle, ["Paso A", "Paso B", "Paso C"]);
  assert.equal(q.items[1].serviceItem, true);
});

test("quote text inputs are bounded", () => {
  const q = validateQuote({ ...base, conditions: Array.from({ length: 50 }, (_, i) => `c${i}`).join("\n"),
    items: [{ ...base.items[0] }, { ...base.items[1], detalle: Array.from({ length: 90 }, (_, i) => `p${i} ${"x".repeat(400)}`).join("\n") }, base.items[2]] });
  assert.equal(q.conditions.length, 20);
  assert.equal(q.items[1].detalle.length, 40);
  assert.ok(q.items[1].detalle.every(s => s.length <= 300));
});

test("package PDF: quotation, one annex page and payment plan share the proforma number", async () => {
  const q = validateQuote(base);
  const pdf = await PDFDocument.load(await createPackagePdf(q, { mode: "contado" }, [], "FLASH-QA-1", "2026-11-17T10:00:00Z", { preparedBy: "Vendedor QA" }));
  assert.equal(pdf.getPageCount(), 3);
  assert.match(pdf.getTitle(), /FLASH-QA-1/);
});

test("annex is omitted when no line carries execution detail", async () => {
  const q = validateQuote({ ...base, items: base.items.map(({ detalle, ...i }) => i) });
  const pdf = await PDFDocument.load(await createPackagePdf(q, { mode: "contado" }, [], "FLASH-QA-2", "2026-11-17T10:00:00Z"));
  assert.equal(pdf.getPageCount(), 2);
});

test("validateQuote caps raw multiline text before splitting", () => {
  const huge = "\n".repeat(2_000_000) + "tarde";
  const q = validateQuote({ ...base, conditions: huge, complements: huge,
    items: [{ ...base.items[0] }, { ...base.items[1], detalle: huge }, base.items[2]] });
  assert.deepEqual(q.conditions, []);
  assert.deepEqual(q.complements, []);
  assert.deepEqual(q.items[1].detalle, []);
});
