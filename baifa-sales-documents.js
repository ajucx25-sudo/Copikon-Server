import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { isAdministrator, permissionList } from "./secure-access.js";
import { registerFlashWorkflow } from "./flash-quote-workflow.js";
import {assessFinancing,requireApproval,financeRows,financeName} from "./financing-authorization.js";
import { isGenerator, financingSchedule, validateQuote } from "./baifa-sales-rules.js";

export const SALES_DOCUMENTS_PATH = "/api/generators/sales-documents";
const MAX_PDF = 10 * 1024 * 1024;
// Official Copikon Generators letterhead supplied by Copikon for printed quotations.
const LETTERHEAD_PNG = readFileSync(new URL("./assets/copikon-generators-membrete.png", import.meta.url));
// Brand strip (BAIFA, Stamford, redes) and slogan band taken from Copikon's quotation format.
const BRANDS_PNG = readFileSync(new URL("./assets/copikon-generators-marcas.png", import.meta.url));
const SLOGAN_PNG = readFileSync(new URL("./assets/copikon-generators-eslogan.png", import.meta.url));
const UUID = /^[a-f0-9-]{36}$/i;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
export const canUseSalesDocuments = user => !!user && !user.isPartner && !user.isExternal && !user.isExternalProvider && user.providerId==null && !["partner_externo","tecnico_externo"].includes(user.level) &&
  (isAdministrator(user) || permissionList(user.moduleAccess).includes("generators-ventas"));
const publicMeta = ({ dataBase64, quote, plan, flashOwnerId, ...meta }) => meta;
// Reversible history-only retirement of the 12 reviewed legacy packages.
// No client details, payload changes, date cutoff or download-route changes.
const retiredLegacyPackageDigests = `
e87380030d119f870fc93a89e762d26fa0d36b0d186ba7220117df6ef64da03e
0011dad5d8e2a09314cc0bc8fb0edb096b861e768c32c63da4102739c19b80bc
c873b85abaac304d7f1ed71ad28b55f19e6e92b3da52fc7865fef7d229b175d5
6cef31e51c0f511f05a5d6a5cb3b2f6de39ae99e6dfbf4ccf5cd0d7f05f1a0cc
c1572d59de1b4ab923e776db174db70117132d64d3ea2df329c13eb2c0f5138e
422a690c3a4d778587dd4d43c7dcec7a7d0ef6d2823556e61e71c73328a6193d
b6520f1c91004b2277e640ce1d8bf01e1d6a80da0ccce2f304b04bc4279b26f7
5debd427abdea1576e8c1a388216d4f792741367a91b22f49a4235fbc638136d
603b6a0566c52e404c45eee35a56795f123c91262673d846dcc1b40861ef414a
7d83be72df6962d0ab17e5daad2c9e121b98b5d2cac1b19c9fd838d1aa589ddd
c53f46ffa512d0fe30e6d00c73ff726058fc0b972a65d35b95d843f82d73dc11
addff5a2964f1ac05e5c213c27fd9b1f4dc69161f012a96f26f81222cb2ad003
`.trim().split(/\s+/);

const ACTIVE_PDF_NAMES = new Set(["A", "AA", "OpenAction", "JavaScript", "JS", "Launch",
  "RichMedia", "EmbeddedFiles", "EmbeddedFile", "AcroForm", "XFA", "SubmitForm",
  "ImportData", "GoToR", "GoToE", "Rendition", "SetOCGState"]);
function containsActivePdfObjects(context) {
  const pending = context.enumerateIndirectObjects().map(([, object]) => object);
  const seen = new Set();
  while (pending.length) {
    const object = pending.pop();
    if (!object || seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFName) {
      if (ACTIVE_PDF_NAMES.has(object.decodeText())) return true;
    } else if (object instanceof PDFRawStream) {
      // Inspect the stream dictionary, never compressed image/font/content bytes.
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) pending.push(key, value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) pending.push(value);
    }
    // Indirect references are covered by enumerateIndirectObjects. Strings and
    // binary stream data are not PDF names or executable object structure.
  }
  return false;
}

