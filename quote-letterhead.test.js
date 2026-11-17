import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { createPackagePdf } from "./baifa-sales-documents.js";
import { validateQuote } from "./baifa-sales-rules.js";

test("flash quotation pages print the Copikon Generators letterhead", async () => {
  const q = validateQuote({ companyName: "QA MEMBRETE", items: [{ concepto: "Generador QA", qty: 1, precio: 1000 }], applyTax: false, total: 1000 });
  const pdf = await PDFDocument.load(await createPackagePdf(q, { mode: "contado" }, [], "QA-LOGO", "2026-11-17"));
  for (const page of pdf.getPages()) {
    const xobjects = page.node.Resources().lookup(PDFName.of("XObject"));
    assert.ok(xobjects && xobjects.keys().length >= 1, "each generated page embeds the letterhead image");
  }
});