export async function cleanBrief(base64) {
  if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_PDF / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw error("PDF inválido o mayor a 10 MB.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PDF || bytes.subarray(0, 5).toString() !== "%PDF-") throw error("El archivo debe ser un PDF válido de hasta 10 MB.");
  let original;
  try { original = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
  catch { throw error("No se pudo leer el PDF. No se admiten archivos dañados o protegidos por contraseña."); }
  let pages;
  try { pages = original.getPageCount(); } catch { throw error("El PDF está dañado o incompleto."); }
  if (pages < 1 || pages > 60) throw error("El brief debe tener entre 1 y 60 páginas.");
  // Reject active content (including page/annotation actions) rather than relying on MIME.
  if (containsActivePdfObjects(original.context))
    throw error("El PDF contiene acciones o archivos incrustados. Exporta una copia PDF simple.");
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(original, original.getPageIndices());
  copied.forEach(page => doc.addPage(page));
  const result = Buffer.from(await doc.save());
  if (result.length > MAX_PDF) throw error("El PDF procesado excede 10 MB.");
  return { dataBase64: result.toString("base64"), size: result.length, pages };
}

export async function createPackagePdf(quote, plan, briefs, number, now, meta = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Cotización ${number} · Copikon Generators`);
  doc.setAuthor("Copikon Generators");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const ink = rgb(.07, .07, .08), gray = rgb(.36, .38, .42), light = rgb(.93, .93, .94), line = rgb(.78, .79, .81), red = rgb(.80, .09, .13);
  const letterhead = await doc.embedPng(LETTERHEAD_PNG);
  const brands = await doc.embedPng(BRANDS_PNG);
  const slogan = await doc.embedPng(SLOGAN_PNG);
  const logo = letterhead.scaleToFit(138, 91);
  const W = 595.28, H = 841.89, L = 40, R = 555, BOTTOM = 118;
  const pages = [];
  let page, y;
  const clean = value => [...String(value ?? "").replace(/[\r\t\n]/g, " ")].map(c => {
    try { font.encodeText(c); return c; } catch { return "?"; }
  }).join("").trim();
  const wrap = (value, f, size, width) => {
    const rows = []; let current = "";
    for (const word of clean(value).split(/\s+/).filter(Boolean)) {
      for (const part of word.match(/.{1,60}/g) || [""]) {
        const next = current ? `${current} ${part}` : part;
        if (current && f.widthOfTextAtSize(next, size) > width) { rows.push(current); current = part; }
        else current = next;
      }
    }
    if (current) rows.push(current);
    return rows.length ? rows : [""];
  };
  const text = (value, x, yy, size = 9, f = font, color = ink) => page.drawText(clean(value), { x, y: yy, size, font: f, color });
  const right = (value, x, yy, size = 9, f = font, color = ink) => text(value, x - f.widthOfTextAtSize(clean(value), size), yy, size, f, color);
  const center = (value, x1, x2, yy, size = 9, f = font, color = ink) => text(value, (x1 + x2 - f.widthOfTextAtSize(clean(value), size)) / 2, yy, size, f, color);
  const usd = c => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const ve = iso => /^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : clean(iso);
  const dateText = ve(now.slice(0, 10));
  const newPage = (title, sub) => {
    page = doc.addPage([W, H]); pages.push(page);
    page.drawImage(letterhead, { x: L, y: H - 28 - logo.height, width: logo.width, height: logo.height });
    right(title, R, H - 62, title.length > 14 ? 18 : 24, bold);
    page.drawRectangle({ x: R - 90, y: H - 74, width: 90, height: 2, color: red });
    right(`PROFORMA N° ${number}`, R, H - 86, 8.5, bold);
    right(`FECHA ${dateText}${sub ? `  ·  ${sub}` : ""}`, R, H - 98, 8, font, gray);
    y = H - 36 - logo.height;
    // Footer: value statement, brand strip and slogan band on every page.
    page.drawRectangle({ x: L, y: 76, width: R - L, height: 30, borderColor: ink, borderWidth: .6 });
    center("CADA GENERADOR QUE ENTREGAMOS REPRESENTA UNA DECISIÓN INTELIGENTE, PORQUE CUANDO ELIGES COPIKON GENERATORS, ELIGES", L, R, 94, 6.3, bold);
    center("TECNOLOGÍA DE ALTO DESEMPEÑO, RESPALDO TÉCNICO INMEDIATO Y ENERGÍA CONTINUA PARA CRECER SIN LÍMITES", L, R, 85, 6.3, bold);
    const bw = R - L - 30, bh = bw * brands.height / brands.width;
    page.drawImage(brands, { x: L + 15, y: 56, width: bw, height: bh });
    page.drawImage(slogan, { x: L, y: 36, width: R - L, height: (R - L) * slogan.height / slogan.width });
  };
  const ensure = (need, title, sub, after) => { if (y - need < BOTTOM) { newPage(title, sub); if (after) after(); } };
  const sectionTitle = (label, tt, sub) => {
    ensure(34, tt, sub); y -= 16; text(label, L, y, 9.5, bold); y -= 5;
    page.drawRectangle({ x: L, y, width: R - L, height: 1.2, color: red }); y -= 4;
  };
  const bullets = (items, tt, x1 = L, x2 = R) => items.forEach(item => wrap(item, font, 8.5, x2 - x1 - 12).forEach((row, i) => {
    ensure(13, tt); y -= 12.5;
    if (!i) page.drawRectangle({ x: x1 + 1, y: y + 2.5, width: 3, height: 3, color: red });
    text(row, x1 + 10, y, 8.5);
  }));

  // ── Página 1: cotización ─────────────────────────────────────────────
  const TT = "COTIZACIÓN";
  newPage(TT);
  // The letterhead already carries razón social, RIF, address and phones.
  y -= 4;
  page.drawRectangle({ x: L, y, width: R - L, height: .8, color: ink });
  const top = y - 14;
  let cy = top;
  text("PARA:", L, cy, 8, bold, red); cy -= 12;
  wrap(quote.companyName || quote.contactName, bold, 10, 290).slice(0, 3).forEach(row => { text(row, L, cy, 10, bold); cy -= 12.5; });
  const kv = (x, yy, k, v) => { text(`${k}:`, x, yy, 8, bold); text(wrap(v, font, 8.5, 175)[0], x + 62, yy, 8.5); };
  if (quote.companyRif) { kv(L, cy, "RIF / Cédula", quote.companyRif); cy -= 11; }
  if (quote.companyName && quote.contactName) { kv(L, cy, "Contacto", quote.contactName); cy -= 11; }
  if (quote.contactPhone) { kv(L, cy, "Teléfono", quote.contactPhone); cy -= 11; }
  if (quote.contactEmail) { kv(L, cy, "Correo", quote.contactEmail); cy -= 11; }
  let ry = top;
  for (const [k, v] of [["Ciudad", quote.city], ["Estado", quote.state], ["Válida hasta", quote.validUntil && ve(quote.validUntil)], ["Moneda", "USD"], ["Ref.", quote.number]])
    if (v) { kv(355, ry, k, v); ry -= 11; }
  y = Math.min(cy, ry) - 4;
  page.drawRectangle({ x: L, y, width: R - L, height: .8, color: ink }); y -= 8;

  // Items table
  const kvas = [...new Set(quote.items.filter(i => i.productId && !i.serviceItem)
    .map(i => (String(i.concepto).match(/(\d+(?:[.,]\d+)?)\s*kva/i) || [])[1]).filter(Boolean))];
  const tableTitle = kvas.length === 1 ? `GRUPO ELECTRÓGENO ${kvas[0]} KVA` : kvas.length > 1
    ? `GRUPOS ELECTRÓGENOS ${kvas.join(" KVA · ")} KVA` : "EQUIPOS Y SERVICIOS";
  const C = { desc: L + 6, qty: 360, price: 470, total: R - 6 };
  const annexOf = new Map(); quote.items.forEach((it, i) => { if (it.detalle?.length) annexOf.set(i, annexOf.size + 1); });
  const head = () => {
    page.drawRectangle({ x: L, y: y - 15, width: R - L, height: 15, color: ink });
    center(tableTitle, L, R, y - 11, 8.5, bold, rgb(1, 1, 1)); y -= 15;
    page.drawRectangle({ x: L, y: y - 15, width: R - L, height: 15, color: light });
    text("DESCRIPCIÓN", C.desc, y - 11, 7.5, bold); center("CANT.", C.qty - 30, C.qty + 30, y - 11, 7.5, bold);
    right("PRECIO", C.price, y - 11, 7.5, bold); right("TOTAL", C.total, y - 11, 7.5, bold); y -= 15;
  };
  head();
  quote.items.forEach((it, i) => {
    const strong = !!it.productId && !it.serviceItem;
    const name = it.serviceItem ? `Servicio: ${it.concepto}` : it.concepto;
    const label = annexOf.has(i) ? `${name} (ANEXO ${annexOf.get(i)})` : name;
    const rows = wrap(label, strong ? bold : font, 8.5, C.qty - 34 - C.desc);
    const h = rows.length * 10.5 + 8;
    const inlineSteps = !it.productId || it.serviceItem ? it.detalle || [] : [];
    if (y - h - (inlineSteps.length ? 30 : 0) < BOTTOM) { newPage(TT, "continuación"); head(); }
    const included = it.amount === 0;
    rows.forEach((row, r) => text(row, C.desc, y - 11 - r * 10.5, 8.5, strong ? bold : font));
    const my = y - 11;
    center(String(Number(it.qty).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })), C.qty - 30, C.qty + 30, my, 8.5);
    right(included ? "INCLUIDO" : usd(Math.round(it.precio * 100)), C.price, my, 8.5, included ? bold : font, included ? red : ink);
    right(included ? "INCLUIDO" : usd(it.amount), C.total, my, 8.5, bold, included ? red : ink);
    y -= h;
    if (inlineSteps.length) {
      text("Anexo de ejecución", C.desc + 7, y - 9, 8, bold, gray); y -= 14;
      inlineSteps.forEach((step, n) => {
        wrap(step, font, 8.5, R - C.desc - 38).forEach((row, r) => {
          if (y - 13 < BOTTOM) {
            newPage(TT, "continuación"); head();
            wrap(`${name} · Anexo ${annexOf.get(i)} (continuación)`, bold, 8.5, R - C.desc - 8)
              .forEach(s => { y -= 12; text(s, C.desc, y, 8.5, bold); });
            y -= 5;
          }
          if (!r) right(`${n + 1}.`, C.desc + 21, y - 9, 8, bold, gray);
          text(row, C.desc + 27, y - 9, 8.5); y -= 12;
        });
      });
      y -= 2;
    }
    page.drawRectangle({ x: L, y, width: R - L, height: .5, color: line });
  });

  // Totals (right) + conditions (left)
  const totals = [["SUBTOTAL", usd(quote.gross)]];
  if (quote.discountAmount) totals.push(["DESCUENTO", `- ${usd(quote.discountAmount)}`], ["BASE IMPONIBLE", usd(quote.subtotal)]);
  totals.push(quote.applyTax ? ["IVA 16%", usd(quote.tax)] : ["IVA", "NO INCLUYE"]);
  const conditions = [...(quote.conditions || [])];
  const leftRows = conditions.reduce((n, c) => n + wrap(c, font, 8.5, 250).length, 0);
  ensure(Math.max(totals.length * 15 + 30, leftRows * 12.5 + 30) + 10, TT, "continuación");
  y -= 8;
  const tx = 360, startY = y;
  let ty = y;
  totals.forEach(([k, v]) => { text(k, tx + 6, ty - 11, 8, bold, gray); right(v, R - 6, ty - 11, 8.5, k === "IVA" ? bold : font); ty -= 15;
    page.drawRectangle({ x: tx, y: ty, width: R - tx, height: .5, color: line }); });
  page.drawRectangle({ x: tx, y: ty - 22, width: R - tx, height: 22, color: ink });
  text("TOTAL USD", tx + 8, ty - 15, 10, bold, rgb(1, 1, 1)); right(usd(quote.total), R - 8, ty - 15, 11, bold, rgb(1, 1, 1));
  ty -= 22;
  if (!quote.applyTax) { right("Precios expresados sin IVA.", R, ty - 10, 7, font, gray); ty -= 10; }
  if (conditions.length) {
    text("CONDICIONES Y GARANTÍA", L, startY - 11, 9.5, bold); y = startY - 15;
    page.drawRectangle({ x: L, y, width: 300, height: 1.2, color: red }); y -= 2;
    bullets(conditions, TT, L, 340);
  }
  y = Math.min(y, ty) - 4;
  if (quote.complements?.length) { sectionTitle("COMPLEMENTOS", TT, "continuación"); bullets(quote.complements, TT); }
  if (quote.notes) {
    sectionTitle("OBSERVACIONES", TT, "continuación");
    wrap(quote.notes, font, 8.5, R - L).forEach(row => { ensure(13, TT, "continuación"); y -= 12.5; text(row, L, y, 8.5); });
  }
  if (briefs.length) {
    ensure(24, TT, "continuación"); y -= 18;
    wrap(`Fichas técnicas anexas: ${briefs.map(b => b.sku).join(", ")}.`, font, 7.5, R - L).forEach(row => { text(row, L, y, 7.5, font, gray); y -= 10; });
  }
  ensure(64, TT, "continuación");
  y -= 46;
  for (const [x1, x2, title, sub] of [[L, 280, "Elaborado por", meta.preparedBy || "Copikon Generators"], [315, R, "Aceptado por el cliente", "Nombre, firma y fecha"]]) {
    page.drawRectangle({ x: x1, y, width: x2 - x1, height: .8, color: ink });
    center(title, x1, x2, y - 11, 8.5, bold); center(sub, x1, x2, y - 22, 7.5, font, gray);
  }

  // ── Anexos ───────────────────────────────────────────────────────────
  quote.items.forEach((it, i) => {
    if (!annexOf.has(i)) return;
    const AT = `ANEXO ${annexOf.get(i)}`;
    newPage(AT);
    const ahead = () => {
      y -= 14;
      wrap(`${it.serviceItem ? "SERVICIO: " : ""}${it.concepto}`.toUpperCase(), bold, 10, R - L).forEach(row => { center(row, L, R, y, 10, bold); y -= 13; });
      y -= 8;
      page.drawRectangle({ x: L, y: y - 15, width: R - L, height: 15, color: ink });
      center("DETALLE DE EJECUCIÓN", L + 26, R, y - 11, 8, bold, rgb(1, 1, 1)); text("N°", L + 7, y - 11, 8, bold, rgb(1, 1, 1)); y -= 15;
    };
    ahead();
    it.detalle.forEach((step, n) => {
      const rows = wrap(step, font, 8.5, R - L - 40);
      const h = rows.length * 10.5 + 7;
      if (y - h < BOTTOM) { newPage(AT, "continuación"); ahead(); }
      center(String(n + 1), L, L + 24, y - 11, 8.5, bold);
      rows.forEach((row, r) => text(row, L + 32, y - 11 - r * 10.5, 8.5));
      y -= h;
      page.drawRectangle({ x: L, y, width: R - L, height: .5, color: line });
      page.drawRectangle({ x: L + 24, y, width: .5, height: h, color: line });
    });
  });

  // ── Plan de pagos ───────────────────────────────────────────────────
  const schedule = financingSchedule(quote.total / 100, plan);
  const PT = "PLAN DE PAGOS";
  newPage(PT);
  const models = quote.items.filter(i => i.productId && !i.serviceItem).map(i => clean(i.concepto).split(/\s+/).find(w => /^[A-Z]{2}-[A-Z0-9-]+$/i.test(w))).filter(Boolean);
  y -= 10;
  text("PLAN GENERATORS", L, y, 13, bold);
  if (models.length) right([...new Set(models)].join(" · "), R, y, 11, bold, gray);
  y -= 14; text(clean(quote.companyName || quote.contactName), L, y, 9, font, gray);
  y -= 22; center("ESTRUCTURA DE PAGOS", L, R, y, 10, bold); y -= 10;
  const amort = schedule.method === "amortizacion_mensual";
  const P = amort
    ? [["CRONOGRAMA", L + 6, "l"], ["FECHA", 150, "l"], ["CAPITAL", 278, "r"], ["INTERÉS", 350, "r"], ["MONTO", 432, "r"], ["%", 470, "r"], ["SALDO", R - 6, "r"]]
    : [["CRONOGRAMA", L + 6, "l"], ["FECHA", 170, "l"], ["MONTO", 330, "r"], ["%", 390, "r"], ["OBSERVACIONES", 410, "l"]];
  const phead = () => {
    page.drawRectangle({ x: L, y: y - 17, width: R - L, height: 17, color: ink });
    P.forEach(([k, x, a]) => (a === "r" ? right : text)(k, x, y - 12, 7.5, bold, rgb(1, 1, 1))); y -= 17;
  };
  const pct = c => `${(c * 100 / schedule.payable).toFixed(c * 100 % schedule.payable ? 1 : 0)}%`;
  const prow = (cells, strong = false, shade = false) => {
    if (y - 16 < BOTTOM) { newPage(PT, "continuación"); phead(); }
    if (shade) page.drawRectangle({ x: L, y: y - 16, width: R - L, height: 16, color: light });
    cells.forEach((v, idx) => { if (v == null || v === "") return; const [, x, a] = P[idx]; (a === "r" ? right : text)(v, x, y - 11.5, 8.5, strong ? bold : font); });
    y -= 16; page.drawRectangle({ x: L, y, width: R - L, height: .5, color: line });
  };
  phead();
  const totalRow = amort ? ["Precio (proforma)", "", "", "", usd(quote.total), "", ""] : ["Precio (proforma)", "", usd(quote.total), "", ""];
  prow(totalRow, true, true);
  if (plan.mode === "contado") prow(["Pago único", dateText, usd(schedule.payable), "100%", "Contado, contra orden de compra"]);
  else {
    if (schedule.initial > 0) prow(amort ? ["Inicial", dateText, "", "", usd(schedule.initial), pct(schedule.initial), usd(schedule.principal)]
      : ["Inicial", dateText, usd(schedule.initial), pct(schedule.initial), "Reserva del equipo"], true);
    schedule.payments.forEach(p => prow(amort
      ? [`Cuota ${p.number}`, ve(p.date), usd(p.capital), usd(p.interest), usd(p.amount), pct(p.amount), usd(p.balance)]
      : [`Cuota ${p.number}`, ve(p.date), usd(p.amount), pct(p.amount), ""]));
    prow(amort ? ["Total a pagar", "", usd(schedule.principal), usd(schedule.interest), usd(schedule.payable), "100%", ""]
      : ["Total a pagar", "", usd(schedule.payable), "100%", schedule.surcharge ? `Incluye recargo ${usd(schedule.surcharge)}` : ""], true, true);
  }
  const obs = plan.mode === "contado" ? ["Pago completo de la proforma; no aplica financiamiento."]
    : amort ? [
      ...(plan.initialPct!=null?[`Inicial: ${Number(plan.initialPct)}% del total de la proforma (${usd(schedule.initial)}).`]:[]),
      `Las cuotas serán ejecutadas a través de pagos mensuales (${schedule.payments.length} meses). Cuota mensual: ${usd(schedule.installment)}.`,
      "Tasa nominal anual fija 24% (2% mensual sobre saldo pendiente). La inicial no genera intereses.",
      "Fórmula: cuota = capital x 0,02 / (1 - 1,02^(-n)); interés del mes = saldo x 2%. La última cuota liquida el saldo exacto (ajuste de centavos).",
      "Propuesta sujeta a evaluación y aprobación comercial. Este documento no constituye aprobación de crédito."]
    : ["Saldo = total - inicial; cuotas = (saldo + recargo fijo) / número de cuotas. El ajuste de centavos se aplica a la última cuota.",
      `Periodicidad: ${clean(plan.frequency)}. Condiciones sujetas a revisión y aprobación comercial.`];
  sectionTitle("OBSERVACIONES", PT, "continuación");
  bullets(obs, PT);

  const total = pages.length;
  pages.forEach((p, i) => { const s = `Página ${i + 1} de ${total}`; p.drawText(s, { x: R - font.widthOfTextAtSize(s, 7), y: 22, size: 7, font, color: gray }); });
  for (const brief of briefs) {
    const source = await PDFDocument.load(Buffer.from(brief.dataBase64, "base64"));
    const copied = await doc.copyPages(source, source.getPageIndices());
    copied.forEach(p => doc.addPage(p));
  }
  return Buffer.from(await doc.save());
}

export function runPdfWorker(task, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./baifa-sales-pdf-worker.js", import.meta.url), {
      workerData: { task, args }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    const timer = setTimeout(() => { worker.terminate(); reject(error("El PDF excede el tiempo de procesamiento. Exporta una versión más simple.", 422)); }, 20000);
    worker.once("message", result => {
      clearTimeout(timer);
      if (result.error) reject(error(result.error, result.status || 400));
      else resolve(task === "package" ? Buffer.from(result.value) : result.value);
    });
    worker.once("error", () => { clearTimeout(timer); reject(error("El PDF excede los recursos permitidos o está dañado.", 422)); });
    worker.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(error("No se pudo procesar este PDF.", 422)); });
  });
}

export function registerSalesDocumentRoutes(app, { sessions, pool, readCol, readInventory }) {
  const router = express.Router();
  let working = 0;
  router.use(async (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    try {
      const user = await sessions.authenticate(req);
      if (!user) return res.status(401).json({ message: "Inicia sesión para acceder a los documentos." });
      if (!canUseSalesDocuments(user)) return res.status(403).json({ message: "Requiere acceso a Ventas de Generators." });
      req.salesUser = user; next();
    } catch { res.status(503).json({ message: "No se pudo verificar la sesión." }); }
  });
  router.use(express.json({ limit: "14mb" }));
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : "No se pudo procesar el documento. Intenta nuevamente." }); }
  };
  // Sales needs inventory membership, not the inventory module's PO/invoice detail.
  const readFinanceRows=async req=>{
    try{return await (req.financeRowsPromise??=Promise.resolve().then(()=>readInventory()).then(financeRows));}
    catch{throw error("No se pudo verificar el inventario de Odoo para el financiamiento.",503);}
  };
  const savePackageDraft=registerFlashWorkflow(router,{pool,handle,readCol,readFinanceRows});
  // Same live reader as Inventario; no writes, brand inference or catalog fallback.
  router.get("/quote-inventory", handle(async (req, res) => {
    if (Object.keys(req.query).length) throw error("Parámetros no permitidos.");
    try {
      const snapshot = await readInventory();
      if (snapshot?.ok !== true || snapshot.schemaVersion !== 1 || snapshot.complete !== true || snapshot.source !== "odoo-po-invoices" ||
          !Array.isArray(snapshot.rows) || !Number.isFinite(Date.parse(snapshot.observedAt)))
        throw Error("Incomplete inventory");
      const codes = new Set();
      const rows = snapshot.rows.map(row => {
        if (typeof row.code !== "string" || !row.code.trim() || codes.has(row.code) ||
            ![row.available, row.pending].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0))
          throw Error("Invalid inventory row");
        codes.add(row.code);
        return { code: row.code, available: row.available, pending: row.pending,...(financeName(row)?{financeName:financeName(row)}:{}) };
      }).filter(row => row.available > 0 || row.pending > 0);
      res.json({ ok: true, schemaVersion: 1, source: "generators-inventory", complete: true,
        observedAt: snapshot.observedAt, rows });
    } catch {
      throw error("No se pudo verificar el inventario. Reintenta antes de agregar productos.", 502);
    }
  }));
  const save = async (key, value, beforeInsert=null) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(193001)");
      const { rows } = await client.query(`SELECT
        COALESCE(SUM((value->>'size')::bigint),0) AS bytes,
        COUNT(*) FILTER (WHERE value->>'createdBy'=$1 AND updated_at>$2) AS daily
        FROM kv WHERE key LIKE 'baifa.sales.%'`, [String(value.createdBy), Date.now() - 86400000]);
      if (Number(rows[0]?.bytes || 0) + value.size > 1024 * 1024 * 1024 ||
          Number(rows[0]?.daily || 0) >= 100) throw error("Se alcanzó el límite de documentos (100 al día por usuario / 1 GB total). Contacta al administrador.", 429);
      if(beforeInsert)await beforeInsert(client);
      await client.query("INSERT INTO kv(key,value,updated_at) VALUES($1,$2::jsonb,$3)", [key, JSON.stringify(value), Date.now()]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  };
  const load = async (kind, id) => {
    if (!UUID.test(id || "")) throw error("Documento no encontrado.", 404);
    const result = await pool.query("SELECT value FROM kv WHERE key=$1", [`baifa.sales.${kind}:${id}`]);
    if (!result.rows[0]) throw error("Documento no encontrado.", 404);
    return result.rows[0].value;
  };
  for (const [route, kind] of [["briefs", "brief"], ["packages", "package"]]) {
    router.get(`/${route}`, handle(async (req, res) => {
      const params=[`baifa.sales.${kind}:%`,String(req.salesUser.id),isAdministrator(req.salesUser)];
      const historyFilter=kind==="package"?" AND (value ? 'flashQuoteId' OR NOT (encode(sha256(convert_to(coalesce(value->>'number',''),'UTF8')),'hex') = ANY($4::text[])))":"";
      if(kind==="package")params.push(retiredLegacyPackageDigests);
      const rows = await pool.query("SELECT value - 'dataBase64' - 'quote' - 'plan' AS value FROM kv WHERE key LIKE $1 AND (NOT (value ? 'flashQuoteId' OR value ? 'flashOwnerId') OR value->>'flashOwnerId'=$2 OR $3)"+historyFilter+" ORDER BY updated_at DESC LIMIT 500", params);
      res.json(rows.rows.map(r => publicMeta(r.value)));
    }));
    router.get(`/${route}/:id/download`, handle(async (req, res) => {
      const value = await load(kind, req.params.id);
      if((value.flashQuoteId!=null||value.flashOwnerId!=null)&&String(value.flashOwnerId)!==String(req.salesUser.id)&&!isAdministrator(req.salesUser))throw error("Documento no encontrado.",404);
      res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${encodeURIComponent(value.filename)}"`, "Content-Security-Policy": "sandbox" });
      res.send(Buffer.from(value.dataBase64, "base64"));
    }));
  }
  const expensive = fn => handle(async (req, res) => {
    if (working >= 2) throw error("Hay documentos en proceso. Intenta nuevamente en unos segundos.", 429);
    working++;
    try { await fn(req, res); } finally { working--; }
  });
  router.post("/briefs", expensive(async (req, res) => {
    const { productId, filename, dataBase64 } = req.body || {};
    if (typeof filename !== "string" || !/\.pdf$/i.test(filename) || filename.length > 180) throw error("Selecciona un archivo .pdf.");
    const products = await readCol("erpProducts");
    const product = products.find(p => String(p.id) === String(productId));
    if (!product || !isGenerator(product)) throw error("Selecciona un grupo electrógeno BAIFA del catálogo.");
    const sku = String(product.code || product.sku || "").trim();
    if (!sku) throw error("El equipo necesita un código de catálogo.");
    const pdf = await runPdfWorker("brief", [dataBase64]);
    const doc = { id: randomUUID(), productId: String(product.id), sku, productName: String(product.name || "").slice(0, 300),
      filename: filename.replace(/[\/\\\x00-\x1f\x7f"]/g, "_"), ...pdf, createdAt: new Date().toISOString(), createdBy: req.salesUser.id };
    await save(`baifa.sales.brief:${doc.id}`, doc);
    res.status(201).json(publicMeta(doc));
  }));
  router.post("/packages", expensive(async (req, res) => {
    const quote = validateQuote(req.body?.quote);
    const inputPlan = req.body?.plan;
    const plan = inputPlan?.mode === "contado" ? { mode: "contado" } : {
      mode: inputPlan?.mode, initial: inputPlan?.initial, surcharge: inputPlan?.surcharge,
      count: inputPlan?.count, frequency: inputPlan?.frequency, firstDate: inputPlan?.firstDate,
      method: inputPlan?.method, annualRate: inputPlan?.annualRate,
      initialPct: inputPlan?.initialPct, customTerms:inputPlan?.customTerms==="yes"?"yes":"no",
    };
    const checkedPlan = financingSchedule(quote.total / 100, plan);
    if (plan.mode === "financiado") {
      plan.initial = checkedPlan.initial / 100;
      plan.surcharge = checkedPlan.surcharge / 100;
      plan.count = Number(plan.count);
      plan.frequency = String(plan.frequency);
      plan.firstDate = String(plan.firstDate);
      if (checkedPlan.method === "amortizacion_mensual") plan.annualRate = checkedPlan.annualRate;
      else delete plan.annualRate;
    }
    const ids = req.body?.briefIds;
    // Briefs are optional: a model without a loaded brief still gets proforma + plan.
    if (!Array.isArray(ids) || ids.length > 15 || ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw error("Selecciona hasta 15 briefs distintos.");
    const briefs = await Promise.all(ids.map(id => load("brief", id)));
    if (briefs.reduce((s, b) => s + b.size, 0) > 25 * 1024 * 1024 || briefs.reduce((s, b) => s + b.pages, 0) > 180)
      throw error("Los briefs juntos exceden 25 MB o 180 páginas. Divide la cotización.");
    const products = await readCol("erpProducts");
    const quoted = products.filter(p => isGenerator(p) && quote.items.some(i => i.productId === String(p.id)));
    const review=assessFinancing(req.body.quote,plan,products,plan.mode==="financiado"?await readFinanceRows(req):[]);
    if(review?.exception){
      const id=req.body.workflow?.id;
      if(!Number.isSafeInteger(id)||id<1)requireApproval(review,null);
      const r=await pool.query("SELECT snapshot FROM sales_flash_quotes WHERE id=$1 AND (owner_id=$2 OR $3)",[id,String(req.salesUser.id),isAdministrator(req.salesUser)]);
      requireApproval(review,r.rows[0]?.snapshot?.financeApproval);
    }
    if (!quoted.length) throw error("Agrega al menos un grupo electrógeno del catálogo a la cotización.");
    if (briefs.some(b => !quoted.some(p => b.productId === String(p.id))) ||
        new Set(briefs.map(b => b.productId)).size !== briefs.length) throw error("Incluye como máximo un brief por modelo cotizado.");
    const id = randomUUID(), now = new Date().toISOString();
    const number = `FLASH-${now.slice(0, 10).replaceAll("-", "")}-${id.slice(0, 8).toUpperCase()}`;
    const preparedBy = String(req.salesUser.name || req.salesUser.fullName || "Copikon Generators").slice(0, 120);
    const bytes = await runPdfWorker("package", [quote, plan, briefs, number, now, { preparedBy }]);
    if (bytes.length > 30 * 1024 * 1024) throw error("La cotización excede 30 MB.");
    const record = { id, number, filename: `${number}.pdf`, companyName: quote.companyName || quote.contactName, total: quote.total / 100,
      createdAt: now, createdBy: req.salesUser.id, briefIds: ids, quote, plan, size: bytes.length, dataBase64: bytes.toString("base64") };
    const link=req.body.workflow;
    if(quote.companyRif)record.flashOwnerId=req.salesUser.id;
    if(link!=null&&(typeof link!=="object"||Array.isArray(link)))throw error("Vínculo de borrador inválido.");
    await save(`baifa.sales.package:${id}`, record,link==null?null:async db=>{
      const choices=Object.fromEntries(quoted.map(p=>[String(p.id),briefs.find(b=>b.productId===String(p.id))?.id||""]));
      const draft=await savePackageDraft(req,db,link,JSON.stringify({plan,choices}));
      record.flashQuoteId=draft.id;record.flashQuoteVersion=draft.version;record.flashOwnerId=draft.createdBy;
    });
    res.status(201).json(publicMeta(record));
  }));
  router.use((err, _req, res, _next) => res.status(err.status === 413 ? 413 : 400).json({ message: "Solicitud inválida o demasiado grande (máximo 10 MB por PDF)." }));
  app.use(SALES_DOCUMENTS_PATH, router);
}
